/**
 * Loop de aprendizado contínuo da KB — o "treino" funcional do workspace.
 *
 * A cada execução de issue (sucesso OU bloqueio), gravamos uma página
 * `agent-memory` resumindo o que foi feito (arquivos, decisão, resultado). Assim
 * a base de conhecimento CRESCE de forma profunda e funcional a cada run — não
 * uma abstração rasa, mas o registro real do que resolveu (ou travou).
 *
 * Na próxima execução, `getRelevantLearnings` recupera os aprendizados mais
 * relevantes e os injeta no prompt do agente — in-context learning, o efeito
 * prático de "fine-tuning" sem treinar pesos: o time aprende com o próprio
 * histórico dentro do workspace.
 */
import { createHash } from 'node:crypto';
import { createPage, updatePage } from './kb-service';
import { search as lexicalSearchPages } from './kb-search';
import { KbPageRepository, slugify } from '../db/repositories/kb-page.repo';
import { aiLearningRepo } from '../db/repositories/ai-learning.repo';
import { IssueRepository } from '../db/repositories/issue.repo';
import { SettingsRepository } from '../db/repositories/settings.repo';
import { trace } from './log-bus';
import type { Issue, WorkspaceSource } from '../../shared/types';

const learningPageRepo = new KbPageRepository();
const learningIssueRepo = new IssueRepository();
const learningSettingsRepo = new SettingsRepository();

export interface ExecutionLearning {
  issue: Issue;
  agentName: string;
  /** Resumo do que foi feito (outputSummary / diffSummary). */
  summary: string;
  filesChanged: string[];
  outcome: 'done' | 'blocked';
  runId?: string | null;
  modelUsed?: 'local' | 'premium' | 'hybrid' | 'unknown';
  verification?: 'verified' | 'unverified' | 'not_applicable';
  toolCallCount?: number;
  changeBlock?: string;
  contextPack?: string;
  metrics?: Record<string, unknown>;
  /** Contexto extra que torna o aprendizado ACIONÁVEL: erro de validação, motivo
   *  de escalonamento, sequência de tools — o "da última vez deu X, faça Y". */
  details?: string;
  /** Source/repo/pasta onde a execução aconteceu. Escopa a memória no backend/front/app correto. */
  source?: WorkspaceSource | null;
}

function normalizeForHash(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function learningHash(input: ExecutionLearning): string {
  const sourceId = input.source?.id ?? 'workspace';
  const material = [
    sourceId,
    input.agentName,
    input.issue.issueKey,
    normalizeForHash(input.issue.title),
    input.outcome,
    input.filesChanged.slice().sort().join('|'),
    normalizeForHash(input.details ?? input.summary),
  ].join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function isLowSignalLearning(input: ExecutionLearning): boolean {
  return scoreLearningSignal(input).score < 0.45;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreLearningSignal(input: ExecutionLearning): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;
  const summary = input.summary.trim();
  const details = input.details?.trim() ?? '';
  if (input.outcome === 'blocked') {
    score += 0.35;
    reasons.push('blocked_outcome:+0.35');
  }
  if (input.filesChanged.length > 0) {
    const delta = Math.min(0.28, 0.12 + input.filesChanged.length * 0.025);
    score += delta;
    reasons.push(`files_changed:+${delta.toFixed(2)}`);
  }
  if (details.length > 0) {
    const delta = details.length > 240 ? 0.2 : 0.14;
    score += delta;
    reasons.push(`actionable_details:+${delta.toFixed(2)}`);
  }
  if (input.issue.description && input.issue.description.trim().length > 40) {
    score += 0.08;
    reasons.push('clear_goal:+0.08');
  }
  if (input.source?.id) {
    score += 0.08;
    reasons.push('source_scoped:+0.08');
  }
  if (summary.length >= 120 && !/^✅?\s*Run finalizado\b/i.test(summary)) {
    score += 0.16;
    reasons.push('specific_summary:+0.16');
  }
  if (/erro|error|falh|failed|blocked|root cause|causa/i.test(`${summary}\n${details}`)) {
    score += 0.1;
    reasons.push('failure_signal:+0.10');
  }
  if (/^✅?\s*Run finalizado\b/i.test(summary) && input.filesChanged.length === 0 && !details) {
    score -= 0.45;
    reasons.push('generic_run_summary:-0.45');
  }
  return { score: clamp01(score), reasons };
}

export function scoreTrainingTrajectory(input: ExecutionLearning): {
  score: number;
  reasons: string[];
  eligibleForAutoApproval: boolean;
  rejectionReasons: string[];
} {
  const base = scoreLearningSignal(input);
  const reasons = [...base.reasons];
  const rejectionReasons: string[] = [];
  let score = base.score * 0.55;

  if (input.outcome === 'done') {
    score += 0.16;
    reasons.push('done_outcome:+0.16');
  } else {
    rejectionReasons.push('not_successful_outcome');
    score -= 0.2;
    reasons.push('blocked_outcome_training_penalty:-0.20');
  }

  if (input.verification === 'verified') {
    score += 0.22;
    reasons.push('verified_execution:+0.22');
  } else if (input.verification === 'not_applicable') {
    score += 0.05;
    reasons.push('no_code_verification_needed:+0.05');
  } else {
    rejectionReasons.push('unverified_execution');
    score -= 0.16;
    reasons.push('unverified_execution:-0.16');
  }

  if (input.filesChanged.length > 0) {
    score += 0.1;
    reasons.push('has_diff_files:+0.10');
  } else if (input.outcome === 'done') {
    rejectionReasons.push('no_changed_files_for_code_training');
    score -= 0.08;
    reasons.push('no_changed_files:-0.08');
  }

  if (input.changeBlock?.includes('<orkestral:code-changes')) {
    score += 0.08;
    reasons.push('structured_diff_card:+0.08');
  }

  if (input.contextPack?.trim()) {
    score += 0.06;
    reasons.push('rag_context_available:+0.06');
  }

  if (input.modelUsed === 'local') {
    score += 0.04;
    reasons.push('local_model_execution:+0.04');
  } else if (input.modelUsed === 'hybrid') {
    score += 0.03;
    reasons.push('hybrid_execution:+0.03');
  }

  const toolCalls = input.toolCallCount ?? 0;
  if (toolCalls > 0 && toolCalls <= 20) {
    score += 0.03;
    reasons.push('bounded_tool_use:+0.03');
  } else if (toolCalls > 40) {
    score -= 0.06;
    reasons.push('excessive_tool_use:-0.06');
  }

  if (/undo|invalidat|revert/i.test(`${input.details ?? ''}\n${input.summary}`)) {
    rejectionReasons.push('undo_or_revert_signal');
    score -= 0.25;
    reasons.push('undo_or_revert_signal:-0.25');
  }

  const finalScore = clamp01(score);
  return {
    score: finalScore,
    reasons,
    eligibleForAutoApproval: rejectionReasons.length === 0 && finalScore >= 0.65,
    rejectionReasons,
  };
}

function sourceRootPageId(workspaceId: string, source?: WorkspaceSource | null): string | null {
  if (!source) return null;
  const pages = learningPageRepo.listByWorkspace(workspaceId, true);
  return (
    pages.find(
      (page) =>
        page.sourceId === source.id &&
        page.kind === 'auto-generated' &&
        page.title === `Repo: ${source.label}`,
    )?.id ??
    pages.find((page) => page.sourceId === source.id && page.kind === 'auto-generated')?.id ??
    null
  );
}

function memoryTitle(learning: ExecutionLearning): string {
  const sourceLabel = learning.source?.label ?? 'Workspace';
  const role = learning.source?.role ? ` · ${learning.source.role}` : '';
  return `Memória operacional · ${sourceLabel}${role} · ${learning.agentName}`;
}

function extractRecentEntries(content: string): string[] {
  const marker = '<!-- orkestral-learning-entry -->';
  return content
    .split(marker)
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatFiles(filesChanged: string[]): string {
  if (filesChanged.length === 0) return '- nenhum arquivo registrado';
  return filesChanged.map((f) => `- \`${f}\``).join('\n');
}

function legacyTitles(issue: Issue): string[] {
  return [
    `Learning: ${issue.title} (${issue.issueKey})`,
    `Blocker: ${issue.title} (${issue.issueKey})`,
  ];
}

function archiveLegacyIssueLearning(issue: Issue): void {
  for (const title of legacyTitles(issue)) {
    const page = learningPageRepo.getBySlug(issue.workspaceId, slugify(title));
    if (page && !page.isArchived) {
      updatePage({ pageId: page.id, patch: { isArchived: true } });
    }
  }
}

/** Grava o aprendizado de uma execução como página agent-memory (KB cresce). */
export function recordExecutionLearning(learning: ExecutionLearning): void {
  try {
    const { issue, agentName, summary, filesChanged, outcome, details, source } = learning;
    archiveLegacyIssueLearning(issue);
    const quality = scoreLearningSignal(learning);
    if (isLowSignalLearning(learning)) {
      trace({
        level: 'info',
        source: 'learning',
        scope: 'skip',
        workspaceId: issue.workspaceId,
        issueKey: issue.issueKey,
        message: `aprendizado ignorado · score=${quality.score.toFixed(2)} · ${quality.reasons.join(' ')}`,
      });
      return;
    }
    const title = memoryTitle(learning);
    const hash = learningHash(learning);
    const existing = learningPageRepo.getBySlug(issue.workspaceId, slugify(title));
    const existingContent = existing?.contentMd ?? '';
    if (existingContent.includes(`orkestral-learning-hash:${hash}`)) {
      trace({
        level: 'info',
        source: 'learning',
        scope: 'dedupe',
        workspaceId: issue.workspaceId,
        issueKey: issue.issueKey,
        message: `aprendizado duplicado ignorado · ${title}`,
      });
      return;
    }

    const entry = [
      '<!-- orkestral-learning-entry -->',
      `### ${new Date().toISOString()} · Issue ${issue.issueKey} · ${outcome}`,
      `<!-- orkestral-learning-hash:${hash} -->`,
      '',
      `**Task:** ${issue.title}`,
      `**Outcome:** ${outcome}`,
      `**Learning score:** ${quality.score.toFixed(2)} (${quality.reasons.join(', ')})`,
      '',
      '#### What changed',
      summary.trim() || '(no summary)',
      '',
      '#### Files touched',
      formatFiles(filesChanged),
      details?.trim() ? `\n#### Details to remember\n${details.trim().slice(0, 800)}` : '',
      issue.description ? `\n#### Original goal\n${issue.description.slice(0, 500)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const priorEntries = extractRecentEntries(existingContent)
      .filter((item) => !item.includes(`orkestral-learning-hash:${hash}`))
      .slice(0, 11);
    const content = [
      `# ${title}`,
      '',
      `**Scope:** ${source ? `${source.label} (${source.role ?? source.kind})` : 'Workspace global'}`,
      `**Agent:** ${agentName}`,
      `**Learning mode:** consolidated in-context memory + training-example candidate`,
      `**Quality gate:** score>=0.45; current score=${quality.score.toFixed(2)}`,
      '',
      '## How this memory is used',
      'This page is retrieved by KB/RAG and injected into future issue prompts for the same workspace/source. It is consolidated to avoid noisy one-page-per-run learning.',
      '',
      '## Recent execution outcomes',
      entry,
      ...priorEntries.map((item) => `<!-- orkestral-learning-entry -->\n${item}`),
    ]
      .filter(Boolean)
      .join('\n');
    if (existing) {
      updatePage({
        pageId: existing.id,
        patch: {
          contentMd: content,
          sourceId: source?.id ?? existing.sourceId ?? null,
        },
      });
    } else {
      createPage({
        workspaceId: issue.workspaceId,
        title,
        parentId: sourceRootPageId(issue.workspaceId, source),
        contentMd: content,
        kind: 'agent-memory',
        sourceId: source?.id ?? null,
      });
    }
    const knowledgeSettings = learningSettingsRepo.get().knowledge;
    const trainingQuality = scoreTrainingTrajectory(learning);
    const autoApproved =
      knowledgeSettings.autoApproveTrainingExamples &&
      trainingQuality.eligibleForAutoApproval &&
      trainingQuality.score >= knowledgeSettings.autoApprovalMinScore;
    const trajectory = {
      schemaVersion: 1,
      issueId: issue.id,
      issueKey: issue.issueKey,
      runId: learning.runId ?? null,
      workspaceId: issue.workspaceId,
      sourceId: source?.id ?? null,
      sourceLabel: source?.label ?? null,
      sourceRole: source?.role ?? null,
      agentName,
      modelUsed: learning.modelUsed ?? 'unknown',
      outcome,
      verification: learning.verification ?? 'not_applicable',
      filesChanged,
      toolCallCount: learning.toolCallCount ?? null,
      metrics: learning.metrics ?? {},
      contextPack: learning.contextPack?.slice(0, 6000) ?? null,
      changeBlock: learning.changeBlock?.slice(0, 8000) ?? null,
      details: details?.slice(0, 4000) ?? null,
      capturedAt: new Date().toISOString(),
    };
    aiLearningRepo.createTrainingExample({
      workspaceId: issue.workspaceId,
      sourceKind: 'issue_run',
      sourceId: issue.id,
      taskType: 'code',
      inputText: [
        `Issue: ${issue.issueKey} — ${issue.title}`,
        issue.description ?? '',
        details ?? '',
      ]
        .join('\n\n')
        .trim(),
      expectedOutput: outcome === 'done' ? summary.trim() : null,
      actualOutput: summary.trim() || null,
      label: outcome === 'done' ? 'positive' : 'negative',
      metadata: {
        issueKey: issue.issueKey,
        learningHash: hash,
        learningPageTitle: title,
        sourceId: source?.id ?? null,
        sourceLabel: source?.label ?? null,
        filesChanged,
        outcome,
        agentName,
        modelUsed: learning.modelUsed ?? 'unknown',
        verification: learning.verification ?? 'not_applicable',
        learningScore: quality.score,
        learningScoreReasons: quality.reasons,
        trainingScore: trainingQuality.score,
        trainingScoreReasons: trainingQuality.reasons,
        trainingRejectionReasons: trainingQuality.rejectionReasons,
        postTrainingTechnique: 'trajectory_curation_rft_ready',
        trajectory,
        autoApproved,
        autoApprovalMinScore: knowledgeSettings.autoApprovalMinScore,
      },
      status: autoApproved ? 'approved' : 'candidate',
    });
    trace({
      level: outcome === 'done' ? 'success' : 'warn',
      source: 'learning',
      scope: 'record',
      workspaceId: issue.workspaceId,
      issueKey: issue.issueKey,
      message: `aprendizado consolidado · score=${quality.score.toFixed(2)} · treino=${trainingQuality.score.toFixed(2)} · ${outcome} · ${filesChanged.length} arquivo(s) · ${source?.label ?? 'workspace'} · fine-tuning=${autoApproved ? 'auto-aprovado' : 'candidato'}`,
    });
  } catch (err) {
    console.warn('[kb-learning] falha ao gravar aprendizado:', err);
  }
}

export function invalidateExecutionLearningByIssue(input: {
  workspaceId: string;
  issueId: string;
  reason: string;
}): { trainingExamplesIgnored: number; memoryPagesUpdated: number } {
  const issue = learningIssueRepo.get(input.issueId);
  if (!issue || issue.workspaceId !== input.workspaceId) {
    return { trainingExamplesIgnored: 0, memoryPagesUpdated: 0 };
  }
  const trainingExamplesIgnored = aiLearningRepo.rejectIssueRunCandidates({
    workspaceId: input.workspaceId,
    issueId: input.issueId,
    reason: input.reason,
  });
  const marker = '<!-- orkestral-learning-entry -->';
  let memoryPagesUpdated = 0;
  for (const page of learningPageRepo.listByWorkspace(input.workspaceId, true)) {
    if (page.kind !== 'agent-memory') continue;
    const content = page.contentMd ?? '';
    if (!content.includes(`· Issue ${issue.issueKey} ·`)) continue;
    const [header, ...entries] = content.split(marker);
    const keptEntries = entries
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => !entry.includes(`· Issue ${issue.issueKey} ·`));
    const invalidation = [
      '## Invalidated execution learnings',
      '',
      `- ${new Date().toISOString()} · Issue ${issue.issueKey} · ${input.reason}`,
      '',
    ].join('\n');
    updatePage({
      pageId: page.id,
      patch: {
        contentMd: [
          header.trim(),
          invalidation,
          ...keptEntries.map((entry) => `${marker}\n${entry}`),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    });
    memoryPagesUpdated++;
  }
  trace({
    level: 'warn',
    source: 'learning',
    scope: 'invalidate',
    workspaceId: input.workspaceId,
    issueKey: issue.issueKey,
    message: `aprendizado invalidado por Undo · examples=${trainingExamplesIgnored} pages=${memoryPagesUpdated}`,
  });
  return { trainingExamplesIgnored, memoryPagesUpdated };
}

/**
 * Recupera aprendizados anteriores relevantes pra uma issue e os formata como
 * bloco pro prompt. É o que faz o agente "lembrar" de soluções/bloqueios passados
 * no mesmo workspace — grounding direto no histórico real.
 */
export function getRelevantLearnings(
  workspaceId: string,
  query: string,
  limit = 3,
  sourceId?: string | null,
): string {
  try {
    const memory = lexicalSearchPages(workspaceId, query, 15).filter(
      (h) => h.kind === 'agent-memory',
    );
    // Prioriza BLOCKERS relevantes (aprender com a falha vale mais que repetir um
    // sucesso de rotina) — mantém a ordem BM25 dentro de cada grupo.
    const isBlocker = (h: { title: string }): boolean => /^Blocker:/i.test(h.title);
    const sameSource = sourceId ? memory.filter((h) => h.sourceId === sourceId) : [];
    const otherSource = sourceId ? memory.filter((h) => h.sourceId !== sourceId) : memory;
    const ordered = [
      ...sameSource.filter(isBlocker),
      ...sameSource.filter((h) => !isBlocker(h)),
      ...otherSource.filter(isBlocker),
      ...otherSource.filter((h) => !isBlocker(h)),
    ];
    const seen = new Set<string>();
    const hits = ordered
      .filter((h) => {
        if (seen.has(h.pageId)) return false;
        seen.add(h.pageId);
        return true;
      })
      .slice(0, limit);
    if (hits.length === 0) return '';
    trace({
      level: 'info',
      source: 'learning',
      scope: 'retrieve',
      workspaceId,
      message: `memorias recuperadas para o prompt · hits=${hits.length}`,
      echo: false,
    });
    const lines = ['## Prior learnings in this workspace (from past executions)', ''];
    for (const h of hits) {
      lines.push(`### ${h.title}`, h.excerpt, '');
    }
    lines.push(
      'Use these prior solutions/blockers to go faster and avoid repeating work or the same mistakes.',
    );
    return lines.join('\n');
  } catch {
    return '';
  }
}
