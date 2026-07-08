/**
 * Motor v2: o runner do plano inteiro (amarra todas as pecas).
 *
 * intencao -> premium planeja fatias verticais (planner) -> valida o plano (enxuto, skeleton
 * primeiro) -> roda issue por issue (cada uma uma fatia) com o gate de design congelado ->
 * apos o esqueleto-que-anda, computa o preview CONTEXTUAL -> contabiliza premium vs local do
 * plano todo. Plano ruim e rejeitado ANTES de gastar Forge. Issue que nao fecha fica blocked,
 * honesto.
 *
 * Ver docs/MOTOR-FATIAS-VERTICAIS.md (o fluxo de ponta a ponta).
 */
import * as path from 'node:path';

import { planFromIntent, type PlanModelFn, type Plan } from './planner';
import { extractDesignContract, type DesignContract } from './design-system';
import { gatherRepoContext, listProjectFiles } from './repo-context';
import { runIssue, type Issue, type ConductFn, type CheckpointSnapshot } from './issue-runner';
import { planPreview, type PreviewPlan } from './preview-policy';
import { launchPreview, type PreviewHandle } from './preview-launcher';
import { commitSlice, ensureGitRepo } from './slice-commit';
import {
  emptyLedger,
  addPremium,
  economyReport,
  economyLine,
  type TokenLedger,
  type EconomyReport,
} from './token-ledger';
import type { GenerateFn } from './execute-checkbox';

export interface IssueRunSummary {
  issueId: string;
  title: string;
  isWalkingSkeleton: boolean;
  doneCount: number;
  blockedCount: number;
}

export interface RunPlanResult {
  /** False quando o plano foi rejeitado na validacao (nao rodou nada). */
  planned: boolean;
  /** Resposta conversacional quando a mensagem NAO era um build (pergunta/conversa). */
  reply?: string;
  planViolations: string[];
  issues: IssueRunSummary[];
  totalDone: number;
  totalBlocked: number;
  ledger: TokenLedger;
  economy: EconomyReport;
  economyLine: string;
  /** Preview contextual liberado apos o esqueleto-que-anda; null se ainda nao. */
  preview: PreviewPlan | null;
  /** True se o dev server do preview foi efetivamente ligado. */
  previewLaunched: boolean;
  /** True se o run foi cancelado no meio (signal). */
  cancelled: boolean;
}

export interface RunPlanInput {
  intent: string;
  projectRoot: string;
  /** Premium planner. */
  planModel: PlanModelFn;
  /** Forge local. */
  generate: GenerateFn;
  /** Premium na escalada. */
  conduct: ConductFn;
  port?: number;
  /** Commita cada fatia que fecha (secao 4.6). Default true (best-effort, so se for git). */
  commitPerSlice?: boolean;
  /** Sobe o dev server apos o esqueleto (secao 6). Default false (o caller decide). */
  launchPreviewServer?: boolean;
  /** Cancelamento: aborta entre fatias/checkboxes. */
  signal?: AbortSignal;
  /** Dispara com o plano completo (todas as fatias/checkboxes) ANTES de executar. */
  onPlanReady?: (plan: Plan) => void;
  onCheckpoint?: (snapshot: CheckpointSnapshot) => void;
  onPreviewReady?: (preview: PreviewPlan) => void;
  /** Chamado quando o dev server sobe, com o handle pra parar depois. */
  onPreviewLaunched?: (handle: PreviewHandle) => void;
  writeFile?: (absPath: string, content: string) => void;
  readFile?: (absPath: string) => string | null;
}

function abs(projectRoot: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(projectRoot, p);
}

/**
 * Executa o plano inteiro a partir da intencao. Nunca roda um plano invalido. Devolve o
 * resumo por issue, o preview contextual e a economia LIQUIDA do plano todo.
 */
export async function runPlan(input: RunPlanInput): Promise<RunPlanResult> {
  const {
    intent,
    projectRoot,
    planModel,
    generate,
    conduct,
    port,
    commitPerSlice = true,
    launchPreviewServer = false,
    signal,
    onPlanReady,
    onCheckpoint,
    onPreviewReady,
    onPreviewLaunched,
  } = input;
  const ledger: TokenLedger = emptyLedger();

  // 1) premium planeja + valida (enxuto, fatias verticais, skeleton primeiro). O contexto
  // do repo deixa o planner ciente do que JA existe (nao recria package.json/tsconfig etc).
  const planned = await planFromIntent(
    { intent, context: gatherRepoContext(projectRoot) },
    planModel,
  );
  addPremium(ledger, planned.premiumIn, planned.premiumOut);

  // Não é build: o modelo respondeu conversacionalmente. Devolve a resposta, sem rodar nada.
  if (planned.plan.reply) {
    return {
      planned: false,
      reply: planned.plan.reply,
      planViolations: [],
      issues: [],
      totalDone: 0,
      totalBlocked: 0,
      ledger,
      economy: economyReport(ledger),
      economyLine: economyLine(economyReport(ledger)),
      preview: null,
      previewLaunched: false,
      cancelled: false,
    };
  }

  if (planned.violations.length > 0) {
    return {
      planned: false,
      planViolations: planned.violations,
      issues: [],
      totalDone: 0,
      totalBlocked: 0,
      ledger,
      economy: economyReport(ledger),
      economyLine: economyLine(economyReport(ledger)),
      preview: null,
      previewLaunched: false,
      cancelled: false,
    };
  }

  // plano validado: avisa a UI com a checklist completa ANTES de executar.
  onPlanReady?.(planned.plan);

  // greenfield começa sem git: garante o repo pra o commit-por-fatia funcionar.
  if (commitPerSlice) ensureGitRepo(projectRoot);

  // 2) design congelado (greenfield comeca vazio; re-extrai apos o esqueleto montar o kit).
  let designContract: DesignContract = extractDesignContract(projectRoot);
  let preview: PreviewPlan | null = null;
  let previewLaunched = false;
  let cancelled = false;
  const summaries: IssueRunSummary[] = [];

  // 3) roda issue por issue (cada uma uma fatia vertical).
  for (const plannedIssue of planned.plan.issues) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const issue: Issue = {
      id: plannedIssue.id,
      title: plannedIssue.title,
      checkboxes: plannedIssue.checkboxes.map((cb) => ({
        id: cb.id,
        instruction: cb.instruction,
        targetFile: abs(projectRoot, cb.targetFile),
        done: false,
      })),
    };

    const res = await runIssue({
      issue,
      projectRoot,
      generate,
      conduct,
      ledger,
      designContract: designContract.frozen ? designContract : undefined,
      existingFiles: listProjectFiles(projectRoot),
      signal,
      onCheckpoint,
      writeFile: input.writeFile,
      readFile: input.readFile,
    });

    summaries.push({
      issueId: plannedIssue.id,
      title: plannedIssue.title,
      isWalkingSkeleton: plannedIssue.isWalkingSkeleton,
      doneCount: res.doneCount,
      blockedCount: res.blockedCount,
    });

    // 4.6) commita a fatia que fechou algo (rollback + historico legivel).
    if (commitPerSlice && res.doneCount > 0) {
      commitSlice(projectRoot, `engine-v2: ${plannedIssue.title}`);
    }

    // 4) apos o esqueleto-que-anda: o kit ja existe -> congela o design + libera o preview.
    if (plannedIssue.isWalkingSkeleton) {
      designContract = extractDesignContract(projectRoot);
      preview = planPreview({ projectRoot, port });
      onPreviewReady?.(preview);
      // 6) sobe o dev server pro usuario abrir e testar cedo.
      if (launchPreviewServer && preview.runnable) {
        const handle = launchPreview(projectRoot, preview);
        if (handle) {
          previewLaunched = true;
          onPreviewLaunched?.(handle);
        }
      }
    }
  }

  const economy = economyReport(ledger);
  return {
    planned: true,
    planViolations: [],
    issues: summaries,
    totalDone: summaries.reduce((a, s) => a + s.doneCount, 0),
    totalBlocked: summaries.reduce((a, s) => a + s.blockedCount, 0),
    ledger,
    economy,
    economyLine: economyLine(economy),
    preview,
    previewLaunched,
    cancelled,
  };
}
