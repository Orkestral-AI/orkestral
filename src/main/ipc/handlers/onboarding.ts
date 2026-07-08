import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { broadcast } from '../../platform/host';
import { registerHandler } from '../register';
import { OnboardingRepository } from '../../db/repositories/onboarding.repo';
import { UserRepository } from '../../db/repositories/user.repo';
import { WorkspaceRepository } from '../../db/repositories/workspace.repo';
import { WorkspaceSourceRepository } from '../../db/repositories/workspace-source.repo';
import { ChatSessionRepository } from '../../db/repositories/session.repo';
import { MessageRepository } from '../../db/repositories/message.repo';
import { AgentRepository } from '../../db/repositories/agent.repo';
import { ActivityRepository } from '../../db/repositories/activity.repo';
import { getDatabase, resolveWorkspaceDir } from '../../db/connection';
import { mt } from '../../i18n';
import { agents } from '../../db/schema';
import { sendMessage } from '../../services/chat-service';
import { ensureDefaultInstructions } from '../../services/agent-instructions';
import { attachDefaultSkills } from '../../services/bundled-skills';
import { scheduleSourceIngestion } from '../../services/source-ingestion-service';
import {
  scheduleEmbeddingsAutoInstall,
  scheduleFastApplyAutoInstall,
} from '../../services/model-download-service';
import { SettingsRepository } from '../../db/repositories/settings.repo';
import { DEFAULT_PERFORMANCE_PRESET } from '../../../shared/performance-presets';
import type { AdapterType, Agent, AgentRuntimeConfig } from '../../../shared/types';

const onboardingRepo = new OnboardingRepository();
const userRepo = new UserRepository();
const workspaceRepo = new WorkspaceRepository();
const sourceRepo = new WorkspaceSourceRepository();
const sessionRepo = new ChatSessionRepository();
const messageRepo = new MessageRepository();
const agentRepo = new AgentRepository();
const activityRepo = new ActivityRepository();

/**
 * Cria automaticamente um WorkspaceSource ligado ao path/repo escolhido no
 * onboarding. Sem isso, a sidebar mostra "Adicionar source" vazio mesmo
 * tendo escolhido um repo no wizard. Idempotente — não duplica se já existe
 * um source com mesmo path.
 */
function ensureOnboardingSource(input: {
  workspaceId: string;
  path?: string | null;
  gitRemote?: string | null;
  provider?: 'local' | 'github' | 'azure' | null;
}) {
  if (!input.path && !input.gitRemote) return null;
  const existing = sourceRepo.listByWorkspace(input.workspaceId);
  if (existing.length > 0) return existing.find((source) => source.isPrimary) ?? existing[0];

  const isAzure = input.provider === 'azure';
  const isGithub = input.provider === 'github' || (!!input.gitRemote && !isAzure);
  const repoFullName = input.gitRemote
    ? isAzure
      ? input.gitRemote
      : input.gitRemote.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
    : null;
  const label = repoFullName
    ? (repoFullName.split('/').pop() ?? repoFullName)
    : input.path
      ? basename(input.path)
      : 'source';

  return sourceRepo.create({
    workspaceId: input.workspaceId,
    kind: isAzure ? 'azure_repo' : isGithub ? 'github_repo' : 'local_folder',
    path: input.path ?? null,
    repoFullName,
    label,
    role: null,
    isPrimary: true,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Cria o primeiro agente (CEO/Orchestrator) configurado pelo usuário no Step 2.
 * Recebe o adapterType + model + adapterConfig do onboarding.
 *
 * Exportada para ser reusada pelo handler `agent:create-orchestrator`, que
 * garante que TODO workspace (inclusive os criados pelo switcher da sidebar)
 * nasça com um CEO/Orchestrator.
 */
export function createFirstAgent(input: {
  workspaceId: string;
  name: string;
  adapterType: AdapterType;
  model?: string;
  adapterConfig: Record<string, unknown>;
  /** Nível de autonomia do time (slider do onboarding). Default 'medium'. */
  autonomyLevel?: 'low' | 'medium' | 'high';
}): Agent {
  const db = getDatabase();
  const now = nowIso();
  const agentId = randomUUID();
  const ceoTitle = mt('Orquestrador principal', 'Lead orchestrator');
  const systemPrompt = mt(
    'Você é o agente principal do workspace. Lê o projeto, identifica o stack ' +
      'e as necessidades, e coordena tarefas com agentes especializados quando preciso. ' +
      'Mantém a memória do workspace atualizada.',
    'You are the main agent of the workspace. You read the project, identify the stack ' +
      'and the needs, and coordinate tasks with specialist agents when needed. ' +
      'You keep the workspace memory up to date.',
  );
  db.insert(agents)
    .values({
      id: agentId,
      workspaceId: input.workspaceId,
      name: input.name,
      role: 'orchestrator',
      title: ceoTitle,
      adapterType: input.adapterType,
      // Esforço do CEO = BASELINE de raciocínio do time (todos os agentes herdam via
      // resolveReasoningEffort). Gravado no adapterConfig (fonte da verdade lida pela
      // UI e pelo spawn --effort); default alto p/ planejamento profundo, a menos que
      // o onboarding informe outro. A coluna `effort` é mantida só por retrocompat.
      adapterConfig: {
        ...input.adapterConfig,
        effort: (input.adapterConfig.effort as string | undefined) ?? 'auto',
      },
      provider: input.adapterType,
      model: input.model ?? null,
      effort: 'auto',
      capabilities:
        'Orchestrates the team: turns the user request into goals and a plan (epic + sub-issues), hires the specialists, delegates and tracks the work, and validates the final delivery.',
      systemPrompt,
      status: 'idle',
      isOrchestrator: true,
      canCreateAgents: true,
      canAssignTasks: true,
      canEditFiles: true,
      canRunCommands: true,
      // bypassSandbox=true por default no CEO criado pelo onboarding — sem
      // isso, o claude-code pergunta permissão a cada Read/Write/Bash e a
      // análise do source trava. Usuário pode desligar em Configuração depois
      // se quiser modo restrito.
      // runtimeConfig é a fonte que a UI (AgentPage) edita e exibe. Espelha aqui o que
      // o onboarding escolheu (esforço + busca) pra não mostrar "auto"/desligado mesmo
      // tendo configurado — adapterConfig.effort segue gravado acima por retrocompat, e
      // resolveReasoningEffort prioriza runtimeConfig.thinkingEffort no spawn.
      runtimeConfig: {
        bypassSandbox: true,
        autonomyLevel: input.autonomyLevel ?? 'medium',
        // CEO é papel de raciocínio: esforço 'auto' (decide sozinho quanto pensar).
        thinkingEffort: 'auto' as AgentRuntimeConfig['thinkingEffort'],
        // Busca web ligada por default (o usuário pode desligar em Configuração).
        enableSearch: Boolean(
          input.adapterConfig.search ?? input.adapterConfig.enableSearch ?? true,
        ),
      },
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Materializa AGENTS.md, SOUL.md, HEARTBEAT.md, TOOLS.md em disco. Sem isso,
  // o arquivo só seria criado na primeira chat:send — e o usuário cliclando
  // em "Editar instructions" no AgentPage logo após onboarding veria 404.
  ensureDefaultInstructions({
    id: agentId,
    workspaceId: input.workspaceId,
    name: input.name,
    role: 'orchestrator',
    title: ceoTitle,
    adapterType: input.adapterType,
    model: input.model ?? null,
    systemPrompt,
    isOrchestrator: true,
    status: 'idle',
    capabilities: null,
    // Demais campos não consumidos pela função; cast pra Agent é seguro porque
    // ensureDefaultInstructions só usa id/workspaceId/name/role/title/etc.
  } as Parameters<typeof ensureDefaultInstructions>[0]);

  // Skills default do orquestrador (planejamento + investigação).
  attachDefaultSkills(agentId, input.workspaceId, 'orchestrator');

  const created = agentRepo.get(agentId);
  if (!created) throw new Error('Falha ao criar agente orquestrador');
  return created;
}

export function registerOnboardingHandlers(): void {
  registerHandler('onboarding:get', () => onboardingRepo.get());

  // Dispara o time inicial (hiring plan do CEO) pra um workspace já criado —
  // usado pelo toggle "gerar time inicial" do wizard de criação de workspace.
  registerHandler('hiring:run-initial', (req) => {
    scheduleHiringPlan(req.workspaceId);
    return { scheduled: true };
  });

  registerHandler('onboarding:set-step', (req) => onboardingRepo.setStep(req.step));
  registerHandler('onboarding:reset', () => onboardingRepo.reset());

  registerHandler('onboarding:complete', (req) => {
    // 0. Preset de desempenho/memória escolhido no slider — PERSISTE ANTES de
    // qualquer download/config, pra a config do smart-exec já ler o footprint
    // certo da máquina do usuário.
    // Sempre grava (com fallback) pra todo onboarding deixar a linha consistente.
    new SettingsRepository().update({
      performance: { preset: req.performancePreset ?? DEFAULT_PERFORMANCE_PRESET },
    });

    // 1. Usuário (perfil mínimo — só name + email)
    const user = userRepo.upsert({
      name: req.user.name,
      aliases: [],
      email: req.user.email ?? null,
      // Defaults pro perfil — campos não coletados no fluxo novo
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'America/Sao_Paulo',
      useDeviceTimezone: true,
      language: 'pt-BR',
      aiStyle: 'concise',
    });

    // 2. Workspace = projeto. Mission, objectives e path/repo vivem aqui.
    const workspace = workspaceRepo.create({
      name: req.company.name,
      companyName: req.company.name,
      mission: req.company.mission,
      objectives: req.objectives,
      icon: req.company.icon,
      color: req.company.color,
      planMode: req.plan === 'team-cloud' ? 'team' : 'local',
      path: req.company.path,
      gitRemote: req.company.gitRemote,
      provider: req.company.provider,
    });

    // Cria pasta workspace em ~/.orkestral/workspaces/<id>
    try {
      resolveWorkspaceDir(workspace.id);
    } catch (err) {
      // Não fatal — só log
      console.warn('[onboarding] falhou criar dir workspace:', err);
    }

    // 3. Primeiro agente (CEO/Orchestrator com adapter CLI escolhido)
    createFirstAgent({
      workspaceId: workspace.id,
      name: req.agent.name,
      adapterType: req.agent.adapterType,
      model: req.agent.model,
      adapterConfig: req.agent.adapterConfig ?? {},
      autonomyLevel: req.agent.autonomyLevel,
    });

    // 4. Marca onboarding como completo
    onboardingRepo.markCompleted({
      plan: req.plan,
      llmProvider: req.agent.adapterType,
      objectives: req.objectives,
    });

    // 5. Sources com PATH LOCAL já disponível — registra direto (pastas locais E
    // repos git já no disco que o usuário "apontou pro existente"), sem clonar,
    // preservando o kind/repoFullName. Repos remotos SEM path são criados/clonados
    // pelo renderer via source:create (suporta múltiplos GitHub/Azure).
    const localSources = (req.company.sources ?? []).filter((source) => !!source.path);
    if (localSources.length > 0) {
      localSources.forEach((source, index) => {
        const createdSource = sourceRepo.create({
          workspaceId: workspace.id,
          kind: source.kind,
          path: source.path ?? null,
          repoFullName: source.repoFullName ?? null,
          label: source.label,
          role: null,
          isPrimary: index === 0,
        });
        if (createdSource.path) {
          scheduleSourceIngestion({
            workspaceId: workspace.id,
            sourceId: createdSource.id,
            reason: 'onboarding-local-sources',
            runKnowledgeAnalysis: true,
            delayMs: 800,
          });
        }
      });
    } else if (workspace.provider === 'local') {
      const createdSource = ensureOnboardingSource({
        workspaceId: workspace.id,
        path: workspace.path,
        gitRemote: workspace.gitRemote,
        provider: workspace.provider,
      });
      if (createdSource?.path) {
        scheduleSourceIngestion({
          workspaceId: workspace.id,
          sourceId: createdSource.id,
          reason: 'onboarding-local-source',
          runKnowledgeAnalysis: true,
          delayMs: 800,
        });
      }
    }

    // 6. Hiring plan em background — só dispara se workspace já tem path
    // local. Quando é GitHub, o renderer faz o clone primeiro e depois chama
    // 'workspace:finalize-github' que dispara o plano.
    // Agenda quando já há pasta local pronta (`path` setado). No fluxo
    // GitHub-com-clone o `path` ainda é nulo aqui — quem agenda é o
    // finalize-github, depois do clone. A trava antiga `!workspace.gitRemote`
    // bloqueava pasta local que também tinha git remoto; removida.
    if (req.runInitialHiringPlan !== false && !!workspace.path) {
      scheduleHiringPlan(workspace.id);
    }

    // Onboarding concluído → baixa em background e SILÊNCIO o embedder dedicado
    // (0.6B, busca semântica do KB) e o fast-apply (aplica os edits localmente, de
    // graça, em vez de gastar tokens premium reescrevendo arquivo). Forge removido.
    scheduleEmbeddingsAutoInstall();
    scheduleFastApplyAutoInstall();

    return { workspace, project: null, user };
  });

  // Chamado pelo renderer DEPOIS de clonar o repo GitHub. Atualiza o path
  // do workspace pro diretório clonado, sincroniza o source (path) e
  // dispara o hiring plan.
  registerHandler('workspace:finalize-github', (req) => {
    const ws = workspaceRepo.setPath(req.workspaceId, req.clonedPath);
    // Atualiza o path do source existente pra apontar pro clone
    const sources = sourceRepo.listByWorkspace(ws.id);
    const primary = sources.find((s) => s.isPrimary) ?? sources[0];
    if (primary) {
      sourceRepo.update(primary.id, { path: req.clonedPath });
      scheduleSourceIngestion({
        workspaceId: ws.id,
        sourceId: primary.id,
        reason: 'workspace-finalize-github',
        runKnowledgeAnalysis: true,
        delayMs: 500,
      });
    } else {
      const createdSource = ensureOnboardingSource({
        workspaceId: ws.id,
        path: req.clonedPath,
        gitRemote: ws.gitRemote,
        provider: 'github',
      });
      if (createdSource) {
        scheduleSourceIngestion({
          workspaceId: ws.id,
          sourceId: createdSource.id,
          reason: 'workspace-finalize-github',
          runKnowledgeAnalysis: true,
          delayMs: 500,
        });
      }
    }
    if (req.runInitialHiringPlan !== false) {
      scheduleHiringPlan(ws.id);
    }
    return ws;
  });
}

/**
 * Dispara, em background, uma sessão com o CEO/Orchestrator pedindo um
 * plano de contratação baseado no path/repo do workspace. Roda DEPOIS que
 * o onboarding já está finalizado e o app já mostrou o dashboard.
 *
 * Usa setTimeout pra dar tempo do main process estabilizar e do main window
 * estar pronta a receber stream events.
 */
// Idempotência do plano inicial: vários handlers (onboarding:complete,
// workspace:finalize-github, hiring:run-initial) podiam chamar isto pro MESMO
// workspace, gerando DUAS sessões "Plano de contratação inicial". Marcamos
// SÍNCRONO (antes do setTimeout) pra que a 2ª chamada saia cedo. Só vale pro
// modo 'initial'; 'source-added' pode disparar várias vezes (1 por source novo).
const initialHiringScheduled = new Set<string>();

// Marcadores de título do plano inicial (PT/EN). Usados pra dedup à prova de
// restart: o Set acima some quando o app reinicia, então antes de criar a sessão
// checamos no banco se já existe uma com esse título e só reabrimos.
const HIRING_SESSION_TITLE_MARKERS = ['Plano de contratação inicial', 'Initial hiring plan'];

export function scheduleHiringPlan(
  workspaceId: string,
  options: { mode?: 'initial' | 'source-added'; sourceId?: string } = {},
): void {
  if ((options.mode ?? 'initial') === 'initial') {
    if (initialHiringScheduled.has(workspaceId)) {
      console.log(
        `[onboarding] hiring plan inicial já agendado p/ ${workspaceId} — ignorando duplicata`,
      );
      return;
    }
    initialHiringScheduled.add(workspaceId);
  }
  setTimeout(() => {
    void (async () => {
      try {
        // NÃO espera a análise aqui: cria a sessão + navega JÁ (tempo real desde
        // o 1º segundo pós-onboarding); a espera acontece depois, com a sessão
        // já aberta e um feedback de "analisando" visível.
        const ws = workspaceRepo.list().find((w) => w.id === workspaceId);
        if (!ws) return;
        const ceo = agentRepo.getOrchestrator(workspaceId);
        if (!ceo) return;

        // Fallback pro source primário: no onboarding o path/gitRemote vive no
        // workspace, mas no wizard de criação eles ficam só no source. Sem isso
        // o hiring plan disparado pelo wizard sairia sem location e abortaria.
        const sources = sourceRepo.listByWorkspace(workspaceId);
        const primary = sources.find((s) => s.isPrimary) ?? sources[0];
        const addedSource = options.sourceId
          ? sources.find((source) => source.id === options.sourceId)
          : null;
        const effectivePath = ws.path ?? primary?.path ?? null;
        const effectiveRemote =
          ws.gitRemote ??
          (primary?.kind === 'github_repo' || primary?.kind === 'azure_repo'
            ? primary.repoFullName
            : null) ??
          null;
        const existingAgents = agentRepo.listByWorkspace(workspaceId);
        const agentsSummary = existingAgents
          .map((agent) => `- ${agent.name} (${agent.role}${agent.title ? `, ${agent.title}` : ''})`)
          .join('\n');
        const sourcesSummary = sources.length
          ? sources
              .map((source, index) => {
                const locationText =
                  source.path ?? source.repoFullName ?? 'sem path remoto/local ainda';
                const roleText = source.role ? `, role=${source.role}` : '';
                const primaryText = source.isPrimary ? ', primary' : '';
                const addedText = source.id === addedSource?.id ? ', NEW SOURCE' : '';
                return `${index + 1}. ${source.label} (${source.kind}${roleText}${primaryText}${addedText}) -> ${locationText}`;
              })
              .join('\n')
          : 'No registered sources yet.';
        const mode = options.mode ?? 'initial';

        const location = effectivePath
          ? `pasta local: ${effectivePath}`
          : effectiveRemote
            ? `source: ${effectiveRemote}`
            : null;
        if (!location) return;

        const prompt = [
          // Começa com @<nome do agente> pra marcar o destinatário no histórico
          // do chat (a UI renderiza o handle e ajuda o usuário a identificar
          // quem foi acionado).
          `@${ceo.name} You are the CEO/Orchestrator of the workspace "${ws.companyName ?? ws.name}".`,
          '[[HIRING_BOOTSTRAP_HIDDEN]]',
          // Não há mensagem real do usuário aqui (prompt seedado), então fixa o
          // idioma da resposta (e do raciocínio) no idioma da UI do usuário.
          mt(
            'IMPORTANTE: pense e responda em português do Brasil.',
            'IMPORTANT: think and respond in English.',
          ),
          ws.mission ? `Workspace mission: ${ws.mission}` : null,
          `The workspace points to ${location}.`,
          '',
          '## Registered sources',
          sourcesSummary,
          '',
          '## Existing agents',
          agentsSummary || '- Only the CEO/Orchestrator exists.',
          addedSource
            ? [
                '',
                '## Newly added source',
                `${addedSource.label} (${addedSource.kind}) -> ${addedSource.path ?? addedSource.repoFullName ?? 'path pending'}`,
              ].join('\n')
            : null,
          '',
          mode === 'source-added'
            ? '## Mode: INCREMENTAL HIRING PLAN AFTER NEW SOURCE (HIDDEN FROM THE USER)'
            : '## Mode: INITIAL HIRING PLAN (HIDDEN FROM THE USER)',
          '',
          mode === 'source-added'
            ? 'Your task is to decide whether the newly added source requires missing specialist agents NOW.'
            : 'Your task is to decide whether it is worth hiring an initial team NOW.',
          'Do it without exposing internal rules. Keep the reply short and user-friendly.',
          '',
          '### RULES',
          '',
          '- Do not create any issue, KB page, or extra artifact.',
          '- **BE FAST.** Read AT MOST the README + the stack manifest (package.json/composer.json/pom.xml/go.mod/Cargo.toml) of each source — 1–2 quick reads per source, NOTHING more. Do NOT deep-scan the repo, do NOT walk the tree, do NOT run many tools. The goal is to propose a standard team, not audit the code. Then propose immediately.',
          '- Consider all sources together. If one source is backend and another is frontend, the team must cover both.',
          mode === 'source-added'
            ? '- Propose ONLY missing agents that do not already exist. Never propose an agent with the same name/role as an existing one.'
            : null,
          mode === 'source-added'
            ? '- If existing agents already cover the new source, return HIRING_DECISION: REJECTED with a short explanation.'
            : null,
          '- Use only standard roles: TechLead, Code Reviewer, Frontend, Backend, DevOps, QA, Designer, Product.',
          mode === 'source-added'
            ? '- TechLead and Code Reviewer are mandatory only if they do not already exist. If they already exist, do not propose them again.'
            : '- **TechLead and Code Reviewer are MANDATORY** in every approved team.',
          '- Standard hierarchy (Paperclip-style):',
          '  • TechLead and Code Reviewer report to the CEO.',
          '  • All specialists (Frontend, Backend, DevOps, QA, …) report to the TechLead.',
          mode === 'source-added'
            ? '- If you approve incremental hiring, propose between 1 and 4 missing agents.'
            : '- If you approve hiring, propose between 5 and 7 agents (2 fixed + 3-5 specialists). Cover what the project ACTUALLY needs based on the stack you read (e.g. a web app needs Frontend + a UX/UI Designer; an API needs Backend; add QA/DevOps when the evidence warrants).',
          '',
          '### IMPORTANT',
          '',
          'The interface will read a hidden technical structure from your reply to create',
          'the agents automatically. The user should see only the simple explanation.',
          '',
          '### MANDATORY FORMAT',
          '',
          '```',
          '## Summary for the user',
          '<2-4 lines, plain language, no internal system terms>',
          '',
          '## Decision',
          '',
          '<Approved to hire now> or <Better to skip for now>',
          '',
          '## Next step',
          '',
          '<1 objective sentence>',
          '',
          'HIRING_DECISION: <APPROVED|REJECTED>',
          '',
          mode === 'source-added'
            ? 'If HIRING_DECISION is APPROVED, include between 1 and 4 EXACT lines for missing agents only. If TechLead already exists, specialists may report_to="TechLead" without repeating TechLead:'
            : 'If HIRING_DECISION is APPROVED, include between 5 and 7 EXACT lines in this format (IMPORTANT: TechLead and Code Reviewer ALWAYS first, before the specialists, because the specialists use reports_to="TechLead" and need it to exist):',
          '',
          '<orkestral:create-agent name="TechLead" role="tech-lead" title="Tech Lead" reports_to="CEO" capabilities="Overall architecture, technical decisions, coordinates specialists" />',
          '<orkestral:create-agent name="Code Reviewer" role="code-reviewer" title="Code Reviewer" reports_to="CEO" capabilities="Reviews PRs, ensures quality and standards" />',
          '<orkestral:create-agent name="Frontend" role="frontend" title="Frontend" reports_to="TechLead" capabilities="UI, components, client-side" />',
          '<orkestral:create-agent name="Backend" role="backend" title="Backend" reports_to="TechLead" capabilities="APIs, data, business rules" />',
          '<orkestral:create-agent name="Designer" role="designer" title="UX/UI Designer" reports_to="TechLead" capabilities="UX, UI, design system, accessibility, visual consistency" />',
          '',
          'HARD reports_to rules:',
          '- TechLead → reports_to="CEO"',
          '- Code Reviewer → reports_to="CEO"',
          '- EVERYONE else → reports_to="TechLead" (NEVER directly to the CEO)',
          '```',
          '',
          mode === 'source-added'
            ? 'Empty newly-added source (no code at all)? Return HIRING_DECISION: REJECTED and explain in 1 simple sentence.'
            : 'A greenfield project (empty folder) is EXPECTED here: the user is starting from a clear vision, NOT auditing existing code. Do NOT reject for an empty folder. APPROVE and propose the 5 to 7 standard agents so the build can begin, and you MUST output the create-agent lines (an APPROVED decision with no agent lines is an invalid reply).',
        ]
          .filter(Boolean)
          .join('\n');

        // Dedup à prova de restart: se já existe uma sessão de plano inicial pro
        // workspace (criada antes de um restart, quando o Set em memória zerou),
        // só reabre ela em vez de criar uma duplicata.
        if ((options.mode ?? 'initial') === 'initial') {
          const existingHiring = sessionRepo
            .listByWorkspace(workspaceId)
            .find((s) => HIRING_SESSION_TITLE_MARKERS.some((m) => s.title.includes(m)));
          if (existingHiring) {
            // broadcast (host): janelas + pushBus (gateway/CLI) — mesmo canal do sentry.
            broadcast('chat:session-ready', {
              workspaceId,
              sessionId: existingHiring.id,
              reason: 'hiring-plan',
            });
            return;
          }
        }

        const session = sessionRepo.create({
          workspaceId,
          agentId: ceo.id,
          title: mt(
            `Plano de contratação inicial — @${ceo.name}`,
            `Initial hiring plan — @${ceo.name}`,
          ),
          directory: effectivePath ?? undefined,
        });

        // FLUIDEZ: o chat é chat. Abre a sessão e o CEO JÁ COMEÇA a responder —
        // sem esperar a análise das sources (que roda em background, como job
        // próprio na KB/Fontes) e SEM despejar card de "analisando" aqui. O CEO
        // lê o essencial (README/package.json) por conta própria e propõe rápido.
        broadcast('chat:session-ready', {
          workspaceId,
          sessionId: session.id,
          reason: 'hiring-plan',
        });

        sendMessage({ sessionId: session.id, content: prompt }).catch((err) => {
          console.warn('[onboarding] hiring plan falhou:', err);
          // Feedback NO CHAT: a sessão já está aberta; se o disparo falhar, posta
          // uma mensagem visível pra não deixar o chat vazio/mudo. Sem isso o
          // usuário ficava olhando uma sessão em branco pra sempre.
          try {
            messageRepo.insert({
              sessionId: session.id,
              role: 'assistant',
              parts: [
                {
                  type: 'text',
                  text: mt(
                    'Não consegui montar a proposta do time agora. Me peça de novo aqui no chat — ex.: "proponha um time inicial de agentes".',
                    'I couldn\'t build the team proposal right now. Ask me again here in the chat — e.g. "propose an initial team of agents".',
                  ),
                },
              ],
              status: 'done',
            });
          } catch {
            // best-effort — não derruba o fluxo
          }
          // Também grava uma atividade pra aparecer no histórico/Inbox.
          try {
            activityRepo.log({
              workspaceId,
              kind: 'hiring.failed',
              actorKind: 'system',
              subjectKind: 'session',
              subjectId: session.id,
              title: mt(
                'Não consegui propor o time inicial automaticamente',
                "Couldn't propose the initial team automatically",
              ),
              payload: { error: err instanceof Error ? err.message : String(err) },
            });
          } catch {
            // best-effort — não derruba o fluxo de onboarding
          }
        });
      } catch (err) {
        console.warn('[onboarding] scheduleHiringPlan erro:', err);
      }
    })();
  }, 2500); // delay pra UI carregar (após a animação de transição)
}
