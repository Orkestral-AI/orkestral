import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { qaValidationRepo, type QaCheckPlanInput } from '../db/repositories/qa-validation.repo';
import { IssueRepository } from '../db/repositories/issue.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import type {
  Agent,
  Issue,
  IssueMetadata,
  IssueStatus,
  QaValidation,
  QaValidationCheckStatus,
} from '../../shared/types';

const issueRepo = new IssueRepository();
const agentRepo = new AgentRepository();

export interface QaBuildGateResult {
  /** true se um comando de build/typecheck foi DETECTADO e rodado. */
  ran: boolean;
  /** true se o build passou (exit 0). Só significativo quando `ran`. */
  ok: boolean;
  /** comando rodado (ex.: "npm run build"). */
  command: string;
  /** cauda do output (erro), pra colar no veredito. */
  output: string;
}

/**
 * GATE DE BUILD DETERMINÍSTICO — a prova que o agente NÃO pode fabricar. A QA escrevia
 * "PASS" sem rodar nada (entrega oca passava verde). Aqui o SISTEMA roda o build de
 * verdade e lê o exit code; se falhar, o veredito vira REPROVADO por mais que o agente
 * jure que passou. Detecta `npm run build` (se houver script), senão `tsc --noEmit`.
 * Best-effort: nunca lança. Sem comando detectável → ran:false (não inventa veredito).
 */
export function runQaBuildGate(repoPath: string | null | undefined): QaBuildGateResult {
  const none: QaBuildGateResult = { ran: false, ok: false, command: '', output: '' };
  if (!repoPath || !existsSync(repoPath)) return none;
  let command = '';
  try {
    const pkgPath = join(repoPath, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.build) command = 'npm run build';
      else if (pkg.scripts?.typecheck) command = 'npm run typecheck';
    }
    if (!command && existsSync(join(repoPath, 'tsconfig.json'))) command = 'npx --yes tsc --noEmit';
    if (!command) return none;
    execSync(command, {
      cwd: repoPath,
      // 20min: greenfield FRIO (npm install + 1º build do Next) é lento; um teto curto
      // reprovaria entrega VÁLIDA por timeout (falso-negativo), não por erro real.
      timeout: 20 * 60 * 1000,
      stdio: 'pipe',
      env: { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1' },
    });
    return { ran: true, ok: true, command, output: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'build falhou';
    // Cauda do erro (o começo do build é ruído; o erro real vem no fim).
    return { ran: true, ok: false, command, output: out.slice(-1500) };
  }
}

/**
 * Rotas Next.js ÓRFÃS: `route.ts`/`page.tsx` FORA de `app/` (ou `src/app/`) NÃO são
 * roteadas pelo Next — o `npm run build` PASSA (o Next simplesmente ignora o arquivo), mas
 * a rota não existe. Foi o caso real: `route.ts` na raiz, `config/route.ts`,
 * `sessions/route.ts`, `widgets/route.ts`. Nem o build-gate nem o phantom-done pegam (o
 * arquivo até existe). Aqui pegamos: lista os órfãos pra a QA reprovar. Só em projeto Next.
 */
export function findOrphanedNextRoutes(repoPath: string | null | undefined): string[] {
  if (!repoPath || !existsSync(repoPath)) return [];
  const isNext = ['next.config.js', 'next.config.ts', 'next.config.mjs'].some((f) =>
    existsSync(join(repoPath, f)),
  );
  if (!isNext) return [];
  const ROUTE_FILE = /^(route|page)\.(t|j)sx?$/;
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'public']);
  const orphans: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 7 || orphans.length >= 25) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP.has(name)) continue;
      const abs = join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(abs, childRel, depth + 1);
      else if (ROUTE_FILE.test(name) && !/^(app|src\/app)\//.test(childRel)) {
        orphans.push(childRel);
      }
    }
  };
  walk(repoPath, '', 0);
  return orphans;
}

export function isQaAgent(agent: Agent | null | undefined): boolean {
  if (!agent) return false;
  return /\bqa\b|quality|test[-\s_]?engineer/.test(
    `${agent.role} ${agent.name} ${agent.title ?? ''}`.toLowerCase(),
  );
}

export function findQaAgent(workspaceId: string): Agent | null {
  return (
    agentRepo
      .listByWorkspace(workspaceId)
      .find((agent) => isQaAgent(agent) && agent.status !== 'paused') ?? null
  );
}

export function shouldRouteIssueThroughQa(issue: Issue, executor: Agent | null): boolean {
  if (!executor || isQaAgent(executor) || executor.isOrchestrator) return false;
  const key = `${executor.role} ${executor.name} ${executor.title ?? ''}`.toLowerCase();
  if (/code[-\s_]?review|reviewer|tech[-\s_]?lead|architect|lead/.test(key)) return false;
  if (issue.labels.some((label) => label.toLowerCase() === 'skip-qa')) return false;
  return true;
}

export function buildQaCheckPlan(issue: Issue): QaCheckPlanInput[] {
  const labels = issue.labels.map((label) => label.toLowerCase());
  const text = `${issue.title}\n${issue.description ?? ''}\n${labels.join(' ')}`.toLowerCase();
  const affectedFiles = Array.isArray(
    (issue.metadata as { affectedFiles?: unknown })?.affectedFiles,
  )
    ? ((issue.metadata as { affectedFiles?: string[] }).affectedFiles ?? [])
    : [];
  const filesText = affectedFiles.join(' ').toLowerCase();
  const isFrontend = /front|ui|ux|component|button|layout|css|tailwind|react|next|mobile|app/.test(
    `${text} ${filesText}`,
  );
  const isBackend =
    /back|api|endpoint|controller|service|database|migration|dto|request|response|php|node/.test(
      `${text} ${filesText}`,
    );
  const isDesign =
    /design|visual|color|cor|spacing|button|bot[aã]o|layout|responsive|responsivo|a11y|accessibility/.test(
      `${text} ${filesText}`,
    );
  const isTest = /test|spec|e2e|playwright|vitest|jest|phpunit|smoke/.test(`${text} ${filesText}`);

  const checks: QaCheckPlanInput[] = [
    {
      kind: 'scope',
      title: 'Entender objetivo e escopo da issue',
      description:
        'Compare a descrição da issue com o diff gerado. Confirme se o executor resolveu exatamente o pedido, sem mudança lateral ou refactor não solicitado.',
      commandHint: 'Leia get_issue, comentários recentes e git diff/status do source alvo.',
    },
    {
      kind: 'knowledge',
      title: 'Consultar padrões do projeto na Knowledge Base',
      description:
        'Use kb_search e Repo Intelligence para buscar padrões, decisões anteriores, design system, contratos e comandos de verificação aplicáveis.',
      commandHint:
        'kb_search com título da issue, arquivos alterados, componente/endpoint e labels.',
    },
    {
      kind: 'diff',
      title: 'Auditar arquivos alterados',
      description:
        'Leia os arquivos tocados e valide se a mudança é mínima, legível, consistente com a arquitetura e sem artefatos de debug.',
      commandHint:
        affectedFiles.length > 0 ? `Arquivos-alvo: ${affectedFiles.join(', ')}` : 'git diff',
    },
  ];

  if (isFrontend || isDesign) {
    checks.push(
      {
        kind: 'design-system',
        title: 'Validar design system e consistência visual',
        description:
          'Confirme tokens, componentes reutilizados, cores, radius, espaçamento, estados de botão/input e que a mudança não cria padrão visual isolado.',
        commandHint: 'Inspecione componentes/tokens existentes e compare com o diff.',
      },
      {
        kind: 'ui-smoke',
        title: 'Provar que BUILDA e RENDERIZA (gate obrigatório)',
        description:
          'OBRIGATÓRIO para frontend: rode `npm run build` (ou o build da stack) — se FALHAR, o veredito é REPROVADO e cole o erro. Confirme que a tela é alcançável na ROTA esperada (ex.: Next.js App Router → arquivo em `app/...`, NUNCA órfão na raiz) e que de fato renderiza (sem stub/placeholder vazio nem link pra rota inexistente). Verifique estados principais, responsividade e que textos não quebram o layout. Um build quebrado ou uma rota que não renderiza NÃO passa.',
        commandHint:
          'npm run build (DEVE passar); confira que os arquivos de rota estão sob app/; abra a rota (dev/preview ou Playwright) e veja renderizar.',
      },
      {
        kind: 'accessibility',
        title: 'Checar acessibilidade básica',
        description:
          'Valide foco, labels, contraste provável, semântica de botão/link/input e navegação básica por teclado quando a mudança afeta UI.',
        commandHint:
          'Inspeção manual + componentes existentes; Playwright/accessibility se disponível.',
      },
    );
  }

  if (isBackend) {
    checks.push(
      {
        kind: 'contract',
        title: 'Validar contrato backend/frontend',
        description:
          'Se endpoint, DTO, status code ou payload mudou, confirme consumidores frontend/mobile e compatibilidade de autenticação/erro.',
        commandHint: 'Busque chamadas do endpoint/tipo no frontend/mobile e compare payloads.',
      },
      {
        kind: 'data-safety',
        title: 'Validar persistência e segurança',
        description:
          'Confira migrations, validação de input, auth, tratamento de erro, logs sensíveis e risco de quebra em dados existentes.',
        commandHint: 'composer test/phpunit, npm test ou testes de serviço quando existirem.',
      },
    );
  }

  checks.push({
    kind: 'automated-tests',
    title: 'Rodar verificações automatizadas disponíveis',
    description:
      'Execute o menor conjunto confiável de lint/typecheck/unit/build relacionado à mudança. Se não existir comando, registre explicitamente a lacuna.',
    commandHint: isTest
      ? 'Rode o teste específico alterado e a suíte relacionada.'
      : 'npm run typecheck/lint/test/build, composer test, pytest, go test conforme scripts do source.',
  });

  checks.push({
    kind: 'verdict',
    title: 'Emitir veredito de QA com evidência',
    description:
      'Marque passed somente se todos os checks críticos passaram. Se falhar, explique exatamente o que o executor deve corrigir e reatribua a issue.',
    commandHint: 'qa_complete_validation + comment_on_issue + update_issue_status/assign_issue.',
  });

  return checks;
}

export function beginQaValidation(input: {
  issue: Issue;
  executorAgentId: string | null;
  qaAgentId: string | null;
}): QaValidation {
  const existing = qaValidationRepo.latestForIssue(input.issue.id);
  if (existing && existing.status !== 'passed' && existing.status !== 'failed') return existing;

  const validation = qaValidationRepo.create({
    workspaceId: input.issue.workspaceId,
    issueId: input.issue.id,
    executorAgentId: input.executorAgentId,
    qaAgentId: input.qaAgentId,
    checks: buildQaCheckPlan(input.issue),
  });

  issueRepo.addComment({
    issueId: input.issue.id,
    body: renderQaPlanComment(validation),
    authorKind: 'system',
  });

  return validation;
}

export function getLatestQaValidation(issueId: string): QaValidation | null {
  return qaValidationRepo.latestForIssue(issueId);
}

/**
 * Resolve uma validação por id SÓ se ela pertencer ao workspace dado. Usado
 * pelas MCP tools de QA pra impedir um agente do workspace A de atualizar/
 * finalizar uma validação do workspace B só passando o UUID dela.
 */
export function getQaValidationScoped(
  workspaceId: string,
  validationId: string,
): QaValidation | null {
  const validation = qaValidationRepo.get(validationId);
  if (!validation || validation.workspaceId !== workspaceId) return null;
  return validation;
}

export function updateQaCheck(input: {
  validationId: string;
  ordinal: number;
  status: QaValidationCheckStatus;
  evidence?: string | null;
}): QaValidation {
  qaValidationRepo.updateCheck(input);
  const validation = qaValidationRepo.get(input.validationId);
  if (!validation) throw new Error('Validação QA não encontrada.');
  if (validation.status === 'planned') {
    return qaValidationRepo.updateStatus({ validationId: input.validationId, status: 'running' });
  }
  return validation;
}

export function completeQaValidation(input: {
  validationId: string;
  status: 'passed' | 'failed' | 'needs_human';
  summary: string;
}): QaValidation {
  return qaValidationRepo.updateStatus(input);
}

export function buildQaVerdictIssueTransition(input: {
  issue: Issue;
  validation: QaValidation;
  status: 'passed' | 'failed' | 'needs_human';
  summary: string;
  executorName?: string | null;
  qaName?: string | null;
}): {
  patch: {
    status: IssueStatus;
    assigneeAgentId?: string | null;
    metadata: IssueMetadata;
  };
  visibilityComment: string;
} {
  const metadata = {
    ...((input.issue.metadata as Record<string, unknown> | null) ?? {}),
    qaLastVerdict: {
      validationId: input.validation.id,
      status: input.status,
      summary: input.summary,
      executorAgentId: input.validation.executorAgentId,
      qaAgentId: input.validation.qaAgentId,
      decidedAt: new Date().toISOString(),
    },
  };
  const executorName = input.executorName?.trim() || 'executor original';
  const qaName = input.qaName?.trim() || 'QA';

  if (input.status === 'failed') {
    return {
      patch: {
        status: 'todo',
        assigneeAgentId: input.validation.executorAgentId ?? input.issue.assigneeAgentId,
        metadata,
      },
      visibilityComment: [
        `🔁 **QA reprovou e devolveu para @${executorName}.**`,
        '',
        input.summary,
        '',
        'A issue voltou para a fila do executor original com o contexto do QA preservado nos comentários e checks.',
      ].join('\n'),
    };
  }

  if (input.status === 'needs_human') {
    return {
      patch: {
        status: 'blocked',
        assigneeAgentId: input.validation.qaAgentId ?? input.issue.assigneeAgentId,
        metadata,
      },
      visibilityComment: [
        `🧭 **${qaName} pausou a validação para decisão humana.**`,
        '',
        input.summary,
        '',
        'A execução foi bloqueada para evitar aprovar ou corrigir sem insumo suficiente.',
      ].join('\n'),
    };
  }

  return {
    patch: {
      status: 'done',
      metadata,
    },
    visibilityComment: [
      `✅ **${qaName} aprovou a validação QA.**`,
      '',
      input.summary,
      '',
      'Os checks críticos passaram com evidência; a entrega pode seguir para a próxima revisão ou conclusão.',
    ].join('\n'),
  };
}

export function renderQaPlanComment(validation: QaValidation): string {
  return [
    '🧪 **QA Validation iniciado**',
    '',
    'O QA vai validar esta entrega passo a passo antes da conclusão:',
    '',
    ...validation.checks.map(
      (check) =>
        `${check.ordinal}. **${check.title}** — ${check.description}${
          check.commandHint ? `\n   _Evidência esperada:_ ${check.commandHint}` : ''
        }`,
    ),
    '',
    'A issue só deve virar `done` depois do QA registrar evidências e veredito.',
  ].join('\n');
}

export function renderQaRuntimeBlock(validation: QaValidation): string {
  return [
    '## QA VALIDATION PLAN',
    '',
    `Validation ID: ${validation.id}`,
    '',
    ...validation.checks.map(
      (check) =>
        `${check.ordinal}. [${check.status}] ${check.title}\n   - ${check.description}${
          check.commandHint ? `\n   - Evidence target: ${check.commandHint}` : ''
        }`,
    ),
  ].join('\n');
}
