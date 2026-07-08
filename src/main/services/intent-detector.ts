/**
 * Detector de intenção da mensagem do usuário.
 *
 * Quando o agente orquestrador recebe uma mensagem cujo conteúdo
 * provavelmente vai gerar trabalho a ser rastreado (plano, feature, bug,
 * refactor, etc.), retornamos uma diretiva pra ser ANEXADA ao prompt
 * forçando o agente a usar o protocolo de issues.
 *
 * O agente já tem o protocolo no AGENTS.md — esse pre-prompt é um reforço
 * de "atenção" que fica próximo da mensagem do usuário, aumentando muito
 * a probabilidade de o modelo de fato seguir a regra.
 *
 * CAMINHO RÁPIDO vs FALLBACK: `detectIntent` é SÍNCRONO e barato (keyword/regex)
 * — o caso comum (mensagem clara) resolve aqui sem custo. O regex é frágil em
 * frases naturais/acentuadas ("dá um jeito nesse defeito do checkout"), então
 * `detectIntentWithFallback` reusa o caminho rápido e, SÓ quando ele fica
 * `confidence: 'low'`, escala pra uma classificação barata no modelo local
 * (Orkestral Forge). O fallback é OPCIONAL e fail-safe: se o modelo local não
 * estiver disponível/falhar, mantém o resultado do regex. Cache por-mensagem
 * evita reprocessar a mesma mensagem.
 */
import { runLocalPhase, parseFirstJsonObject } from './smart-exec/llama-runtime';
import { getSmartExecConfig } from './smart-exec/config';
import { trace } from './log-bus';

const PLANNING_TRIGGERS = [
  // pt-BR
  'plano',
  'planejar',
  'planejamento',
  'roadmap',
  'estratégia',
  'estrategia',
  'arquitetura',
  'implementar',
  'construir',
  'desenvolver',
  'criar',
  'montar',
  'integração',
  'integracao',
  'integrar',
  'feature',
  'funcionalidade',
  'módulo',
  'modulo',
  'refatorar',
  'refatoração',
  'refactor',
  'refactoring',
  'migrar',
  'migração',
  'migration',
  'fases',
  'etapas',
  'passos',
  'tarefas',
  'subtasks',
  'sub-tasks',
  'sub tasks',
  'tasks',
  'issues',
  // bugs
  'bug',
  'problema',
  'erro',
  'falha',
  'investigar',
  'auditoria',
  'auditar',
  'corrigir',
  // en
  'plan',
  'roadmap',
  'implement',
  'build',
  'create',
  'develop',
  'integrate',
  'feature',
  'refactor',
  'migrate',
  'phases',
  'steps',
  'tasks',
  'investigate',
  'fix',
  'audit',
];

const QUESTION_PATTERNS = [
  /^(o que|como|quando|onde|por que|por quê|qual|quais|quem)\b/i,
  /^(what|how|when|where|why|which|who)\b/i,
  /\?$/,
];

/**
 * Retorna true se a mensagem aparenta SER uma pergunta simples (não disparadora
 * de plano), pra evitar forçar issues em conversas conceituais.
 */
function looksLikeSimpleQuestion(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 80 && QUESTION_PATTERNS.some((re) => re.test(trimmed))) {
    // Conta hits de planning — se for muitas, prevalece o plano.
    const hits = countPlanningHits(trimmed);
    return hits === 0;
  }
  return false;
}

function countPlanningHits(content: string): number {
  const lower = content.toLowerCase();
  let hits = 0;
  for (const kw of PLANNING_TRIGGERS) {
    if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
      hits++;
    }
  }
  return hits;
}

export type IntentKind = 'planning' | 'bug-investigation' | 'pure-question' | 'unknown' | 'hiring';

export interface IntentSignal {
  kind: IntentKind;
  /** Score 0-N de quantos triggers bateram. */
  score: number;
  /** Diretiva a anexar ao prompt do agente (vazia se não há intent forte). */
  directive: string;
  /**
   * Confiança do caminho REGEX (rápido). 'low' sinaliza que o keyword/regex não
   * achou sinal forte e o resultado é ambíguo — é a porta pro fallback do modelo
   * local (`detectIntentWithFallback`). 'high' = sinal claro, NÃO vale a pena
   * gastar o modelo local (mantém o caso comum rápido).
   */
  confidence: 'low' | 'high';
}

/**
 * Analisa a mensagem do usuário e retorna o signal + a diretiva.
 *
 * @param isOrchestrator se o agente atual é orquestrador. Sub-agentes
 *   especialistas não precisam quebrar em issues; eles executam.
 */
/**
 * Opt-out explícito: se o usuário pede texto puro / "não crie issues" / modo
 * hiring plan, NÃO disparamos o protocolo. Antes só existia no AGENTS.md (texto)
 * e o detector ignorava — o agente criava issues contra a vontade do usuário.
 */
const ISSUE_OPT_OUT_PATTERNS = [
  /responda?\s+(em|apenas com|só com|so com)\s+texto/i,
  /n[ãa]o\s+cri(e|ar)\s+(issues?|tarefas?)/i,
  /sem\s+cri(ar|ação de)\s+issues?/i,
  /n[ãa]o\s+(use|usar)\s+blocos/i,
  /hiring\s+plan/i,
  /plano\s+de\s+contrata[çc][ãa]o/i,
  // "sem criar issues" / "sem novas issues" — exige verbo de criação OU "novas"
  // perto, pra NÃO disparar em "problemas sem issues conhecidas" (sem = ausência).
  /\bsem\s+(criar\s+|novas?\s+)issues?\b/i,
];

// Pedido pra propor/montar/contratar um TIME de agentes. Quando vem no chat pro
// orquestrador (CEO), não é issue nem prosa: dispara o protocolo de hiring plan
// (mesmo formato do onboarding) pra materializar o Inbox de aprovação + o card de
// plano no chat. Cada padrão exige a ação PERTO de um alvo (time/equipe/squad/
// agentes) pra não confundir com "criar uma issue", etc.
const HIRING_TRIGGERS = [
  /\b(propor|proponha|prop[õo]e|monta?r?|monte|criar?|crie|contratar?|contrate|sugira|sugerir|estruturar?|formar?|forme)\b[^.?!]{0,40}\b(time|equipe|squad|agentes?)\b/i,
  /\b(time|equipe)\s+(inicial|de\s+agentes)\b/i,
  /\b(hire|assemble|propose|build|form|create|suggest|set\s*up)\b[^.?!]{0,40}\b(team|squad|agents?|crew)\b/i,
];

// Verbo de montagem/contratação (PT+EN) e substantivo de TIME, desacoplados: a
// janela de 40 chars dos HIRING_TRIGGERS perde pedidos naturais ("monta pra mim,
// quando puder, a equipe ideal"). Se um verbo de hiring E um substantivo de time
// aparecem em QUALQUER lugar da mensagem, tratamos como hiring.
const HIRING_VERB_RE =
  /\b(propor|proponha|prop[õo]e|montar?|monte|criar?|crie|contratar?|contrate|sugira|sugerir|estruturar?|formar?|forme|hire|assemble|propose|build|form|suggest|set\s*up)\b/i;
const HIRING_TARGET_RE = /\b(times?|equipes?|squad|agentes?|team|agents?|crew)\b/i;

function looksLikeHiringRequest(content: string): boolean {
  if (HIRING_TRIGGERS.some((re) => re.test(content))) return true;
  return HIRING_VERB_RE.test(content) && HIRING_TARGET_RE.test(content);
}

/**
 * Diretiva de hiring pro CEO no CHAT. Reusa o MESMO formato do onboarding
 * (`onboarding.ts` -> hiring:run-initial) — `HIRING_DECISION:` + blocos
 * `<orkestral:create-agent .../>` — porque é exatamente isso que o finishRun do
 * chat-service parseia pra criar a pendência no Inbox + o card de plano. Sem essa
 * diretiva o CEO responde só em prosa e nada materializa.
 */
const HIRING_DIRECTIVE = [
  '## ⚡ HARD directive: HIRING PLAN',
  '',
  'The user asked you (the CEO) to propose/assemble a team of agents. Do NOT answer',
  'with prose only: the interface will read a HIDDEN technical structure from your reply',
  'to create the approval pending item in the Inbox + the plan card in the chat.',
  '',
  '### RULES',
  "- **LANGUAGE: mirror the user.** Write EVERYTHING in the SAME language as the user's last",
  '  message — the section HEADINGS, the summary, the decision text, the next step. If the user',
  '  wrote in Portuguese, the headings are "## Resumo para o usuário", "## Decisão", "## Próximo',
  '  passo" and the decision reads "Aprovado para contratar agora"/"Melhor pular por agora".',
  '  ONLY these machine tokens stay EXACTLY in English: the literal line `HIRING_DECISION: <APPROVED|REJECTED>`',
  '  and the `<orkestral:create-agent .../>` blocks. Never mix two languages in the reply.',
  '- Before proposing, use the MCP tools `list_agents` and `list_sources` to avoid duplicating',
  '  agents that already exist and to understand the workspace stack.',
  '- Standard roles: TechLead, Code Reviewer, Frontend, Backend, DevOps, QA, Designer, Product.',
  '- **TechLead and Code Reviewer are MANDATORY** in every approved team.',
  '- Hierarchy: TechLead and Code Reviewer report to the CEO; everyone else reports to the TechLead.',
  '- If you approve, propose between 5 and 7 agents (2 fixed + 3-5 specialists).',
  '',
  "### MANDATORY FORMAT (the headings below are shown in English — TRANSLATE them to the user's language)",
  '',
  '## Summary for the user',
  '<2-4 lines, plain language, no internal system terms>',
  '',
  '## Decision',
  '<Approved to hire now> or <Better to skip for now>',
  '',
  '## Next step',
  '<1 objective sentence>',
  '',
  'HIRING_DECISION: <APPROVED|REJECTED>',
  '',
  'If HIRING_DECISION is APPROVED, include between 5 and 7 EXACT lines in this format',
  '(TechLead and Code Reviewer ALWAYS first, before the specialists, because the',
  'specialists use reports_to="TechLead" and need it to exist):',
  '',
  '<orkestral:create-agent name="TechLead" role="tech-lead" title="Tech Lead" reports_to="CEO" capabilities="Overall architecture, technical decisions, coordinates specialists" />',
  '<orkestral:create-agent name="Code Reviewer" role="code-reviewer" title="Code Reviewer" reports_to="CEO" capabilities="Reviews PRs, ensures quality and standards" />',
  '<orkestral:create-agent name="Frontend" role="frontend" title="Frontend" reports_to="TechLead" capabilities="UI, components, client-side" />',
  '<orkestral:create-agent name="Backend" role="backend" title="Backend" reports_to="TechLead" capabilities="APIs, data, business rules" />',
  '<orkestral:create-agent name="DevOps" role="devops" title="DevOps" reports_to="TechLead" capabilities="CI/CD, infra, deploy" />',
  '',
  'HARD reports_to rules:',
  '- TechLead → reports_to="CEO"',
  '- Code Reviewer → reports_to="CEO"',
  '- EVERYONE else → reports_to="TechLead" (NEVER directly to the CEO)',
  '',
  'Empty workspace/folder or team already complete? Return HIRING_DECISION: REJECTED and explain in 1 sentence.',
  'Do NOT write the `<orkestral:create-agent>` blocks inside a code block — they must go raw, the UI materializes them.',
].join('\n');

export function detectIntent(content: string, isOrchestrator: boolean): IntentSignal {
  // Hiring tem prioridade máxima e só vale pro orquestrador (CEO). Vem ANTES do
  // opt-out porque "plano de contratação" está nos padrões de opt-out de issues —
  // mas aqui é justamente o gatilho do protocolo de hiring.
  if (isOrchestrator && looksLikeHiringRequest(content)) {
    return { kind: 'hiring', score: 5, directive: HIRING_DIRECTIVE, confidence: 'high' };
  }

  // Respeita opt-out explícito do usuário (texto puro / sem issues) — MAS por
  // CLÁUSULA, não como kill-switch da mensagem inteira. Antes, um único "sem issues"
  // dentro de um pedido legítimo de plano envenenava tudo e nada era rastreado.
  // Removemos a(s) cláusula(s) de opt-out e contamos o sinal de plano no RESTANTE:
  // se ainda há sinal forte (>=2) fora da cláusula, é trabalho de verdade e o opt-out
  // não prevalece. (Tirar a cláusula evita que as próprias palavras dela — "criar",
  // "issues" — contem como sinal de plano e anulem um opt-out genuíno.)
  const optOutMatches = ISSUE_OPT_OUT_PATTERNS.some((re) => re.test(content));
  if (optOutMatches) {
    let residual = content;
    for (const re of ISSUE_OPT_OUT_PATTERNS) residual = residual.replace(re, ' ');
    if (countPlanningHits(residual) < 2) {
      return { kind: 'pure-question', score: 0, directive: '', confidence: 'high' };
    }
  }

  if (looksLikeSimpleQuestion(content)) {
    return {
      kind: 'pure-question',
      score: 0,
      directive: '',
      confidence: 'high',
    };
  }

  const score = countPlanningHits(content);

  // Detecta bug separadamente (palavras de bug têm prioridade visual)
  const bugWords = ['bug', 'problema', 'erro', 'falha', 'crash', 'broken', 'fix'];
  const isBug = bugWords.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(content));

  // Detecta também "estruturas" que indicam plano mesmo sem palavra-chave
  const hasListMarker = /\n\s*[-*•]\s/.test(content) || /\n\s*\d+\.\s/.test(content);
  // Texto longo (>240 chars) geralmente carrega contexto pra plano
  const isLongDirective = content.length > 240;

  const effectiveScore =
    score + (isBug ? 1 : 0) + (hasListMarker ? 1 : 0) + (isLongDirective ? 1 : 0);

  if (effectiveScore === 0) {
    // Nada bateu no regex. Isso NÃO significa "sem intent": frases naturais,
    // com acento ou multi-palavra ("preciso que você dê um jeito nesse defeito
    // do checkout") passam batido. Marcamos 'low' pra o caminho assíncrono
    // (`detectIntentWithFallback`) decidir se vale acionar o modelo local.
    return { kind: 'unknown', score: 0, directive: '', confidence: 'low' };
  }

  // Diretiva difere por papel: orquestrador cria issue + DELEGA (não faz);
  // especialista cria issue pra SI + EXECUTA. Mas TODO trabalho vira issue.
  const directive = buildPlanningDirective({
    isBug,
    multipleSignals: effectiveScore >= 2,
    isOrchestrator,
  });

  return {
    kind: isBug ? 'bug-investigation' : 'planning',
    score: effectiveScore,
    directive,
    confidence: 'high',
  };
}

function buildPlanningDirective(opts: {
  isBug: boolean;
  multipleSignals: boolean;
  isOrchestrator: boolean;
}): string {
  // Regra universal: TODO trabalho novo vira issue, sempre. O que muda por
  // papel é o que vem DEPOIS de criar a issue — orquestrador delega, especialista
  // executa.
  const lines = opts.isOrchestrator
    ? buildOrchestratorDirective(opts.isBug)
    : buildSpecialistDirective(opts.isBug);
  if (opts.multipleSignals) {
    lines.push('', 'Strong signals detected — quality here is critical. Depth > quantity.');
  }
  return lines.join('\n');
}

/** Orquestrador (CEO): cria issue + DELEGA. Nunca faz o trabalho técnico. */
function buildOrchestratorDirective(isBug: boolean): string[] {
  // NB: a especificação completa de decomposição (épico → sub-issues FE/BE/Design/QA,
  // contratos done/lean/MATERIALIZE) vive no ORCHESTRATOR_ISSUE_PROTOCOL do AGENTS.md.
  // Aqui só reforçamos o que é SITUACIONAL a este turno: delegar (não executar) e
  // aterrissar na realidade (files reais) antes de decompor — sem re-soletrar o spec.
  const lines = [
    '## ⚡ Directive for this response',
    '',
    'You are the ORCHESTRATOR (CEO) — you direct, you do not execute: no investigating the code',
    'yourself, no writing/proposing the fix. Decompose and delegate per your issue protocol.',
    '',
    '- **LARGE/greenfield request (build a whole app/product)?** Run the Council from your',
    '  protocol: understand → research the domain on the web → ask the user the key decisions',
    '  (ONE ask-user block, end the turn) → plan next turn with the answers.',
    '- **Scoped feature/fix on an existing system?** Ground it fast (`kb_search`/`code_search`',
    '  for the real files; if it already exists, the issue is to adjust it, not rebuild it) and',
    '  create the issues NOW with real `files="..."` targets.',
    '- **KB-backed planning:** issue descriptions stay lean; every non-trivial issue (always for',
    '  UI/greenfield) gets its COMPLETE spec via `kb_create_page` passed as `plan_page` — for UI',
    '  including the `## Design Spec` (named shadcn blocks/template reference, states,',
    '  breakpoints). Spend the planning tokens here so the executor never ships amateur output.',
    '- **UI with no Designer on the roster?** Hire one (`<orkestral:create-agent role="UX/UI',
    '  Designer">`) before decomposing, and give every hired Designer/QA real sub-issues.',
  ];
  if (isBug) {
    lines.push(
      '',
      'Bug: the issue is "[BUG] ..." with the SYMPTOM + suspected area (1–3 lines) — the',
      'specialist diagnoses the cause, not you.',
    );
  }
  return lines;
}

/** Especialista (Frontend/Backend/…): cria issue pra SI e DEPOIS executa. */
function buildSpecialistDirective(isBug: boolean): string[] {
  return [
    '## ⚡ Directive for this response',
    '',
    'You are the EXECUTOR of this work, and every new work request needs an issue as its trail:',
    '',
    `1. First create ONE issue with a \`<orkestral:create-issue>\` block${
      isBug ? ' titled "[BUG] ..."' : ''
    } (assignee = yourself, 1–3 line description).`,
    '2. Then do the task, and keep the issue consistent with what you actually did.',
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// FALLBACK do modelo local (Orkestral Forge)
//
// Só entra em cena quando o regex fica `confidence: 'low'`. Reusa toda a infra
// fail-safe de `runLocalPhase` (NUNCA lança; retorna null em falha/ausência do
// modelo → mantemos o resultado do regex). Custo zero no caso comum porque o
// caminho rápido já resolve antes de chegar aqui.
// ──────────────────────────────────────────────────────────────────────────

/** Rótulos que pedimos ao modelo local — alinhados às áreas que o regex cobre. */
const LOCAL_INTENT_LABELS = ['planning', 'bug', 'question', 'hiring', 'unknown'] as const;
type LocalIntentLabel = (typeof LOCAL_INTENT_LABELS)[number];

/**
 * Cache por-mensagem do resultado RESOLVIDO (já com fallback aplicado). Evita
 * rodar o modelo local duas vezes pra mesma mensagem (ex.: retries / re-render).
 * Chaveado por papel + conteúdo bruto; limitado a um teto pequeno (LRU simples
 * por inserção) pra não vazar memória num processo de vida longa.
 */
const intentCache = new Map<string, IntentSignal>();
const INTENT_CACHE_MAX = 256;

function cacheKey(content: string, isOrchestrator: boolean): string {
  return `${isOrchestrator ? '1' : '0'}|${content}`;
}

function cacheSet(key: string, signal: IntentSignal): IntentSignal {
  // LRU simples: re-inserir move pro fim; ao estourar, descarta o mais antigo.
  if (intentCache.has(key)) intentCache.delete(key);
  intentCache.set(key, signal);
  if (intentCache.size > INTENT_CACHE_MAX) {
    const oldest = intentCache.keys().next().value;
    if (oldest !== undefined) intentCache.delete(oldest);
  }
  return signal;
}

/** Só exposto pra testes/limpeza — zera o cache por-mensagem. */
export function clearIntentCache(): void {
  intentCache.clear();
}

/**
 * Monta o `IntentSignal` final a partir do rótulo do modelo local, REUSANDO as
 * mesmas diretivas do caminho regex (consistência: o agente recebe o mesmo
 * pre-prompt independentemente de quem classificou). `confidence: 'high'` porque
 * já houve uma decisão deliberada (não é mais o vazio do regex).
 */
function signalFromLocalLabel(label: LocalIntentLabel, isOrchestrator: boolean): IntentSignal {
  switch (label) {
    case 'hiring':
      // Hiring só vale pro orquestrador (CEO) — igual ao caminho regex. Pra um
      // especialista, um pedido de "time" sem outro sinal é só conversa.
      return isOrchestrator
        ? { kind: 'hiring', score: 5, directive: HIRING_DIRECTIVE, confidence: 'high' }
        : { kind: 'unknown', score: 0, directive: '', confidence: 'high' };
    case 'planning':
      return {
        kind: 'planning',
        score: 2,
        directive: buildPlanningDirective({ isBug: false, multipleSignals: false, isOrchestrator }),
        confidence: 'high',
      };
    case 'bug':
      return {
        kind: 'bug-investigation',
        score: 2,
        directive: buildPlanningDirective({ isBug: true, multipleSignals: false, isOrchestrator }),
        confidence: 'high',
      };
    case 'question':
      return { kind: 'pure-question', score: 0, directive: '', confidence: 'high' };
    case 'unknown':
      return { kind: 'unknown', score: 0, directive: '', confidence: 'high' };
  }
}

/**
 * Classificação barata no modelo local. NUNCA lança (delega a `runLocalPhase`).
 * Retorna o rótulo validado ou `null` (modelo ausente, timeout, output fora do
 * enum) → o caller mantém o resultado do regex.
 */
async function classifyIntentLocally(content: string): Promise<LocalIntentLabel | null> {
  const result = await runLocalPhase<LocalIntentLabel>(getSmartExecConfig(), {
    scope: 'intent_detection',
    system:
      'You classify the intent of a chat message sent to a software engineering agent. ' +
      'The message may be in English or Portuguese. Respond ONLY with a JSON object ' +
      `{"intent": "<label>"} where <label> is exactly one of: ${LOCAL_INTENT_LABELS.join(', ')}. ` +
      'Definitions: "planning" = asks to build/implement/plan/refactor a feature or task; ' +
      '"bug" = reports a defect/error/crash/broken behavior to investigate or fix; ' +
      '"question" = a conceptual question expecting an explanation, no work to track; ' +
      '"hiring" = asks to propose/assemble a team or squad of agents; ' +
      '"unknown" = none of the above (greeting, small talk, status check). No prose.',
    user: content.slice(0, 2000),
    parse: (raw) => {
      const obj = parseFirstJsonObject(raw);
      const picked = typeof obj?.intent === 'string' ? obj.intent.toLowerCase().trim() : '';
      return (LOCAL_INTENT_LABELS as readonly string[]).includes(picked)
        ? (picked as LocalIntentLabel)
        : null;
    },
  });
  return result?.value ?? null;
}

/**
 * Versão assíncrona com FALLBACK do modelo local.
 *
 * 1. Roda o caminho regex (`detectIntent`). Se `confidence: 'high'` → retorna
 *    imediatamente (caso comum, ZERO custo de modelo).
 * 2. Se `confidence: 'low'` (regex não achou nada / ambíguo), consulta o cache
 *    por-mensagem e, na ausência, classifica no modelo local. Em sucesso, mapeia
 *    pro mesmo `IntentSignal`/diretiva do caminho regex.
 * 3. FAIL-SAFE: qualquer falha do modelo (ausente/timeout/output inválido) →
 *    mantém o resultado do regex. O fluxo feliz nunca regride.
 *
 * Mensagens vazias/triviais (curtas demais) nem chamam o modelo.
 */
export async function detectIntentWithFallback(
  content: string,
  isOrchestrator: boolean,
): Promise<IntentSignal> {
  const fast = detectIntent(content, isOrchestrator);
  if (fast.confidence === 'high') return fast;

  // Mensagem muito curta não carrega intent acionável — não vale acordar o
  // modelo (e o caso comum "ok"/"obrigado" fica instantâneo).
  if (content.trim().length < 12) return fast;

  const key = cacheKey(content, isOrchestrator);
  const cached = intentCache.get(key);
  if (cached) return cached;

  let label: LocalIntentLabel | null = null;
  try {
    label = await classifyIntentLocally(content);
  } catch {
    // runLocalPhase já é fail-safe, mas blindamos contra qualquer erro síncrono
    // inesperado (ex.: config) — nunca derruba o envio da mensagem.
    label = null;
  }

  if (!label || label === 'unknown') {
    // Modelo indisponível, inconclusivo, ou confirmou "sem intent": fica com o
    // regex. Cacheia mesmo assim pra não re-tentar o modelo na mesma mensagem.
    return cacheSet(key, fast);
  }

  const resolved = signalFromLocalLabel(label, isOrchestrator);
  trace({
    level: 'success',
    source: 'forge',
    scope: 'intent_detection',
    message: `intent recuperado pelo modelo local: ${label} (regex tinha falhado)`,
  });
  return cacheSet(key, resolved);
}
