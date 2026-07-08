/**
 * Orquestrador da execução inteligente (smart-exec).
 *
 * Fluxo: classificar → escolher modo → (no_llm | local_patch | premium).
 *   - premium_model / no_llm → não tenta local; devolve handled=false (o caller
 *     segue o caminho premium existente).
 *   - local_patch → executor local EXPLORA o repo (se preciso) pra achar alvos,
 *     gera blocos SEARCH/REPLACE por arquivo, e o app os aplica de forma
 *     determinística (morph.ts), valida e, em falha, reverte e escala pro
 *     premium como fallback 1x.
 *
 * Retorna `handled=true` quando concluiu localmente (sem premium). Se
 * `handled=false`, o caller segue o caminho premium existente (executeIssue).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { classifyIssue, detectValidationCommands } from './classifier';
import {
  applyLazyEdit,
  applyMorphEdits,
  applyWholeFile,
  rollbackSnapshot,
  type DiffSnapshot,
} from './diff';
import { warpGrepSearch, findRelevantLines } from './warpgrep';
import { listProjectFiles } from '../engine-v2/repo-context';
import { extractDesignContract } from '../engine-v2/design-system';
import {
  generateLocalEdit,
  generateLocalEditFix,
  generateLocalEditNoBlocksRetry,
  generateLocalEditNoMatchRetry,
  generateLocalWholeFile,
  generateLocalEditRegion,
  generateLocalLineEdit,
  generateLocalFastApply,
  generateLocalDeliverable,
  type LocalEditResult,
  type LocalPatchInput,
} from './local-patcher';
import { parseEditBlocks, hasLazyMarkers, droppedTopLevelImports } from './morph';
import { extractEditableRegion, spliceRegion } from './region';
import { applyLineEdits } from './line-edit';
import { findCreateTemplate } from './create-template';
import { detectDegenerateContent } from './degeneration';
import { runValidation, firstFailure } from './validators';
import { isLocalConfigured, beginRun, endRun, LlamaUnavailableError } from './llama-runtime';
import { trace } from '../log-bus';
import { getRelevantLearnings } from '../kb-learning';
import { getFastApplyModelPath } from '../model-download-service';
import { TaskExecutionRepository } from '../../db/repositories/task-execution.repo';
import { KbPageRepository } from '../../db/repositories/kb-page.repo';
import { buildCapsule } from '../capsule/builder';
import { renderCapsuleGuidance } from '../capsule/render';
import { runAsserts } from '../capsule/contract';
import { scopeViolation } from '../capsule/scope';

const kbPageRepo = new KbPageRepository();
/** Orçamento (chars ~= tokens/4) do plano injetado no Forge — cabe no contexto pequeno. */
const FORGE_PLAN_BUDGET_CHARS = 2800;

/**
 * KB-backed planning no caminho LOCAL: a issue aponta pra uma página de plano detalhada
 * no KB (metadata.planPageId, gravada pelo CEO premium). O Forge tem contexto LIMITADO,
 * então lemos a página DIRETO por id (determinístico — sem busca semântica nem race de
 * indexação de embedding) e truncamos por orçamento. Fallback silencioso se sumiu.
 */
function buildForgePlanBlock(issue: Issue): string {
  const planPageId = (issue.metadata as { planPageId?: string } | null)?.planPageId?.trim();
  if (!planPageId) return '';
  try {
    const md = kbPageRepo.get(planPageId)?.contentMd?.trim();
    if (!md) return '';
    const clipped =
      md.length > FORGE_PLAN_BUDGET_CHARS
        ? md.slice(0, FORGE_PLAN_BUDGET_CHARS) + '\n…(plano truncado — página completa no KB)'
        : md;
    return `\n\n## DETAILED PLAN (authoritative spec — follow precisely)\n${clipped}`;
  } catch {
    return '';
  }
}
import type {
  Issue,
  SmartExecConfig,
  TaskClassification,
  ExecutionMetrics,
  ExecutionPlan,
  ExecutionPlanTask,
  AdapterType,
} from '../../../shared/types';
import { generatePremiumEdit } from './premium-edit';

const recordRepo = new TaskExecutionRepository();

/** Edit aplicado pelo Forge (candidato a virar exemplo do RAG após review). */
export interface SmartAcceptedEdit {
  file: string;
  symbol: string | null;
  instruction: string;
  acceptedEdit: string;
}

export interface SmartOutcome {
  handled: boolean;
  escalate?: string;
  modelUsed: 'local' | 'premium';
  validationResult: 'passed' | 'failed' | 'skipped';
  filesChanged: string[];
  diffSummary: string;
  failureReason: string | null;
  metrics: ExecutionMetrics;
  /** Edits lazy aplicados — persistidos como candidatos do RAG-de-edits. */
  acceptedEdits?: SmartAcceptedEdit[];
  /** Deliverable NON-CODE (Design/QA): texto markdown (spec/relatório), não diff. */
  deliverable?: { kind: 'design' | 'qa'; markdown: string };
  /** Caminho premium_edit já decidiu (sucesso ou escala): NÃO re-tentar local em loop
   *  (o retry com temperatura era pro modelo local fraco; premium é determinístico). */
  skipLocalRetry?: boolean;
}

const NOOP_METRICS: ExecutionMetrics = {
  premiumAvoided: false,
  estimatedPremiumInputTokensAvoided: 0,
  estimatedPremiumOutputTokensAvoided: 0,
  localExecutionUsed: false,
  localRuntime: 'llama.cpp',
};

function issueSourceId(issue: Issue): string | null {
  const meta = issue.metadata as { sourceId?: unknown } | null;
  return typeof meta?.sourceId === 'string' && meta.sourceId.trim() ? meta.sourceId : null;
}

function clampContextPack(text: string): string {
  return text.trim().slice(0, 6000);
}

function buildLocalContextPack(issue: Issue): string {
  const learnings = getRelevantLearnings(
    issue.workspaceId,
    `${issue.title}\n${issue.description ?? ''}`,
    4,
    issueSourceId(issue),
  );
  const parts = [
    '## Retrieved project memory for Forge local',
    learnings || '(no relevant prior memory found)',
  ];
  return clampContextPack(parts.filter(Boolean).join('\n\n'));
}

/** ~4 chars por token (estimativa grosseira pra métricas). */
function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

// Quanto o PREMIUM teria gastado na MESMA tarefa. Um agente premium (Claude Code
// & cia) não gasta só os chars do arquivo que o Forge editou: ele carrega um
// system prompt + definições de ferramentas grandes, EXPLORA o repo (lê arquivos
// vizinhos, roda grep/ls/cat) e RE-ENVIA o contexto crescente a cada turno do loop
// agêntico. Por isso a economia baseada só no footprint local subestimava ~10x.
// Modelamos o footprint real: um piso agêntico fixo + um multiplicador sobre o
// contexto lido (exploração + multi-turn). Conservador, mas perto do que um run
// real consome (dezenas de milhares de tokens por tarefa).
/** Piso de input de um run agêntico premium: system prompt + ferramentas + orientação inicial do repo. */
const PREMIUM_AGENTIC_BASELINE_TOKENS = 9000;
/** Multiplicador do contexto lido localmente (premium relê vizinhos + re-envia a cada turno). */
const PREMIUM_INPUT_CONTEXT_MULTIPLIER = 4;
/** Multiplicador da saída (premium emite raciocínio + tool-calls, não só o diff final). */
const PREMIUM_OUTPUT_MULTIPLIER = 3;

function estimatePremiumInputTokens(localInputChars: number): number {
  return (
    PREMIUM_AGENTIC_BASELINE_TOKENS +
    estimateTokens(localInputChars) * PREMIUM_INPUT_CONTEXT_MULTIPLIER
  );
}
function estimatePremiumOutputTokens(localOutputChars: number): number {
  return estimateTokens(localOutputChars) * PREMIUM_OUTPUT_MULTIPLIER;
}

/**
 * Resolve os ALVOS do CEO em arquivos REAIS. O CEO costuma listar padrões
 * (`app/Services/Flow*`), diretórios (`app/Services/Flow/`) ou caminhos exatos —
 * antes só o caminho exato sobrevivia ao filtro `isFile()` e o resto fazia a
 * issue escalar pro premium ("não encontrou arquivos acionáveis"). Aqui:
 *  - caminho exato de arquivo → mantém;
 *  - diretório → arquivos de código diretos (raso, capado);
 *  - wildcard no basename (`Flow*`) → casa as entradas do diretório-pai.
 * Tudo bounded (cap por padrão) pra não estourar o contexto local.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

const CODE_EXT = /\.(ts|tsx|js|jsx|php|py|rb|go|rs|java|kt|cs|c|cc|cpp|h|hpp|vue|svelte|sql)$/i;
const MAX_FILES_PER_TARGET = 6;
/** Teto de tempo de inferência LOCAL por arquivo (ms). Depois disto o Forge para de
 *  tentar tiers e escala — evita ficar minutos preso num arquivo numa máquina lenta
 *  (timeout soft + best-of-N poderiam encadear muitos calls). 5 min = 1 timeout +
 *  ~1 fallback antes de desistir. */
const FILE_INFERENCE_BUDGET_MS = 300_000;

/** Acima deste tamanho de ARQUIVO (chars), mandar o conteúdo inteiro pro modelo
 *  local prefilla lentíssimo e a inferência ESTOURA o timeout (180s) → escala à toa.
 *  Pra esses, pulamos os tiers de arquivo-inteiro (lazy/line-edit) e vamos DIRETO pra
 *  o tier de REGIÃO, que manda só a função relevante (prompt pequeno, rápido) — o
 *  caminho que o próprio design já chama de seguro pra arquivo grande. Bem abaixo do
 *  teto de contexto (`maxChars` ~97k): o problema é VELOCIDADE, não capacidade. */
const REGION_FIRST_CHARS = 45_000;

/** Limite de arquivo (chars) para o tier FAST-APPLY (merge cheio estilo kortix-ai/
 *  fast-apply): a saída do modelo precisa caber em maxOutputTokens (~4096 tok ≈ 16k
 *  chars); acima disso trunca e a guarda anti-encolhimento rejeita. Logo, só pra
 *  arquivo PEQUENO — exatamente onde a âncora falhava por um detalhe (import/aspas). */
const FAST_APPLY_MAX_CHARS = 12_000;

function resolveTargetFiles(repoPath: string, patterns: string[]): string[] {
  const out = new Set<string>();
  for (const raw of patterns) {
    const rel = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!rel) continue;
    const abs = join(repoPath, rel);
    let resolvedLiteral = false;
    try {
      const st = statSync(abs);
      if (st.isFile()) {
        out.add(rel);
        resolvedLiteral = true;
      } else if (st.isDirectory()) {
        resolvedLiteral = true;
        let n = 0;
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          if (n >= MAX_FILES_PER_TARGET) break;
          if (e.isFile() && CODE_EXT.test(e.name)) {
            out.add(join(rel, e.name));
            n++;
          }
        }
      }
    } catch {
      /* não existe como literal → tenta wildcard abaixo */
    }
    if (!resolvedLiteral && rel.includes('*')) {
      const dir = dirname(rel);
      const re = globToRegExp(basename(rel));
      try {
        let n = 0;
        for (const e of readdirSync(join(repoPath, dir), { withFileTypes: true })) {
          if (n >= MAX_FILES_PER_TARGET) break;
          if (e.isFile() && re.test(e.name)) {
            out.add(dir === '.' ? e.name : join(dir, e.name));
            n++;
          }
        }
      } catch {
        /* diretório-pai não existe → ignora este padrão */
      }
    }
  }
  return [...out];
}

/** Issue de SCAFFOLD/bootstrap de PROJETO (greenfield) — precisa RODAR o CLI oficial
 *  (create-next-app etc.), que o modelo local NÃO executa. Detecção por título/labels. */
export function isScaffoldIssue(issue: Issue): boolean {
  const rawLabels = (issue as { labels?: unknown }).labels;
  const labels = Array.isArray(rawLabels) ? rawLabels.join(' ') : String(rawLabels ?? '');
  const text = `${issue.title ?? ''} ${labels}`.toLowerCase();
  return /\b(scaffold|scaffolding|bootstrap|create-next-app|create-react-app|npx create|(inicializ\w*|criar|iniciar)\s+(o\s+)?projeto|setup\s+(do\s+)?projeto|project\s+setup|novo\s+projeto|new\s+project)\b/.test(
    text,
  );
}

/** O repo já tem um framework instalado? (package.json com next/react/vue/express/…).
 *  Se já tem, a "issue de scaffold" é na verdade um edit normal — não re-escala. */
function hasFrameworkInstalled(repoPath: string): boolean {
  try {
    const pkgPath = join(repoPath, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return [
      'next',
      'react',
      'vue',
      '@angular/core',
      'svelte',
      'nuxt',
      'vite',
      'express',
      'fastify',
    ].some((d) => d in deps);
  } catch {
    return false;
  }
}

function buildPlan(
  issue: Issue,
  cls: TaskClassification,
  cfg: SmartExecConfig,
  capsuleGuidance = '',
): ExecutionPlan {
  // Convergência: numa re-execução pós-review, o comentário corretivo do revisor
  // foi persistido em metadata.reviewFocus. Sem isso a instrução é idêntica à da
  // 1ª tentativa e o modelo local reproduz o mesmo edit errado. Anexa um bloco
  // delimitado de alta prioridade (rótulo em inglês; texto do revisor preservado).
  const reviewFocus = (issue.metadata as { reviewFocus?: string } | null)?.reviewFocus;
  // Cap das partes de tamanho ILIMITADO (review/descrição) — senão a instrução incha e,
  // como o ARQUIVO é clampado mas a instrução não, o modelo pequeno recebe instrução
  // gigante + arquivo cortado. Bounded por prioridade (review é o sinal mais importante).
  const reviewBlock = reviewFocus
    ? `\n\n## REVIEWER REQUESTED CHANGES (do EXACTLY this, highest priority)\n${reviewFocus.slice(0, 2000)}`
    : '';
  // CONTRATO DE EXECUÇÃO: o orquestrador premium grava em metadata.done o critério
  // verificável de "pronto". Anexamos isso a TODA instrução como alvo absoluto — é o
  // que transforma a issue numa ordem executável pelo modelo pequeno (sem ele, o
  // Forge adivinha o escopo e "sai deletando código sem sentido"). O reviewer
  // confere a mudança contra esse mesmo critério.
  const done = (issue.metadata as { done?: string } | null)?.done?.trim();
  const doneBlock = done
    ? `\n\n## DONE — the change is COMPLETE when (verify against this, do nothing beyond it)\n${done}`
    : '';
  const planBlock = buildForgePlanBlock(issue);
  const issueText =
    issue.title + (issue.description ? `\n${issue.description.slice(0, 2500)}` : '');
  const editTasks: ExecutionPlanTask[] = cls.affectedFiles.map((file, i) => ({
    id: `task_${String(i + 1).padStart(3, '0')}`,
    file,
    instruction: issueText + planBlock + capsuleGuidance + reviewBlock + doneBlock,
    allowedActions: ['modify_existing_code', 'add_small_function', 'update_imports'],
    forbiddenActions: [
      'change_public_api',
      'modify_unrelated_files',
      'create_new_architecture',
      'modify_security_sensitive_code',
    ],
    outputFormat: 'unified_diff', // app aplica via SEARCH/REPLACE (morph), não git apply
    maxChangedLines: cfg.thresholds.maxChangedLines,
    validationCommands: cls.validationCommands,
  }));
  // Tasks de CRIAÇÃO: arquivo NOVO, escopo de UM arquivo só, e PROIBIDO mexer em
  // arquivos existentes (a instrução foca no path; o executor usa o caminho de
  // arquivo novo e recusa sobrescrever).
  const createTasks: ExecutionPlanTask[] = cls.createFiles.map((file, i) => ({
    id: `create_${String(i + 1).padStart(3, '0')}`,
    file,
    instruction:
      `CREATE a brand-new file at \`${file}\` ONLY. Do NOT read, edit, reference or ` +
      `touch any existing file. Output only the complete content of this new file.\n\n` +
      `Context (the overall task — implement only the part for THIS file):\n${issueText}${planBlock}${capsuleGuidance}${reviewBlock}${doneBlock}`,
    allowedActions: ['create_new_file'],
    forbiddenActions: [
      'modify_existing_files',
      'overwrite_existing_files',
      'modify_unrelated_files',
    ],
    outputFormat: 'unified_diff',
    maxChangedLines: cfg.thresholds.maxChangedLines,
    validationCommands: cls.validationCommands,
    createNew: true,
  }));
  const tasks: ExecutionPlanTask[] = [...createTasks, ...editTasks];
  return {
    goal: issue.title,
    risk: cls.risk,
    executionMode: cls.executionMode,
    tasks,
    fallbackPolicy: cls.fallbackPolicy,
  };
}

export async function runSmartExecution(
  issue: Issue,
  repoPath: string | undefined,
  cfg: SmartExecConfig,
  runId: string | null,
  // Feedback PROGRESSIVO pro usuário: marcos-chave da execução do Forge viram
  // eventos na timeline da issue (explorar → gerar → reescrever → aplicar).
  onProgress?: (message: string) => void,
  // Adapter/modelo PREMIUM do agente, usados pelo caminho premium_edit (o premium
  // gera o lazy-edit barato). Só claude_local é suportado; ausente, escala.
  premiumAdapter?: AdapterType,
  premiumModel?: string | null,
): Promise<SmartOutcome> {
  const startedAt = Date.now();
  const cls = classifyIssue(issue, { config: cfg, repoPath });

  // OEP/Cápsula: compila a tarefa numa unidade operacional. O guidance (pitfalls
  // APRENDIDOS neste repo + regras do projeto) é injetado na instrução do Forge — é o
  // que faz o modelo convergir o erro em vez de repeti-lo. Os asserts do contrato
  // verificam o resultado no fim, e cada falha vira um novo pitfall (aprendizado).
  const capsule = buildCapsule(issue, cls);
  const capsuleGuidance = renderCapsuleGuidance(capsule);

  // OEP segurança (enforce REAL, não só dito no prompt): se algum alvo tocaria ÁREA
  // SENSÍVEL (migrations/auth/secret/.env), o Forge local NÃO mexe — escala pro premium,
  // que decide com cuidado. O modelo só produz texto e o app aplica por task.file, então
  // checar os alvos cobre o caso real de fora-de-escopo.
  for (const t of capsule.targets) {
    const viol = scopeViolation(capsule, t.file);
    if (viol && viol.startsWith('caminho bloqueado')) {
      return escalateOutcome(
        `Alvo em área sensível fora do alcance do Forge (${viol}) — o premium decide com cuidado.`,
      );
    }
  }

  // A3 — SCAFFOLD greenfield SEMPRE escala pro premium. O Forge não roda o CLI de
  // scaffold (create-next-app/shadcn init); "resolvia local" escrevendo um package.json
  // pela metade (ex.: só prisma, sem next) e marcava done → TODO o resto do projeto não
  // tinha framework onde aterrissar (raiz do "85% oco que não builda"). Setup de projeto
  // é trabalho do premium com terminal, que scaffolda de verdade e verifica que builda.
  if (repoPath && isScaffoldIssue(issue) && !hasFrameworkInstalled(repoPath)) {
    return escalateOutcome(
      'Setup de projeto greenfield. Essa task precisa RODAR o CLI oficial de scaffold ' +
        '(create-next-app / scaffold_project) pra montar a base do framework e instalar as ' +
        'dependências, e o Forge local gera/edita código mas não executa CLI. O premium ' +
        'scaffolda de verdade a partir do template e confirma que o `npm run build` passa ' +
        'antes das tasks seguintes rodarem em cima dele.',
    );
  }

  trace({
    level: 'info',
    source: 'forge',
    scope: 'classify',
    issueKey: issue.issueKey,
    workspaceId: issue.workspaceId,
    message:
      `risco=${cls.risk} modo=${cls.executionMode} ` +
      `arquivos=[${cls.affectedFiles.join(', ') || '—'}] → ${
        cls.executionMode === 'local_patch' ? 'tentando modelo local' : 'premium'
      }`,
  });

  // ---- EXPLORE: modo local sem arquivos concretos → o Forge explora o repo
  // pra derivar alvos (em vez de escalar pro premium). Bounded e determinístico.
  if (
    cls.executionMode === 'local_patch' &&
    cls.affectedFiles.length === 0 &&
    cls.createFiles.length === 0 &&
    repoPath
  ) {
    trace({
      level: 'info',
      source: 'forge',
      scope: 'explore',
      issueKey: issue.issueKey,
      workspaceId: issue.workspaceId,
      message: 'local: explorando o repositório pra encontrar arquivos-alvo…',
    });
    onProgress?.('Explorando o repositório (warp-grep) pra achar os arquivos-alvo…');
    const found = warpGrepSearch(repoPath, `${issue.title}\n${issue.description ?? ''}`);
    // Candidatos da EXPLORAÇÃO são PALPITES rankeados por relevância. Um arquivo
    // grande demais NÃO pode escalar a issue inteira pro premium (era o bug: o
    // top-candidato gigante matava a run mesmo havendo candidatos menores e bons
    // logo abaixo). Filtramos por tamanho AQUI e seguimos com os que cabem no
    // contexto local, preservando a ordem de relevância. Arquivos EXPLÍCITOS no
    // título seguem outra regra (o loop abaixo ainda escala se forem grandes).
    const maxLocalChars = cfg.local.maxPromptTokens * 4 - 1500;
    const fitting: string[] = [];
    let droppedForSize = 0;
    for (const rel of found.files) {
      let size = Number.POSITIVE_INFINITY;
      try {
        size = statSync(join(repoPath, rel)).size;
      } catch {
        /* ilegível → trata como inapto */
      }
      if (size <= maxLocalChars) fitting.push(rel);
      else droppedForSize++;
    }
    cls.affectedFiles = fitting;
    // Os comandos de validação foram computados no classify contra os arquivos
    // ORIGINAIS (vazio aqui). Recompute contra os arquivos REALMENTE explorados
    // pra o syntax-check por linguagem engatar nos paths que vão ser editados.
    cls.validationCommands = detectValidationCommands(repoPath, cls.affectedFiles);
    trace({
      level: fitting.length > 0 ? 'success' : 'warn',
      source: 'forge',
      scope: 'explore',
      issueKey: issue.issueKey,
      workspaceId: issue.workspaceId,
      message:
        fitting.length > 0
          ? `local: explorei ${found.scanned} arquivos · candidatos=[${fitting.join(', ')}]` +
            (droppedForSize > 0 ? ` · ${droppedForSize} ignorado(s) por tamanho` : '')
          : found.files.length > 0
            ? `local: ${found.files.length} candidato(s) grandes demais pro contexto local → premium 1x`
            : `local: exploração não achou alvos (keywords=[${found.keywords.join(', ')}]) → premium 1x`,
    });
  }

  const plan = buildPlan(issue, cls, cfg, capsuleGuidance);

  const record = (
    over: Partial<Parameters<TaskExecutionRepository['insert']>[0]> & {
      modelUsed: SmartOutcome['modelUsed'];
      validationResult: SmartOutcome['validationResult'];
    },
  ): void => {
    try {
      recordRepo.insert({
        issueId: issue.id,
        runId,
        workspaceId: issue.workspaceId,
        executionMode: cls.executionMode,
        risk: cls.risk,
        filesChanged: [],
        diffSummary: '',
        fallbackUsed: false,
        attempts: 0,
        durationMs: Date.now() - startedAt,
        metrics: NOOP_METRICS,
        plan,
        ...over,
      });
    } catch (err) {
      console.warn('[smart-exec] falha ao registrar execução:', err);
    }
  };

  // ---- premium_model / no_llm: não tenta local; deixa o caminho premium rodar.
  if (cls.executionMode === 'premium_model' || cls.executionMode === 'no_llm') {
    record({ modelUsed: 'premium', validationResult: 'skipped', failureReason: cls.reason });
    return {
      handled: false,
      escalate: cls.reason,
      modelUsed: 'premium',
      validationResult: 'skipped',
      filesChanged: [],
      diffSummary: '',
      failureReason: null,
      metrics: NOOP_METRICS,
    };
  }

  // ---- local_deliverable: Design/QA NÃO geram patch. O modelo local escreve um
  // TEXTO (spec de design / relatório de QA) que vira o comentário da issue.
  // Retorna handled:true com filesChanged:[] — NÃO passa pelo guard de 0 edições
  // (que bloquearia, o erro de categoria). A issue vai pra in_review (revisão humana).
  if (cls.executionMode === 'local_deliverable') {
    if (!isLocalConfigured(cfg.local)) {
      record({
        modelUsed: 'premium',
        validationResult: 'skipped',
        failureReason: 'modelo local não empacotado',
      });
      return escalateOutcome('Modelo local não empacotado neste build → premium.');
    }
    const kind = cls.deliverableKind ?? 'design';
    onProgress?.(
      kind === 'design' ? 'Escrevendo a especificação de design…' : 'Escrevendo o relatório de QA…',
    );
    beginRun();
    let text = '';
    try {
      text = await generateLocalDeliverable(cfg, {
        kind,
        title: issue.title,
        description: issue.description ?? '',
        done: (issue.metadata as { done?: string } | null)?.done ?? null,
        contextPack: buildLocalContextPack(issue),
      });
    } finally {
      endRun(cfg.local);
    }
    if (!text || /^CANNOT_/i.test(text)) {
      record({
        modelUsed: 'local',
        validationResult: 'skipped',
        failureReason: 'deliverable de design/QA vazio',
      });
      return escalateOutcome('O modelo local não produziu o deliverable de design/QA.');
    }
    record({ modelUsed: 'local', validationResult: 'skipped', filesChanged: [] });
    return {
      handled: true,
      modelUsed: 'local',
      validationResult: 'skipped',
      filesChanged: [],
      diffSummary: text,
      failureReason: null,
      metrics: NOOP_METRICS,
      deliverable: { kind, markdown: text },
    };
  }

  // ---- premium_edit: caminho BARATO de edição. O premium gera um lazy-edit COMPACTO
  // por arquivo (1 call `claude --print`, SEM MCP nem reler o repo) e o app aplica
  // determinístico (morph/lazy; fast-apply local como fallback de merge). Em QUALQUER
  // falha escala pro run premium COMPLETO. É o que faz o fast-apply economizar de
  // verdade: troca o agente premium inteiro (caro) por 1 geração compacta + apply local.
  if (cls.executionMode === 'premium_edit') {
    const escalatePE = (reason: string): SmartOutcome => ({
      ...escalateOutcome(reason),
      skipLocalRetry: true,
    });
    if (!repoPath) {
      record({ modelUsed: 'premium', validationResult: 'skipped', failureReason: 'sem repo' });
      return escalatePE('Sem diretório de trabalho → run premium completo.');
    }
    // generatePremiumEdit só suporta claude_local; qualquer outro adapter → run completo.
    if (premiumAdapter !== 'claude_local') {
      record({
        modelUsed: 'premium',
        validationResult: 'skipped',
        failureReason: 'adapter não-claude',
      });
      return escalatePE('premium_edit só com Claude (claude_local) → run premium completo.');
    }
    const peSnapshots: DiffSnapshot[] = [];
    const peChanged: string[] = [];
    const peRollback = (): void => {
      for (const s of peSnapshots.reverse()) rollbackSnapshot(repoPath, s);
    };
    const peTargets = resolveTargetFiles(repoPath, cls.affectedFiles);
    if (peTargets.length === 0) {
      record({
        modelUsed: 'premium',
        validationResult: 'skipped',
        failureReason: 'sem alvos concretos',
      });
      return escalatePE('Sem arquivos-alvo concretos pro edit barato → run premium completo.');
    }
    const peInstruction = `${issue.title}\n\n${issue.description ?? ''}`.trim();
    const peConstraints = {
      maxChangedLines: cfg.thresholds.maxChangedLines,
      allowedFiles: peTargets,
      forbiddenFiles: cfg.criticalGlobs,
      allowNewFiles: false,
      allowPublicApiChanges: false,
      allowArchitectureChanges: false,
    };
    // Mesma lógica robusta de apply do caminho local: tenta o tier que casa o formato
    // (lazy `// ... existing code ...` ou blocos SEARCH/REPLACE) e depois o outro.
    const peApply = (file: string, update: string): ReturnType<typeof applyLazyEdit> => {
      const blocks = parseEditBlocks(update);
      const preferBlocks = !hasLazyMarkers(update) && blocks.length > 0;
      const lazy = (): ReturnType<typeof applyLazyEdit> => applyLazyEdit(repoPath, file, update);
      const morph = (): ReturnType<typeof applyMorphEdits> =>
        blocks.length > 0
          ? applyMorphEdits(repoPath, file, blocks)
          : { applied: false, changedLines: 0, error: 'sem blocos SEARCH/REPLACE' };
      const first = preferBlocks ? morph() : lazy();
      if (first.applied && first.snapshot) return first;
      const second = preferBlocks ? lazy() : morph();
      if (second.applied && second.snapshot) return second;
      return preferBlocks ? second : first;
    };
    const faPath = getFastApplyModelPath();
    try {
      for (const file of peTargets) {
        const abs = join(repoPath, file);
        if (!existsSync(abs)) {
          peRollback();
          return escalatePE(`Alvo ${file} não existe → run premium completo.`);
        }
        const fileContent = readFileSync(abs, 'utf-8');
        onProgress?.(`Gerando edit barato de ${file}…`);
        const peInput: LocalPatchInput = {
          taskId: file,
          filePath: file,
          instruction: peInstruction,
          goal: issue.title,
          constraints: peConstraints,
          fileContent,
        };
        const edit = await generatePremiumEdit(cfg, peInput, premiumAdapter, premiumModel ?? null);
        if (edit.kind !== 'edit') {
          peRollback();
          return escalatePE(`Premium não gerou o lazy-edit de ${file} → run premium completo.`);
        }
        let applied = peApply(file, edit.update);
        // Fast-apply (o "morph" próprio): se a âncora do lazy-edit não casa, o modelo
        // DEDICADO funde o trecho no arquivo inteiro. Só se o modelo existe e o arquivo
        // é pequeno (rajada barata); senão, escala.
        if (
          (!applied.applied || !applied.snapshot) &&
          faPath &&
          fileContent.length <= FAST_APPLY_MAX_CHARS
        ) {
          const fa = await generateLocalFastApply(cfg, peInput, edit.update, faPath);
          if (fa.kind === 'edit') applied = applyWholeFile(repoPath, file, fa.update);
        }
        if (!applied.applied || !applied.snapshot) {
          peRollback();
          return escalatePE(`Não foi possível aplicar o edit em ${file} → run premium completo.`);
        }
        peSnapshots.push(applied.snapshot);
        peChanged.push(file);
        onProgress?.(`Aplicado em ${file} (${applied.changedLines} linha(s))`);
      }
      // Valida (syntax-check por linguagem). Falhou → reverte TUDO e escala pro completo.
      const peCmds = detectValidationCommands(repoPath, peChanged);
      if (peCmds.length > 0) {
        const result = await runValidation(repoPath, peCmds, cfg.local.timeoutMs);
        if (!result.passed) {
          peRollback();
          return escalatePE(
            `Validação falhou (${firstFailure(result) ?? '?'}) → run premium completo.`,
          );
        }
      }
      if (peChanged.length === 0) {
        peRollback();
        return escalatePE('Nenhum arquivo mudou → run premium completo.');
      }
      const peDiff = `${peChanged.length} arquivo(s) editado(s) barato (premium_edit): ${peChanged.join(', ')}`;
      record({
        modelUsed: 'premium',
        validationResult: peCmds.length > 0 ? 'passed' : 'skipped',
        filesChanged: peChanged,
        diffSummary: peDiff,
      });
      return {
        handled: true,
        modelUsed: 'premium',
        validationResult: peCmds.length > 0 ? 'passed' : 'skipped',
        filesChanged: peChanged,
        diffSummary: peDiff,
        failureReason: null,
        metrics: NOOP_METRICS,
        skipLocalRetry: true,
      };
    } catch (err) {
      peRollback();
      return escalatePE(
        `Erro no edit barato: ${err instanceof Error ? err.message : String(err)} → run premium completo.`,
      );
    }
  }

  // ---- local_patch
  if (!repoPath) {
    record({ modelUsed: 'premium', validationResult: 'skipped', failureReason: 'sem repo' });
    return escalateOutcome('Sem diretório de trabalho pra aplicar patch local.');
  }
  if (!isLocalConfigured(cfg.local)) {
    record({
      modelUsed: 'premium',
      validationResult: 'skipped',
      failureReason: 'modelo local não empacotado',
    });
    return escalateOutcome('Modelo local não empacotado neste build → premium.');
  }
  // Resolve os alvos do CEO em arquivos REAIS antes de tentar: padrões
  // (`app/Services/Flow*`), diretórios (`app/Services/Flow/`) e caminhos exatos
  // viram a lista concreta de arquivos editáveis. Antes só o caminho exato
  // sobrevivia (statSync isFile) e wildcard/diretório escalavam à toa.
  // Create-tasks (arquivo NOVO) NÃO passam pelo resolveTargetFiles: o arquivo
  // ainda não existe, então o resolve as dropparia (e o `...sample` reconstruía
  // tudo a partir da 1ª task, espalhando createNew:true pros arquivos resolvidos
  // → o loop pulava todos como "create cujo alvo já existe" → 0 edições/bloqueio).
  // Só os alvos de EDIÇÃO (existentes) são resolvidos (diretório/glob → arquivos
  // concretos); as create-tasks são preservadas intactas.
  const createTasks = plan.tasks.filter((tk) => tk.createNew);
  const editTasks = plan.tasks.filter((tk) => !tk.createNew);
  const resolvedFiles =
    editTasks.length > 0
      ? resolveTargetFiles(
          repoPath,
          editTasks.map((tk) => tk.file),
        )
      : [];
  const resolvedEditTasks =
    resolvedFiles.length > 0
      ? resolvedFiles.map((file, i) => ({
          ...editTasks[0],
          id: `task_${String(i + 1).padStart(3, '0')}`,
          file,
        }))
      : [];
  plan.tasks = [...createTasks, ...resolvedEditTasks];
  cls.affectedFiles = resolvedEditTasks.map((tk) => tk.file);
  if (plan.tasks.length > 0) {
    // Globs/diretórios viraram arquivos concretos; recompute os comandos de
    // validação contra os paths reais (edições + criações) pra o syntax-check
    // por linguagem engatar nos arquivos que serão de fato tocados.
    cls.validationCommands = detectValidationCommands(repoPath, [
      ...cls.affectedFiles,
      ...createTasks.map((tk) => tk.file),
    ]);
  }
  // Sem tarefas concretas → fallback 1x pro premium. Distingue greenfield/scaffold
  // (repo vazio + nenhum arquivo específico a criar) — que é setup com COMANDOS
  // (npm/instalação/scaffold) que o modelo LOCAL não executa, logo é trabalho do
  // agente premium com terminal — de "tinha arquivos mas nada casou". Tarefas que
  // listam arquivos explícitos a criar viram create-tasks e rodam LOCAL (não caem aqui).
  if (plan.tasks.length === 0) {
    const greenfield =
      createTasks.length === 0 && cls.createFiles.length === 0 && cls.affectedFiles.length === 0;
    const reason = greenfield
      ? 'Setup/scaffold sem arquivos específicos pra editar — o premium roda o bootstrap (instalação/comandos) que o Forge local não executa → premium 1x.'
      : 'Exploração local não encontrou arquivos-alvo concretos → premium 1x.';
    record({
      modelUsed: 'premium',
      validationResult: 'skipped',
      fallbackUsed: true,
      failureReason: reason,
    });
    return escalateOutcome(reason);
  }

  // Restrições descritivas pro prompt do executor local.
  const constraints = {
    maxChangedLines: cfg.thresholds.maxChangedLines,
    allowedFiles: cls.affectedFiles,
    forbiddenFiles: cfg.criticalGlobs,
    allowNewFiles: false,
    allowPublicApiChanges: false,
    allowArchitectureChanges: false,
  };

  const snapshots: DiffSnapshot[] = [];
  const filesChanged: string[] = [];
  // Edits lazy aplicados nesta run → candidatos do RAG-de-edits (viram exemplo se
  // o review aprovar). Capturados só dos tiers lazy (formato que o few-shot ensina).
  const acceptedEdits: SmartAcceptedEdit[] = [];
  let attempts = 0;
  let estimatedInputChars = (issue.description ?? '').length + issue.title.length;
  let estimatedOutputChars = 0;
  let contextPack = buildLocalContextPack(issue);
  if (contextPack && !contextPack.includes('(no relevant prior memory found)')) {
    estimatedInputChars += contextPack.length;
    trace({
      level: 'info',
      source: 'forge',
      scope: 'rag',
      issueKey: issue.issueKey,
      workspaceId: issue.workspaceId,
      message: `Forge local recebeu contexto RAG/memória (${contextPack.length} chars)`,
    });
  }
  // GROUNDING (motor por baixo): ANTES de gerar, dá pro Forge o REPO REAL — os arquivos que
  // existem + os componentes do design system — pra ele importar do que existe e NÃO alucinar
  // pacote/UI nova. É o que o gate cobrava depois; aqui a gente previne na fonte. Best-effort.
  try {
    const realFiles = listProjectFiles(repoPath, 60);
    const design = extractDesignContract(repoPath);
    const blocks: string[] = [];
    if (realFiles.length > 0) {
      blocks.push(
        'REAL FILES IN THIS PROJECT (import ONLY from paths that exist here; NEVER invent a package/module):\n' +
          realFiles.map((f) => `- ${f}`).join('\n'),
      );
      // Convenção de estrutura: detecta src/app vs app e MANDA seguir a MESMA. Sem isto o
      // executor cria rota em app/ enquanto o scaffold usou src/app/ → o split quebra metade
      // do app no Next (rotas 404 / layout faltando). É o bug "real mas não monta".
      const usesSrcApp = realFiles.some((f) => f.startsWith('src/app/'));
      const usesRootApp = realFiles.some((f) => f.startsWith('app/'));
      if (usesSrcApp && usesRootApp) {
        // Já está split (o bug). Manda CONSOLIDAR em src/app e apagar o app/ da raiz — pode até
        // auto-curar se a issue mexer nessa área.
        blocks.push(
          'PROJECT STRUCTURE IS SPLIT (BUG): this repo has BOTH `src/app/` and a top-level `app/`. ' +
            'Next.js uses only ONE, so half the routes/pages are dead. CONSOLIDATE everything into ' +
            '`src/app/` (move each `app/...` route to `src/app/api/.../route.ts`) and remove the ' +
            'top-level `app/`. Put all new code under `src/app/`.',
        );
      } else if (usesSrcApp || usesRootApp) {
        const dir = usesSrcApp ? 'src/app' : 'app';
        blocks.push(
          `PROJECT STRUCTURE: this App Router lives in \`${dir}/\`. Put EVERY new page and API route ` +
            `UNDER \`${dir}/\` (routes at \`${dir}/api/.../route.ts\`). NEVER create the other app ` +
            `directory: Next.js uses one OR the other and a split silently breaks half the app.`,
        );
      }
    }
    if (design.frozen && design.components.length > 0) {
      const from =
        design.uiImportPaths.length > 0 ? `, import from ${design.uiImportPaths.join(', ')}` : '';
      blocks.push(
        `UI COMPONENTS AVAILABLE (compose ONLY these${from}; do NOT add a new UI library):\n` +
          design.components.map((c) => `- ${c}`).join('\n'),
      );
    }
    if (blocks.length > 0) {
      contextPack = `${contextPack ? `${contextPack}\n\n` : ''}GROUNDING — the REAL repository (use it; do not hallucinate imports):\n${blocks.join('\n\n')}`;
      trace({
        level: 'info',
        source: 'forge',
        scope: 'grounding',
        issueKey: issue.issueKey,
        workspaceId: issue.workspaceId,
        message: `Grounding: ${realFiles.length} arquivos reais + ${design.components.length} componentes passados ao Forge ANTES de gerar`,
      });
    }
  } catch {
    /* grounding é best-effort; nunca quebra a execução */
  }
  // Forge removido: sem adapter local treinado.
  const loraPath: string | null = null;

  const rollbackAll = (): void => {
    for (const s of snapshots.reverse()) rollbackSnapshot(repoPath, s);
    snapshots.length = 0;
  };

  // Aplica um edit a um arquivo de forma DETERMINÍSTICA (Fast Apply PRÓPRIO do
  // Orkestral, sem serviço externo), tolerando o formato que o modelo pequeno de
  // fato emitiu (morphismo):
  //   1. lazy edit (`// ... existing code ...`) → mergeLazyEdit (formato primário);
  //   2. blocos SEARCH/REPLACE → applyMorphEdits — o Forge às vezes emite ESTE
  //      formato em vez do lazy, e antes isso escalava à toa (bug do P0-13: o
  //      caminho de morphismo SEARCH/REPLACE nunca era tentado antes do premium).
  // Tenta primeiro o tier que casa com o formato detectado e depois o outro tier
  // determinístico. Só devolve falha quando NENHUM applier local casou — aí o
  // caller re-ensina o Forge a reescrever o arquivo inteiro (nunca escala premium).
  // Sempre snapshota (quem aplica é o app, nunca o modelo).
  const applyEditRobust = (file: string, update: string): ReturnType<typeof applyLazyEdit> => {
    const blocks = parseEditBlocks(update);
    const preferBlocks = !hasLazyMarkers(update) && blocks.length > 0;
    const lazy = (): ReturnType<typeof applyLazyEdit> => applyLazyEdit(repoPath, file, update);
    const morph = (): ReturnType<typeof applyMorphEdits> =>
      blocks.length > 0
        ? applyMorphEdits(repoPath, file, blocks)
        : { applied: false, changedLines: 0, error: 'sem blocos SEARCH/REPLACE' };

    const first = preferBlocks ? morph() : lazy();
    if (first.applied && first.snapshot) return first;
    const second = preferBlocks ? lazy() : morph();
    if (second.applied && second.snapshot) return second;
    // Nenhum tier determinístico casou — devolve a falha do tier LAZY (o motivo da
    // âncora é o mais informativo pro rewrite local subsequente).
    return preferBlocks ? second : first;
  };

  // WIN 3 — mantém o modelo QUENTE por toda a run (todos os arquivos desta
  // issue). O idle-unload só rearma depois do endRun no finally.
  beginRun();
  // ORÇAMENTO da RUN INTEIRA: o teto POR ARQUIVO (FILE_INFERENCE_BUDGET_MS) não bounda
  // uma issue com MUITOS arquivos — N × 5min virava 40-45min num run só. Depois deste
  // teto, para de processar arquivos local e ESCALA a issue inteira pro premium CLI (que
  // edita todos de uma vez, direto com tools, e conclui rápido). Falha-rápido global.
  const RUN_BUDGET_MS = 360_000; // 6min
  const runStartedAt = Date.now();
  try {
    for (const task of plan.tasks) {
      if (Date.now() - runStartedAt > RUN_BUDGET_MS) {
        return escalateOutcome(
          `orçamento de tempo da execução local excedido (${Math.round(RUN_BUDGET_MS / 60000)}min) — premium conclui os arquivos restantes`,
        );
      }
      const abs = join(repoPath, task.file);
      // ORÇAMENTO de inferência POR ARQUIVO: com timeout soft (cai pro próximo tier) +
      // best-of-N, uma máquina lenta onde TUDO estoura poderia encadear muitos calls e
      // ficar minutos "travada" num arquivo. Depois deste teto, para de tentar local e
      // escala — falha RÁPIDO em vez de insistir. O 1º tier de cada caminho sempre roda
      // (uma chance); o teto corta as TENTATIVAS extras.
      const fileStartedAt = Date.now();
      const withinFileBudget = (): boolean => Date.now() - fileStartedAt < FILE_INFERENCE_BUDGET_MS;
      // Task de CRIAÇÃO cujo caminho JÁ existe: NUNCA sobrescreve um arquivo
      // existente (era o bug — migration core sendo reescrita). Pula com aviso e
      // segue (o arquivo já está lá; nada a criar).
      if (task.createNew && existsSync(abs)) {
        trace({
          level: 'warn',
          source: 'forge',
          scope: 'generate',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `local: ${task.file} já existe — pulando criação (não sobrescreve arquivo existente)`,
        });
        onProgress?.(`${task.file} já existe — pulando criação`);
        continue;
      }
      if (!existsSync(abs)) {
        // Arquivo NOVO: lazy-edit não tem âncora num arquivo vazio. Em vez de
        // escalar pro premium, o modelo LOCAL escreve o arquivo inteiro e o app
        // grava direto. A validação + rollback abaixo protegem (se quebrar, escala).
        attempts++;
        trace({
          level: 'info',
          source: 'forge',
          scope: 'generate',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `local: criando arquivo novo ${task.file}…`,
        });
        // CONTEXTO TYPE-AWARE: acha um arquivo EXISTENTE similar (mesmo tipo/diretório)
        // como TEMPLATE de estilo/estrutura — o modelo pequeno imita um exemplo real do
        // repo (imports, convenções) em vez de inventar do zero. Decisivo no create de
        // frontend (ex.: novo *Context.tsx olhando outro *Context.tsx).
        // Template PEQUENO (~4 KB): basta mostrar o ESTILO/estrutura. Um template
        // gigante inflava o prompt do create → prefill lento → timeout. Compacto =
        // rápido e ainda ancora o modelo no padrão do repo.
        const templateText = findCreateTemplate(repoPath, task.file, 4000);
        const createInput: LocalPatchInput = {
          taskId: task.id,
          filePath: task.file,
          instruction: task.instruction,
          goal: plan.goal,
          constraints,
          fileContent: '',
          contextPack,
          loraPath,
          templateText: templateText ?? undefined,
        };
        // BEST-OF-N: greedy (temp 0) e depois UMA amostra diversa. Um único hiccup do
        // modelo pequeno NÃO escala mais à toa — só cai pro premium se as duas falharem.
        let w: ReturnType<typeof applyWholeFile> = {
          applied: false,
          changedLines: 0,
          snapshot: undefined,
        };
        for (const temp of [undefined, 0.5] as const) {
          // 1ª tentativa sempre roda; a 2ª (diversa) só dentro do orçamento do arquivo.
          if ((w.applied && w.snapshot) || (temp !== undefined && !withinFileBudget())) break;
          attempts++;
          const created = await generateLocalWholeFile(cfg, createInput, temp);
          if (created.kind !== 'edit') continue;
          // Guard anti-degeneração: descarta saída com import/linha repetida em loop
          // (o caso real: page.tsx de 17KB com o mesmo import ~30x). Tenta o próximo
          // tier/temperatura em vez de gravar lixo que não compila.
          const degen = detectDegenerateContent(created.update, task.file);
          if (degen) {
            trace({
              level: 'warn',
              source: 'forge',
              scope: 'morph',
              issueKey: issue.issueKey,
              workspaceId: issue.workspaceId,
              message: `local: saída degenerada descartada (${task.file}): ${degen}`,
            });
            continue;
          }
          w = applyWholeFile(repoPath, task.file, created.update);
          if (w.applied && w.snapshot) estimatedOutputChars += created.raw.length;
        }
        if (w.applied && w.snapshot) {
          snapshots.push(w.snapshot);
          filesChanged.push(task.file);
          trace({
            level: 'success',
            source: 'forge',
            scope: 'morph',
            issueKey: issue.issueKey,
            workspaceId: issue.workspaceId,
            message: `local: arquivo novo criado ${task.file} (${w.changedLines} linhas)`,
          });
          continue;
        }
        rollbackAll();
        record({
          modelUsed: 'premium',
          validationResult: 'skipped',
          fallbackUsed: true,
          failureReason: `modelo local não gerou o arquivo novo: ${task.file}`,
          attempts,
        });
        // Mensagem HONESTA: o Forge TENTOU criar (o arquivo é novo de propósito), mas o
        // modelo local não conseguiu gerar — NÃO é "o arquivo não existe" (isso confundia:
        // parecia recusa, quando era falha de geração).
        return escalateOutcome(
          `O modelo local não conseguiu gerar o arquivo novo ${task.file} — premium decide.`,
        );
      }
      const fileContent = readFileSync(abs, 'utf-8');
      estimatedInputChars += fileContent.length;

      // Arquivo grande demais pro contexto LOCAL: o modelo local truncaria (perigoso),
      // então pulamos a tentativa local. Como o tamanho excede o contexto, TODOS os
      // tiers locais abaixo já são gated por `!tooLargeForLocal` — não há caminho local
      // possível, então escalamos IMEDIATAMENTE pro premium com o motivo correto (em vez
      // de cair até o fim e reportar "morphismo não casou", que enganava).
      const maxChars = cfg.local.maxPromptTokens * 4 - 1500;
      const tooLargeForLocal = fileContent.length > maxChars;
      // Arquivo GRANDE (mas ainda dentro do contexto): roda local, mas REGIÃO-PRIMEIRO —
      // pula os tiers de arquivo-inteiro que estouram o timeout e vai direto pra função.
      const bigFileForLocal = !tooLargeForLocal && fileContent.length > REGION_FIRST_CHARS;
      if (tooLargeForLocal) {
        rollbackAll();
        record({
          modelUsed: 'premium',
          validationResult: 'skipped',
          fallbackUsed: true,
          failureReason: `arquivo grande demais p/ contexto local (${fileContent.length} chars)`,
          attempts,
        });
        return escalateOutcome(`Arquivo ${task.file} grande demais pro executor local → premium.`);
      }

      // Foco (WarpGrep): linhas mais relevantes do arquivo pro instruction. Dá ao
      // modelo local um norte de ONDE mexer, em vez de se perder no arquivo todo.
      const relevantLines = findRelevantLines(fileContent, task.instruction);
      const focusHint =
        relevantLines.length > 0 ? `lines ${relevantLines.slice(0, 8).join(', ')}` : undefined;

      // Forge removido: sem RAG-de-edits local.
      const examples: never[] = [];

      const input: LocalPatchInput = {
        taskId: task.id,
        filePath: task.file,
        instruction: task.instruction,
        goal: plan.goal,
        constraints,
        fileContent,
        focusHint,
        contextPack,
        loraPath,
        examples,
      };

      // Texto do edit lazy aplicado (se algum tier lazy casar) → candidato do RAG.
      let appliedLazyEdit: string | null = null;

      // Caminho primário: o modelo LOCAL emite o lazy-edit; o app o aplica de forma
      // determinística (morph). Arquivos GRANDES (mas ainda no contexto) pulam este
      // tier de arquivo-inteiro e caem nos tiers de linha/região logo abaixo (os que
      // não cabem no contexto já escalaram no guard `tooLargeForLocal` acima).
      let edit: LocalEditResult = { kind: 'cannot', raw: '' };
      // Arquivo grande → NÃO gera lazy-edit do arquivo inteiro (estoura o timeout):
      // cai pro tier de REGIÃO logo abaixo (prompt pequeno, local, rápido).
      if (!tooLargeForLocal && !bigFileForLocal) {
        attempts++;
        trace({
          level: 'info',
          source: 'forge',
          scope: 'generate',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `local: gerando edit preguiçoso para ${task.file}…`,
        });
        onProgress?.(`Gerando edição em ${task.file}…`);
        edit = await generateLocalEdit(cfg, input);

        // WIN 1 — Retry CORRETIVO: não saiu edit no formato. Em vez de escalar
        // direto, reenfatiza o contrato + reinclui o arquivo UMA vez. Converte a
        // falha mais comum em provável sucesso sem nunca aplicar conteúdo errado
        // (a fusão por âncora em morph.ts rejeita o que não casa).
        if (edit.kind === 'cannot' && !/^CANNOT_PATCH_SAFELY\b/.test(edit.raw)) {
          attempts++;
          trace({
            level: 'info',
            source: 'forge',
            scope: 'generate',
            issueKey: issue.issueKey,
            workspaceId: issue.workspaceId,
            message: `local: retry corretivo (formato) para ${task.file}…`,
          });
          edit = await generateLocalEditNoBlocksRetry(cfg, input);
        }
      }
      if (edit.kind === 'edit') estimatedOutputChars += edit.raw.length;

      // Aplica (determinístico → Morph API). Se as âncoras não casarem, UM retry
      // corretivo local (mostra o arquivo numerado) antes dos tiers locais seguintes.
      let applied =
        edit.kind === 'edit'
          ? applyEditRobust(task.file, edit.update)
          : { applied: false, changedLines: 0, error: 'sem edit válido' as string };
      if (applied.applied && applied.snapshot && edit.kind === 'edit') {
        appliedLazyEdit = edit.update;
      }
      if ((!applied.applied || !applied.snapshot) && edit.kind === 'edit') {
        attempts++;
        trace({
          level: 'info',
          source: 'forge',
          scope: 'generate',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `local: retry corretivo (âncora não casou) para ${task.file}…`,
        });
        const retry: LocalEditResult = await generateLocalEditNoMatchRetry(
          cfg,
          input,
          applied.error ?? 'âncora não casou',
        );
        if (retry.kind === 'edit') {
          estimatedOutputChars += retry.raw.length;
          applied = applyEditRobust(task.file, retry.update);
          if (applied.applied && applied.snapshot) appliedLazyEdit = retry.update;
        }
      }

      // TIER FAST-APPLY (kortix-ai/fast-apply, Apache-2.0): temos um lazy-edit VÁLIDO mas
      // a fusão por âncora não casou (ex.: `import { x }` vs `import x`). Em vez de
      // escalar, o modelo MESCLA o <update> no <code> e devolve o ARQUIVO INTEIRO
      // (<updated-code>) — sem âncora pra errar. Só pra arquivo PEQUENO (a saída tem que
      // caber em maxOutputTokens). Guardas: anti-encolhimento + perda de imports → nunca
      // grava deleção/import-drop silencioso.
      if (
        (!applied.applied || !applied.snapshot) &&
        edit.kind === 'edit' &&
        fileContent.length <= FAST_APPLY_MAX_CHARS &&
        withinFileBudget()
      ) {
        attempts++;
        trace({
          level: 'info',
          source: 'forge',
          scope: 'generate',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `local: fast-apply (merge cheio) para ${task.file}…`,
        });
        // Decisão por PRESENÇA do arquivo (sem detecção de variante): se o fast-apply DEDICADO
        // está em disco, usa-o; senão o PRÓPRIO Forge faz o merge (mesmo prompt FAST_APPLY_SYSTEM,
        // modelPathOverride=null → usa cfg.local.modelPath). O v3 não baixa fast-apply → cai no
        // Forge naturalmente; v1/v2 baixam no onboarding/boot (re-armado a cada launch), e até
        // chegar o Forge cobre o merge.
        const faPath = getFastApplyModelPath();
        onProgress?.(
          faPath
            ? `Forge mesclando o edit em ${task.file} (fast-apply local)…`
            : `Forge mesclando o edit em ${task.file}…`,
        );
        const fa = await generateLocalFastApply(cfg, input, edit.update, faPath);
        if (fa.kind === 'edit' && fa.update !== fileContent) {
          const origN = fileContent.split('\n').length;
          const newN = fa.update.split('\n').length;
          const shrankTooMuch = origN > 8 && newN < origN * 0.6;
          const lostImports = droppedTopLevelImports(fileContent, fa.update);
          if (shrankTooMuch || lostImports) {
            trace({
              level: 'warn',
              source: 'forge',
              scope: 'morph',
              issueKey: issue.issueKey,
              workspaceId: issue.workspaceId,
              message: `fast-apply em ${task.file} ${lostImports ? 'dropou import(s)' : `encolheu ${origN}→${newN} linhas`} — REJEITADO`,
            });
          } else {
            const rapplied = applyWholeFile(repoPath, task.file, fa.update);
            if (rapplied.applied && rapplied.snapshot && rapplied.changedLines > 0) {
              estimatedOutputChars += fa.raw.length;
              applied = rapplied;
              appliedLazyEdit = edit.update;
              trace({
                level: 'success',
                source: 'forge',
                scope: 'morph',
                issueKey: issue.issueKey,
                workspaceId: issue.workspaceId,
                message: `fast-apply mesclou ${rapplied.changedLines} linha(s) em ${task.file}`,
              });
            }
          }
        }
      }

      // RECUPERAÇÃO 100% LOCAL — TIER ANCORADO POR LINHA (antes da região): o modelo
      // recebe o arquivo NUMERADO e escolhe QUAIS linhas mexer por NÚMERO (@@REPLACE
      // a-b / @@INSERT n) — não há âncora de texto pra errar, que é a causa #1 de
      // "âncora não casou". O app funde determinístico por nº de linha (applyLineEdits,
      // que rejeita range inválido/sobreposto/não-cirúrgico → cai pro fallback). É o
      // caminho mais confiável pro modelo pequeno; roda quando o lazy não casou.
      // Arquivo grande pula este tier (numera o arquivo INTEIRO → mesmo timeout): vai
      // direto pra região logo abaixo.
      if (
        (!applied.applied || !applied.snapshot) &&
        !tooLargeForLocal &&
        !bigFileForLocal &&
        withinFileBudget()
      ) {
        // BEST-OF-N POR GERAÇÃO: greedy (temp 0) e depois UMA amostra diversa, no
        // MESMO tier — bem mais barato que re-rodar a execução inteira. O verificador
        // determinístico (applyLineEdits + applyWholeFile) fica com o 1º candidato que
        // de fato aplica; se nenhum aplicar, cai pra região.
        for (const temp of [undefined, 0.5] as const) {
          if ((applied.applied && applied.snapshot) || (temp !== undefined && !withinFileBudget()))
            break;
          attempts++;
          trace({
            level: 'info',
            source: 'forge',
            scope: 'generate',
            issueKey: issue.issueKey,
            workspaceId: issue.workspaceId,
            message: `local: edit ancorado por linha em ${task.file}${temp ? ` (t=${temp})` : ''}…`,
          });
          onProgress?.(`Forge editando ${task.file} por linha (local)…`);
          const le = await generateLocalLineEdit(cfg, input, temp);
          if (le.kind !== 'edit') continue;
          const merged = applyLineEdits(fileContent, le.edits);
          if (merged === null || merged === fileContent) continue;
          const rapplied = applyWholeFile(repoPath, task.file, merged);
          if (rapplied.applied && rapplied.snapshot && rapplied.changedLines > 0) {
            estimatedOutputChars += le.raw.length;
            applied = rapplied;
          }
        }
      }

      // RECUPERAÇÃO 100% LOCAL — TIER REGIÃO (antes do rewrite-inteiro): isola a
      // MENOR função/bloco que contém o foco e manda o Forge reescrever SÓ ela. É o
      // caminho seguro pro modelo pequeno em arquivo grande: reproduzir 30 linhas é
      // confiável, 500 não. O app funde determinístico (spliceRegion) e só o span da
      // região muda — código fora dela NUNCA é tocado, então a deleção em massa que
      // o usuário viu fica impossível. Guardas anti-encolhimento/anti-expansão extra.
      if ((!applied.applied || !applied.snapshot) && !tooLargeForLocal && withinFileBudget()) {
        const region = extractEditableRegion(fileContent, relevantLines, task.file);
        if (region) {
          attempts++;
          trace({
            level: 'info',
            source: 'forge',
            scope: 'generate',
            issueKey: issue.issueKey,
            workspaceId: issue.workspaceId,
            message: `local: editando só a região (linhas ${region.startLine}-${region.endLine}) de ${task.file}…`,
          });
          onProgress?.(`Forge editando o trecho relevante de ${task.file} (local)…`);
          const gen = await generateLocalEditRegion(cfg, { ...input, regionText: region.text });
          if (gen.kind === 'edit') {
            const origRegionLines = region.text.split('\n').length;
            const newRegionLines = gen.update.split('\n').length;
            // Anti-encolhimento (perdeu >40% do trecho → truncou) e anti-expansão
            // (>2.5× → alucinou/duplicou). Em ambos rejeita e cai no fallback.
            const shrankTooMuch = newRegionLines < origRegionLines * 0.6;
            const grewTooMuch = newRegionLines > origRegionLines * 2.5;
            const merged =
              !shrankTooMuch && !grewTooMuch ? spliceRegion(fileContent, region, gen.update) : null;
            // No-op: o modelo só ECOOU o trecho (comum num 1.5B que não entendeu) —
            // NÃO grava nem marca sucesso; deixa cair no rewrite/escala. Senão a
            // issue concluiria com 0 mudança (o bug "feito sem fazer nada").
            if (merged !== null && merged !== fileContent) {
              const rapplied = applyWholeFile(repoPath, task.file, merged);
              if (rapplied.applied && rapplied.snapshot && rapplied.changedLines > 0) {
                estimatedOutputChars += gen.raw.length;
                applied = rapplied;
              }
            } else if (merged !== null) {
              trace({
                level: 'info',
                source: 'forge',
                scope: 'morph',
                issueKey: issue.issueKey,
                workspaceId: issue.workspaceId,
                message: `região reescrita idêntica ao original em ${task.file} — ignorada (sem mudança)`,
              });
            } else {
              trace({
                level: 'warn',
                source: 'forge',
                scope: 'morph',
                issueKey: issue.issueKey,
                workspaceId: issue.workspaceId,
                message: `região reescrita fora de proporção (${origRegionLines}→${newRegionLines} linhas) — REJEITADA`,
              });
            }
          }
        }
      }

      // RECUPERAÇÃO 100% LOCAL (nunca premium): o merge por âncora não casou. Em vez de
      // ESCALAR, o Forge reescreve o arquivo INTEIRO localmente — o dono quer que ele
      // TERMINE local. Vale pra QUALQUER arquivo que caiba no contexto local
      // (!tooLargeForLocal), não só os pequenos: as guardas ANTI-ENCOLHIMENTO (rejeita
      // rewrite que perdeu >25%) e ANTI-DROP-DE-IMPORTS barram deleção destrutiva mesmo
      // em arquivo grande. Só o que NÃO cabe no contexto (tooLargeForLocal) é que não dá
      // pra reescrever local — aí sim bloqueia/escala.
      const origLines = fileContent ? fileContent.split('\n').length : 0;
      if (
        (!applied.applied || !applied.snapshot) &&
        !tooLargeForLocal &&
        origLines > 0 &&
        withinFileBudget()
      ) {
        attempts++;
        trace({
          level: 'info',
          source: 'forge',
          scope: 'generate',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `local: âncora não casou — Forge reescrevendo ${task.file} inteiro…`,
        });
        onProgress?.(`Âncora não casou — Forge reescrevendo ${task.file} inteiro (local)…`);
        const rewrite = await generateLocalWholeFile(cfg, {
          taskId: task.id,
          filePath: task.file,
          instruction: task.instruction,
          goal: plan.goal,
          constraints,
          fileContent,
        });
        if (rewrite.kind === 'edit') {
          const newLines = rewrite.update.split('\n').length;
          // Encolheu >25% OU dropou imports de topo? O modelo truncou/destruiu — REJEITA.
          const shrankTooMuch = newLines < origLines * 0.75;
          const lostImports = droppedTopLevelImports(fileContent, rewrite.update);
          if (!shrankTooMuch && !lostImports) {
            const rapplied = applyWholeFile(repoPath, task.file, rewrite.update);
            // changedLines > 0: alinha com os outros tiers — um rewrite no-op (0 linhas
            // mudadas) NÃO conta como sucesso (senão "aplica" sem mudar nada).
            if (rapplied.applied && rapplied.snapshot && rapplied.changedLines > 0) {
              estimatedOutputChars += rewrite.raw.length;
              applied = rapplied;
            }
          } else {
            trace({
              level: 'warn',
              source: 'forge',
              scope: 'morph',
              issueKey: issue.issueKey,
              workspaceId: issue.workspaceId,
              message: `rewrite de ${task.file} REJEITADO (${shrankTooMuch ? `encolheu ${origLines}→${newLines}` : 'dropou imports de topo'}) — não grava deleção em massa`,
            });
          }
        }
      }

      if (!applied.applied || !applied.snapshot) {
        rollbackAll();
        record({
          modelUsed: 'premium',
          validationResult: 'skipped',
          fallbackUsed: true,
          failureReason: `merge lazy não aplicou: ${applied.error ?? '?'}`,
          attempts,
        });
        trace({
          level: 'warn',
          source: 'forge',
          scope: 'morph',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `merge: falhou em ${task.file} (${applied.error ?? 'âncora não casou'}) localmente`,
        });
        // Mensagem SEMPRE local: a falha é de capacidade local, não um convite a
        // escalar. O caller decide bloquear/escalar com teto.
        return escalateOutcome(
          `Não foi possível aplicar o edit em ${task.file} localmente (morphismo não casou).`,
        );
      }
      trace({
        level: 'success',
        source: 'forge',
        scope: 'morph',
        issueKey: issue.issueKey,
        workspaceId: issue.workspaceId,
        message: `merge: aplicou ${applied.appliedBlocks ?? 1} trecho(s) em ${task.file}`,
      });

      // Mudança grande: o Forge FAZ mesmo assim — economia é o pilar, nunca escala
      // nem bloqueia só por tamanho. (Antes dava rollback + premium; e também
      // quebrava o rewrite de arquivo inteiro, que naturalmente muda muitas linhas.)
      // A rede de segurança real é a VALIDAÇÃO abaixo + o Code Reviewer na cadeia.
      if (applied.changedLines > cfg.thresholds.maxChangedLines) {
        trace({
          level: 'warn',
          source: 'forge',
          scope: 'morph',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `mudança grande em ${task.file} (${applied.changedLines} linhas) — seguindo local; validação + review decidem`,
        });
        onProgress?.(
          `Mudança grande em ${task.file} (${applied.changedLines} linhas) — seguindo local`,
        );
      }

      snapshots.push(applied.snapshot);
      filesChanged.push(task.file);
      // Captura o edit lazy como candidato do RAG (vira exemplo só se o review
      // aprovar a issue). Só os tiers lazy — formato que o few-shot ensina.
      if (appliedLazyEdit) {
        acceptedEdits.push({
          file: task.file,
          symbol: null,
          instruction: task.instruction,
          acceptedEdit: appliedLazyEdit,
        });
      }
      onProgress?.(`Aplicado em ${task.file} (${applied.changedLines} linha(s))`);
    }

    // CREATE-tasks escrevem arquivos que NÃO existiam no classify, então
    // cls.validationCommands (computado lá) não os cobria → um arquivo novo
    // quebrado/stub passava sem syntax-check (P1-1). Recomputa contra os arquivos
    // que de fato mudaram (já em disco) pra o php -l/node --check pegá-los.
    if (filesChanged.length > 0) {
      cls.validationCommands = detectValidationCommands(repoPath, filesChanged);
    }

    // ---- Validação + correção LOCAL em RODADAS (nunca premium). Antes era 1
    // passada e desistia → bloqueava na 1ª falha. Agora revalida e devolve o erro
    // pro Forge corrigir LOCALMENTE por até `maxLocalValidationRounds` rodadas,
    // indo "até o fim" local. Só desiste (e o caller bloqueia, SEM premium) quando
    // esgota as rodadas — a economia continua intacta.
    let validationOk = true;
    let validationErr: string | null = null;
    if (cls.validationCommands.length > 0) {
      const maxRounds = Math.max(1, cfg.retry.maxLocalValidationRounds);
      for (let round = 0; round < maxRounds; round++) {
        onProgress?.(
          round === 0
            ? 'Validando as alterações…'
            : `Revalidando localmente (rodada ${round + 1}/${maxRounds})…`,
        );
        const result = await runValidation(repoPath, cls.validationCommands, cfg.local.timeoutMs);
        validationOk = result.passed;
        validationErr = firstFailure(result);
        // Passou, sem o que corrigir, correção desligada, ou última rodada (não
        // adianta corrigir sem revalidar depois) → encerra o loop.
        if (
          validationOk ||
          filesChanged.length === 0 ||
          cfg.retry.maxLocalFixAttempts <= 0 ||
          round === maxRounds - 1
        ) {
          break;
        }
        // Corrige os arquivos que o ERRO referencia (fallback: o último alterado),
        // no máx. 3 por rodada. A revalidação acontece no topo da próxima rodada.
        const referenced = filesChanged.filter((f) => (validationErr ?? '').includes(f));
        const toFix = (
          referenced.length > 0 ? referenced : [filesChanged[filesChanged.length - 1]]
        ).slice(0, 3);
        let appliedAnyFix = false;
        for (const targetFile of toFix) {
          const abs = join(repoPath, targetFile);
          const fileContent = existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
          attempts++;
          trace({
            level: 'info',
            source: 'forge',
            scope: 'generate',
            issueKey: issue.issueKey,
            workspaceId: issue.workspaceId,
            message: `local: corrigindo ${targetFile} após falha de validação (rodada ${round + 1})…`,
          });
          // Reusa a instrução do plano (carrega o reviewBlock do revisor numa
          // re-execução pós-review); sem isso o retry voltaria à bare issue.title.
          const planInstruction =
            plan.tasks.find((tk) => tk.file === targetFile)?.instruction ??
            plan.tasks[0]?.instruction ??
            issue.title;
          const fix = await generateLocalEditFix(
            cfg,
            {
              taskId: 'fix',
              filePath: targetFile,
              instruction: planInstruction,
              goal: plan.goal,
              constraints,
              fileContent,
              focusHint: focusHintForError(validationErr, targetFile),
              contextPack,
              loraPath,
            },
            validationErr ?? 'validação falhou',
          );
          if (fix.kind !== 'edit') continue;
          const reapplied = applyEditRobust(targetFile, fix.update);
          if (reapplied.applied && reapplied.snapshot) {
            snapshots.push(reapplied.snapshot);
            appliedAnyFix = true;
          }
        }
        // Nenhuma correção aplicada nesta rodada → repetir não muda nada.
        if (!appliedAnyFix) break;
      }
    }

    if (!validationOk) {
      rollbackAll();
      record({
        modelUsed: 'premium',
        validationResult: 'failed',
        fallbackUsed: true,
        filesChanged,
        failureReason: validationErr ?? 'validação falhou após correção local',
        attempts,
      });
      return {
        handled: false,
        escalate: 'Validação falhou após as rodadas de correção local.',
        modelUsed: 'premium',
        validationResult: 'failed',
        filesChanged: [],
        diffSummary: '',
        failureReason: validationErr,
        metrics: NOOP_METRICS,
      };
    }

    // Guard: NENHUM arquivo mudou de fato (tasks de criação cujos alvos já existiam,
    // ou edits que não produziram diff). NÃO conclui em silêncio como sucesso — era
    // o bug "issue CONCLUÍDA, 0 arquivos, sem review nem comentário". Bloqueia + pede
    // revisão humana (o caller comenta o motivo), em vez de marcar feito sem nada.
    if (filesChanged.length === 0) {
      rollbackAll();
      record({
        modelUsed: 'local',
        validationResult: 'skipped',
        failureReason: 'nenhuma mudança produzida (alvos já existiam ou edit vazio)',
        attempts,
      });
      return escalateOutcome(
        'O Forge terminou sem alterar nenhum arquivo: os alvos já existem, ou não foi ' +
          'possível produzir a mudança. Precisa de revisão humana (nada foi alterado).',
      );
    }

    // OEP: contrato da Cápsula — verifica DETERMINISTICAMENTE se o resultado bate com o
    // pedido (símbolo citado presente etc.). Por design (crítica adversarial) é SINAL +
    // APRENDIZADO, não bloqueio: asserts são guard-rail (verificam sintoma, não prova de
    // comportamento), o gate DURO é o QA. Falhou → vira pitfall (re-alimenta a próxima
    // cápsula) + nota pro reviewer. Os asserts que precisam do estado ANTES já são
    // cobertos pelo morph; aqui rodam só os baratos sem before (file_contains/symbol).
    let contractNote = '';
    if (repoPath && capsule.contract.asserts.length > 0) {
      // Estado ANTES de cada arquivo, dos snapshots (o 1º snapshot por arquivo = original)
      // — sem isto, imports_intact/no_shrink passavam por vacuidade (Map vazio).
      const beforeByFile = new Map<string, string>();
      for (const snap of snapshots) {
        for (const e of snap.entries) {
          if (e.content == null) continue;
          const rel = e.path.startsWith(repoPath)
            ? e.path.slice(repoPath.length).replace(/^[/\\]/, '')
            : e.path;
          if (!beforeByFile.has(rel)) beforeByFile.set(rel, e.content);
        }
      }
      const assertFail = runAsserts(capsule.contract.asserts, repoPath, beforeByFile);
      if (assertFail) {
        contractNote = ` ⚠️ contrato: ${assertFail.reason}`;
        trace({
          level: 'warn',
          source: 'forge',
          scope: 'morph',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `OEP: contrato não confirmado (${assertFail.reason}); reviewer confere`,
        });
      }
    }

    // ---- Sucesso local 🎉 — o Forge resolve 100% localmente, então o premium
    // foi sempre evitado (premiumAvoided = true) e a economia é total.
    const metrics: ExecutionMetrics = {
      premiumAvoided: true,
      estimatedPremiumInputTokensAvoided: estimatePremiumInputTokens(estimatedInputChars),
      estimatedPremiumOutputTokensAvoided: estimatePremiumOutputTokens(estimatedOutputChars),
      localExecutionUsed: true,
      localRuntime: 'llama.cpp',
    };
    const diffSummary = `${filesChanged.length} arquivo(s) alterado(s) localmente: ${filesChanged.join(', ')}${contractNote}`;
    record({
      modelUsed: 'local',
      validationResult: cls.validationCommands.length > 0 ? 'passed' : 'skipped',
      filesChanged,
      diffSummary,
      attempts,
      metrics,
    });
    return {
      handled: true,
      modelUsed: 'local',
      validationResult: cls.validationCommands.length > 0 ? 'passed' : 'skipped',
      filesChanged,
      diffSummary,
      failureReason: null,
      metrics,
      acceptedEdits,
    };
  } catch (err) {
    rollbackAll();
    const reason =
      err instanceof LlamaUnavailableError
        ? `Runtime local indisponível: ${err.message}`
        : `Erro na execução local: ${err instanceof Error ? err.message : String(err)}`;
    record({
      modelUsed: 'premium',
      validationResult: 'skipped',
      fallbackUsed: true,
      failureReason: reason,
      attempts,
    });
    return escalateOutcome(reason);
  } finally {
    // Fim da run: rearma o idle-unload (descarrega após ociosidade) só agora,
    // nunca entre os arquivos de uma mesma issue.
    endRun(cfg.local);
  }
}

/** Extrai "line N" do erro de validação pra ESTE arquivo (ex.: "src/x.ts:42:1"). */
function focusHintForError(err: string | null, file: string): string | undefined {
  if (!err) return undefined;
  const re = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:\\s]+(\\d+)`);
  const m = err.match(re);
  return m ? `line ${m[1]}` : undefined;
}

function escalateOutcome(reason: string): SmartOutcome {
  return {
    handled: false,
    escalate: reason,
    modelUsed: 'premium',
    validationResult: 'skipped',
    filesChanged: [],
    diffSummary: '',
    failureReason: reason,
    metrics: NOOP_METRICS,
  };
}
