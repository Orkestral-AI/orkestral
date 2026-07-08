/**
 * Diagnóstico de saúde de execução (inspirado no kanban_diagnostics do Hermes).
 *
 * Heurísticas determinísticas sobre as issues + suas runs pra flagar problemas que
 * o watchdog (stall/timeout) não pega:
 *  - suspicious-success: run "done" sem nenhuma tool call (premium fingindo conclusão);
 *  - repeated-failure: várias runs falhas na mesma issue;
 *  - escalation-heavy: escala pro premium repetidamente (Forge não está dando conta);
 *  - stuck: parada em in_progress/in_review sem progresso há muito tempo;
 *  - blocked: precisa de decisão humana.
 *
 * Também agrega métricas de observabilidade (taxa de resolução local, tokens, custo,
 * duração). Tudo read-only — não re-executa nada (evita surpresa).
 */
import { IssueRepository } from '../db/repositories/issue.repo';
import type {
  DiagnosticFinding,
  IssueRun,
  RunMetrics,
  WorkspaceDiagnostics,
} from '../../shared/types';

const issueRepo = new IssueRepository();

/** Sem progresso por mais que isto em in_progress/in_review → "stuck". */
const STUCK_MS = 6 * 60 * 60 * 1000; // 6h

const SEVERITY_ORDER: Record<DiagnosticFinding['severity'], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function ageMs(iso: string | null): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Infinity : Date.now() - t;
}

function hours(ms: number): number {
  return Math.round(ms / 3_600_000);
}

export function diagnoseWorkspace(workspaceId: string): DiagnosticFinding[] {
  const issues = issueRepo.listByWorkspace(workspaceId);
  const runs = issueRepo.listRunsByWorkspace(workspaceId, 800);
  const byIssue = new Map<string, IssueRun[]>();
  for (const r of runs) {
    const arr = byIssue.get(r.issueId);
    if (arr) arr.push(r);
    else byIssue.set(r.issueId, [r]);
  }

  const findings: DiagnosticFinding[] = [];
  const add = (
    issue: { id: string; issueKey: number; title: string },
    kind: DiagnosticFinding['kind'],
    severity: DiagnosticFinding['severity'],
    detail: string,
  ): void => {
    findings.push({
      kind,
      severity,
      issueId: issue.id,
      issueKey: String(issue.issueKey),
      issueTitle: issue.title,
      detail,
    });
  };

  for (const issue of issues) {
    if (issue.status === 'done' || issue.status === 'cancelled') continue;
    const iruns = byIssue.get(issue.id) ?? []; // já vem recente→antigo
    const last = iruns[0];

    // suspicious-success: última run premium "done" sem tool call → provável no-op.
    // (Forge resolvido localmente legitimamente tem toolCallCount 0, então excluímos.)
    if (
      last &&
      last.status === 'done' &&
      last.adapterType !== 'orkestral_local' &&
      (last.toolCallCount ?? 0) === 0
    ) {
      add(
        issue,
        'suspicious-success',
        'medium',
        'Run marcada como concluída sem nenhuma chamada de ferramenta — possível no-op/alucinação.',
      );
    }

    const failed = iruns.filter((r) => r.status === 'failed').length;
    if (failed >= 2)
      add(
        issue,
        'repeated-failure',
        'high',
        `${failed} runs falharam nesta issue — provável problema arquitetural.`,
      );

    // exitReason só é setado em runs ORQUESTRADOS (Forge); runs antigos/premium-direto
    // têm null → a contagem é conservadora (não gera falso positivo, pode subcontar).
    const escalated = iruns.filter((r) => r.exitReason === 'escalated_to_premium').length;
    if (escalated >= 2)
      add(
        issue,
        'escalation-heavy',
        'low',
        `Escalou pro premium ${escalated}× — o Forge não está dando conta deste padrão.`,
      );

    if (issue.status === 'blocked') {
      add(issue, 'blocked', 'high', 'Bloqueada — precisa de decisão humana.');
    } else if ((issue.status === 'in_progress' || issue.status === 'in_review') && last) {
      // Tempo desde a ÚLTIMA atividade: in_review tem run finalizada esperando o
      // gestor (usa finishedAt); in_progress com run viva ainda não finalizou (cai
      // no startedAt). Os dois casos = "há quanto tempo nada acontece".
      const a = ageMs(last.finishedAt ?? last.startedAt);
      if (a > STUCK_MS)
        add(issue, 'stuck', 'medium', `Sem progresso há ~${hours(a)}h em "${issue.status}".`);
    }
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function getRunMetrics(workspaceId: string): RunMetrics {
  const runs = issueRepo.listRunsByWorkspace(workspaceId, 800);
  const m: RunMetrics = {
    totalRuns: runs.length,
    done: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    localResolved: 0,
    escalatedToPremium: 0,
    localResolveRate: 0,
    avgToolCalls: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCostUsd: 0,
    avgDurationMs: 0,
  };
  let toolSum = 0;
  let toolCount = 0;
  let durSum = 0;
  let durCount = 0;
  for (const r of runs) {
    if (r.status === 'done') m.done++;
    else if (r.status === 'failed') m.failed++;
    else if (r.status === 'cancelled') m.cancelled++;
    else if (r.status === 'running' || r.status === 'queued') m.running++;
    if (r.exitReason === 'local_resolved') m.localResolved++;
    else if (r.exitReason === 'escalated_to_premium') m.escalatedToPremium++;
    if (typeof r.toolCallCount === 'number') {
      toolSum += r.toolCallCount;
      toolCount++;
    }
    m.totalTokensIn += r.tokensIn ?? 0;
    m.totalTokensOut += r.tokensOut ?? 0;
    m.totalCostUsd += r.costUsd ?? 0;
    if (r.finishedAt && r.startedAt) {
      const d = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
      if (Number.isFinite(d) && d >= 0) {
        durSum += d;
        durCount++;
      }
    }
  }
  const orchestrated = m.localResolved + m.escalatedToPremium;
  m.localResolveRate = orchestrated > 0 ? m.localResolved / orchestrated : 0;
  m.avgToolCalls = toolCount > 0 ? Math.round((toolSum / toolCount) * 10) / 10 : 0;
  m.avgDurationMs = durCount > 0 ? Math.round(durSum / durCount) : 0;
  m.totalCostUsd = Math.round(m.totalCostUsd * 10000) / 10000;
  return m;
}

export function getWorkspaceDiagnostics(workspaceId: string): WorkspaceDiagnostics {
  return { findings: diagnoseWorkspace(workspaceId), metrics: getRunMetrics(workspaceId) };
}
