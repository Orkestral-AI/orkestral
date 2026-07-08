import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspaceDir } from '../db/connection';
import { aiLearningRepo } from '../db/repositories/ai-learning.repo';
import { KbPageRepository } from '../db/repositories/kb-page.repo';
import { searchPages } from './kb-service';
import type {
  AiTrainingExample,
  FineTuningReadiness,
  FineTuningReadinessSource,
  RagBenchmarkSummary,
  RagEvaluationRun,
  TrainingDatasetExport,
  TrainingPackExport,
} from '../../shared/types';

function asTrainingExample(
  row: ReturnType<typeof aiLearningRepo.createTrainingExample>,
): AiTrainingExample {
  return row as AiTrainingExample;
}

function asRagEvaluationRun(
  row: ReturnType<typeof aiLearningRepo.createRagEvaluationRun>,
): RagEvaluationRun {
  return row as RagEvaluationRun;
}

// Top-K base do gate de aprovação do benchmark RAG: a página-ouro precisa
// aparecer entre os K primeiros resultados (K escala com o nº de golds e é
// limitado ao `limit` da busca). Substitui o antigo gate por precisão, que era
// matematicamente impossível de passar com 1 gold em até 10 resultados
// (precisão máxima = 1/10 = 0.1 < 0.2).
const RAG_PASS_TOP_K = 3;

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function evaluateRagQuery(input: {
  workspaceId: string;
  query: string;
  expectedPageIds?: string[];
  limit?: number;
  metadata?: Record<string, unknown>;
}): Promise<RagEvaluationRun> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const hits = await searchPages(input.workspaceId, input.query, limit);
  const expected = [...new Set(input.expectedPageIds ?? [])];
  const resultPageIds = hits.map((h) => h.pageId);
  const expectedSet = new Set(expected);
  const matched = resultPageIds.filter((id) => expectedSet.has(id));
  const precisionAtK = resultPageIds.length > 0 ? matched.length / resultPageIds.length : 0;
  const recallAtK = expected.length > 0 ? matched.length / expected.length : 0;
  const firstRelevantRank = resultPageIds.findIndex((id) => expectedSet.has(id));
  const mrr = firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0;
  const avgScore = hits.length > 0 ? hits.reduce((sum, h) => sum + h.score, 0) / hits.length : 0;
  // Gate por POSIÇÃO (não por precisão): aprova quando a página-ouro foi
  // recuperada dentro do top-K, com K escalado pelo nº de golds e limitado ao
  // `limit` da busca. precisionAtK continua sendo computado/retornado só para
  // relatório.
  const passTopK = Math.min(limit, Math.max(RAG_PASS_TOP_K, expected.length * RAG_PASS_TOP_K));
  const status =
    expected.length === 0
      ? 'needs_review'
      : recallAtK > 0 && firstRelevantRank >= 0 && firstRelevantRank < passTopK
        ? 'passed'
        : 'failed';
  const run = aiLearningRepo.createRagEvaluationRun({
    workspaceId: input.workspaceId,
    query: input.query,
    expectedPageIds: expected,
    resultPageIds,
    metrics: {
      ...(input.metadata ?? {}),
      limit,
      precisionAtK,
      recallAtK,
      mrr,
      avgScore,
      matched,
      top: hits.slice(0, 5).map((h) => ({
        pageId: h.pageId,
        title: h.title,
        score: h.score,
        mode: h.retrievalMode,
        explanation: h.explanation,
      })),
    },
    status,
  });
  return asRagEvaluationRun(run);
}

export function recordRagFeedback(input: {
  workspaceId: string;
  query: string;
  pageId: string;
  label: 'positive' | 'negative' | 'correction' | 'neutral';
  expectedAnswer?: string | null;
  actualAnswer?: string | null;
  metadata?: Record<string, unknown> | null;
}): AiTrainingExample {
  const example = aiLearningRepo.createTrainingExample({
    workspaceId: input.workspaceId,
    sourceKind: 'rag_feedback',
    sourceId: input.pageId,
    taskType: 'retrieval',
    inputText: input.query,
    expectedOutput: input.expectedAnswer ?? null,
    actualOutput: input.actualAnswer ?? null,
    label: input.label,
    metadata: input.metadata ?? null,
    status: input.label === 'neutral' ? 'candidate' : 'approved',
  });
  return asTrainingExample(example);
}

export function listTrainingExamples(workspaceId: string, limit = 100): AiTrainingExample[] {
  return aiLearningRepo.listTrainingExamples(workspaceId, limit) as AiTrainingExample[];
}

export function listRagEvaluationRuns(workspaceId: string, limit = 100): RagEvaluationRun[] {
  return aiLearningRepo.listRagEvaluationRuns(workspaceId, limit) as RagEvaluationRun[];
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function exampleTrainingScore(example: AiTrainingExample): number | null {
  const metadata = parseMetadata(example.metadataJson);
  return metadataNumber(metadata, 'trainingScore') ?? metadataNumber(metadata, 'learningScore');
}

function readinessStatus(input: {
  total: number;
  usable: number;
  approved: number;
  exported: number;
  avgScore: number;
  ignoredRatio: number;
}): FineTuningReadiness['status'] {
  if (input.total === 0) return 'empty';
  if (input.usable < 10) return 'collecting';
  if (input.approved < Math.max(8, Math.ceil(input.usable * 0.35))) return 'curate';
  if (input.usable >= 30 && input.avgScore >= 0.55 && input.ignoredRatio <= 0.35) {
    return input.exported >= 20 ? 'ready_to_train' : 'ready_to_export';
  }
  return 'curate';
}

function readinessRecommendation(status: FineTuningReadiness['status']): string {
  if (status === 'empty')
    return 'Sem exemplos ainda. Execute tasks reais para gerar memória operacional.';
  if (status === 'collecting')
    return 'Continue coletando execuções com arquivos/detalhes antes de exportar dataset.';
  if (status === 'curate')
    return 'Revise candidatos, aprove exemplos bons e ignore ruído antes de treinar.';
  if (status === 'ready_to_export')
    return 'Dataset pronto para exportar com split treino/validação.';
  return 'Dataset exportado e suficiente para iniciar avaliação/fine-tuning controlado.';
}

export function getFineTuningReadiness(workspaceId: string): FineTuningReadiness {
  const examples = aiLearningRepo.listTrainingExamples(workspaceId, 10_000) as AiTrainingExample[];
  const scoreRows = examples
    .map(exampleTrainingScore)
    .filter((score): score is number => score !== null);
  const avgLearningScore =
    scoreRows.length === 0
      ? 0
      : scoreRows.reduce((sum, score) => sum + score, 0) / scoreRows.length;
  const usable = examples.filter((example) => {
    if (example.status === 'ignored') return false;
    if (!targetOutput(example)) return false;
    return (
      example.label === 'positive' || example.label === 'correction' || example.label === 'neutral'
    );
  });
  const approved = examples.filter((example) => example.status === 'approved').length;
  const exported = examples.filter((example) => example.status === 'exported').length;
  const ignored = examples.filter((example) => example.status === 'ignored').length;
  const invalidatedByUndo = examples.filter(
    (example) => parseMetadata(example.metadataJson).invalidatedBy === 'undo',
  ).length;
  const highQualityExamples = examples.filter((example) => {
    const score = exampleTrainingScore(example);
    return score !== null && score >= 0.65 && example.status !== 'ignored';
  }).length;
  const ignoredRatio = examples.length > 0 ? ignored / examples.length : 0;
  const readinessScore = Math.max(
    0,
    Math.min(
      1,
      (Math.min(usable.length, 60) / 60) * 0.32 +
        (approved + exported > 0 ? Math.min(approved + exported, 40) / 40 : 0) * 0.24 +
        avgLearningScore * 0.28 +
        (1 - ignoredRatio) * 0.16,
    ),
  );
  const sourceMap = new Map<
    string,
    FineTuningReadinessSource & { scoreSum: number; scoreCount: number }
  >();
  for (const example of examples) {
    const metadata = parseMetadata(example.metadataJson);
    const sourceId =
      typeof metadata.sourceId === 'string' && metadata.sourceId.trim() ? metadata.sourceId : null;
    const sourceLabel =
      typeof metadata.sourceLabel === 'string' && metadata.sourceLabel.trim()
        ? metadata.sourceLabel
        : (sourceId ?? 'Workspace');
    const key = sourceId ?? '__workspace__';
    const current = sourceMap.get(key) ?? {
      sourceId,
      sourceLabel,
      total: 0,
      usable: 0,
      ignored: 0,
      avgLearningScore: 0,
      highQuality: 0,
      scoreSum: 0,
      scoreCount: 0,
    };
    current.total++;
    if (example.status === 'ignored') current.ignored++;
    if (usable.some((item) => item.id === example.id)) current.usable++;
    const score =
      metadataNumber(metadata, 'trainingScore') ?? metadataNumber(metadata, 'learningScore');
    if (score !== null) {
      current.scoreSum += score;
      current.scoreCount++;
      if (score >= 0.65 && example.status !== 'ignored') current.highQuality++;
    }
    sourceMap.set(key, current);
  }
  const sources = [...sourceMap.values()]
    .map(({ scoreSum, scoreCount, ...source }) => ({
      ...source,
      avgLearningScore: scoreCount > 0 ? scoreSum / scoreCount : 0,
    }))
    .sort((a, b) => b.usable - a.usable);
  const status = readinessStatus({
    total: examples.length,
    usable: usable.length,
    approved,
    exported,
    avgScore: avgLearningScore,
    ignoredRatio,
  });
  const datasetReady = status === 'ready_to_export' || status === 'ready_to_train';
  const trainingStage: FineTuningReadiness['trainingStage'] =
    examples.length === 0 || usable.length < 10
      ? 'memory_learning'
      : status === 'ready_to_train'
        ? 'adapter_training_pending'
        : datasetReady
          ? 'dataset_ready'
          : status === 'curate'
            ? 'dataset_curation'
            : 'adapter_training_pending';
  return {
    workspaceId,
    totalExamples: examples.length,
    usableExamples: usable.length,
    approvedExamples: approved,
    exportedExamples: exported,
    candidateExamples: examples.filter((example) => example.status === 'candidate').length,
    ignoredExamples: ignored,
    invalidatedByUndo,
    avgLearningScore,
    highQualityExamples,
    readinessScore,
    status,
    datasetReady,
    weightTrainingAvailable: false,
    trainingStage,
    recommendation: readinessRecommendation(status),
    sources,
  };
}

function splitForValidation(id: string, validationRatio: number): boolean {
  const hash = createHash('sha256').update(id).digest();
  const value = hash.readUInt32BE(0) / 0xffffffff;
  return value < validationRatio;
}

function compactDateTime(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function targetOutput(example: AiTrainingExample): string | null {
  if (example.expectedOutput?.trim()) return example.expectedOutput.trim();
  if (example.label === 'positive' && example.actualOutput?.trim()) {
    return example.actualOutput.trim();
  }
  return null;
}

function toChatTrainingLine(example: AiTrainingExample): string | null {
  const output = targetOutput(example);
  if (!output) return null;
  return JSON.stringify({
    messages: [
      {
        role: 'system',
        content:
          'You are Orkestral Forge. Answer with grounded, concise, high-quality work using the provided local context.',
      },
      { role: 'user', content: example.inputText },
      { role: 'assistant', content: output },
    ],
    metadata: {
      id: example.id,
      task_type: example.taskType,
      source_kind: example.sourceKind,
      source_id: example.sourceId,
      label: example.label,
      ...parseMetadata(example.metadataJson),
    },
  });
}

export function toTrajectoryTrainingLine(example: AiTrainingExample): string | null {
  const metadata = parseMetadata(example.metadataJson);
  const trajectory =
    metadata.trajectory && typeof metadata.trajectory === 'object'
      ? (metadata.trajectory as Record<string, unknown>)
      : null;
  const trainingScore = metadataNumber(metadata, 'trainingScore') ?? 0;
  const rejectionReasons = Array.isArray(metadata.trainingRejectionReasons)
    ? metadata.trainingRejectionReasons
    : [];
  if (!trajectory) return null;
  if (rejectionReasons.length > 0) return null;
  if (trainingScore < 0.65) return null;
  const output = targetOutput(example);
  if (!output) return null;
  return JSON.stringify({
    schema: 'orkestral.swe_trajectory.v1',
    id: example.id,
    task_type: example.taskType,
    source_kind: example.sourceKind,
    source_id: example.sourceId,
    label: example.label,
    prompt: example.inputText,
    target: output,
    trajectory,
    reward: {
      score: trainingScore,
      passed:
        trajectory.verification === 'verified' || trajectory.verification === 'not_applicable',
      outcome: trajectory.outcome ?? null,
      verification: trajectory.verification ?? null,
      undo_invalidated: false,
    },
    quality_gate: {
      status: example.status,
      learning_score: metadataNumber(metadata, 'learningScore') ?? null,
      training_score: trainingScore,
      reasons: metadata.trainingScoreReasons ?? [],
      rejection_reasons: rejectionReasons,
      technique: metadata.postTrainingTechnique ?? 'trajectory_curation_rft_ready',
    },
    metadata: {
      issue_key: metadata.issueKey ?? null,
      source_label: metadata.sourceLabel ?? null,
      source_role: trajectory.sourceRole ?? null,
      model_used: trajectory.modelUsed ?? metadata.modelUsed ?? null,
      files_changed: trajectory.filesChanged ?? metadata.filesChanged ?? [],
      captured_at: trajectory.capturedAt ?? null,
    },
  });
}

export function exportTrainingDataset(input: {
  workspaceId: string;
  limit?: number;
  includeCandidates?: boolean;
  validationRatio?: number;
  format?: 'jsonl' | 'chat-jsonl' | 'trajectory-jsonl';
}): TrainingDatasetExport {
  const validationRatio = Math.min(Math.max(input.validationRatio ?? 0.12, 0), 0.5);
  const format = input.format ?? 'chat-jsonl';
  const examples = aiLearningRepo
    .listTrainingExamples(input.workspaceId, input.limit ?? 5000)
    .filter((example) => {
      if (example.status === 'ignored') return false;
      if (example.status === 'approved' || example.status === 'exported') return true;
      return input.includeCandidates === true && example.status === 'candidate';
    }) as AiTrainingExample[];
  const dir = join(resolveWorkspaceDir(input.workspaceId), 'learning');
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(dir, `training-dataset-${date}.${format}.jsonl`);
  const manifestPath = join(dir, `training-dataset-${date}.manifest.json`);
  const train: string[] = [];
  const validation: string[] = [];
  const exportedIds: string[] = [];
  let ignoredCount = 0;
  let gateRejectedCount = 0;

  for (const example of examples) {
    const line =
      format === 'trajectory-jsonl'
        ? toTrajectoryTrainingLine(example)
        : format === 'chat-jsonl'
          ? toChatTrainingLine(example)
          : JSON.stringify({
              id: example.id,
              task_type: example.taskType,
              source_kind: example.sourceKind,
              source_id: example.sourceId,
              label: example.label,
              input: example.inputText,
              expected_output: example.expectedOutput,
              actual_output: example.actualOutput,
              metadata: parseMetadata(example.metadataJson),
            });
    if (!line) {
      ignoredCount++;
      if (format === 'trajectory-jsonl') gateRejectedCount++;
      continue;
    }
    exportedIds.push(example.id);
    if (splitForValidation(example.id, validationRatio)) validation.push(line);
    else train.push(line);
  }

  const lines = [
    ...train.map((line) => JSON.stringify({ split: 'train', ...JSON.parse(line) })),
    ...validation.map((line) => JSON.stringify({ split: 'validation', ...JSON.parse(line) })),
  ];
  writeFileSync(path, `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, 'utf8');
  const manifest = {
    workspaceId: input.workspaceId,
    createdAt: new Date().toISOString(),
    format,
    path,
    trainCount: train.length,
    validationCount: validation.length,
    ignoredCount,
    gateRejectedCount,
    validationRatio,
    includeCandidates: input.includeCandidates === true,
    technique:
      format === 'trajectory-jsonl'
        ? 'trajectory_curation_rft_ready'
        : 'supervised_instruction_dataset',
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  aiLearningRepo.updateTrainingExamplesStatus({ ids: exportedIds, status: 'exported' });
  return {
    path,
    manifestPath,
    format,
    trainCount: train.length,
    validationCount: validation.length,
    ignoredCount,
  };
}

export function exportTrainingPack(input: {
  workspaceId: string;
  limit?: number;
  includeCandidates?: boolean;
  validationRatio?: number;
}): TrainingPackExport {
  const validationRatio = Math.min(Math.max(input.validationRatio ?? 0.12, 0), 0.5);
  const allExamples = aiLearningRepo.listTrainingExamples(
    input.workspaceId,
    input.limit ?? 5000,
  ) as AiTrainingExample[];
  const examples = allExamples.filter((example) => {
    if (example.status === 'ignored') return false;
    if (example.status === 'approved' || example.status === 'exported') return true;
    return input.includeCandidates === true && example.status === 'candidate';
  });
  const dir = join(
    resolveWorkspaceDir(input.workspaceId),
    'learning',
    `training-pack-${compactDateTime()}`,
  );
  mkdirSync(dir, { recursive: true });
  const trainPath = join(dir, 'train.trajectory.jsonl');
  const validationPath = join(dir, 'validation.trajectory.jsonl');
  const rejectedPath = join(dir, 'rejected.trajectory.jsonl');
  const manifestPath = join(dir, 'manifest.json');

  const train: string[] = [];
  const validation: string[] = [];
  const rejected: string[] = [];
  const exportedIds: string[] = [];
  const sourceStats = new Map<
    string,
    { sourceId: string | null; sourceLabel: string; accepted: number; rejected: number }
  >();

  const bumpSource = (metadata: Record<string, unknown>, accepted: boolean): void => {
    const sourceId = typeof metadata.sourceId === 'string' ? metadata.sourceId : null;
    const sourceLabel =
      typeof metadata.sourceLabel === 'string' && metadata.sourceLabel.trim()
        ? metadata.sourceLabel
        : (sourceId ?? 'Workspace');
    const key = sourceId ?? '__workspace__';
    const current = sourceStats.get(key) ?? { sourceId, sourceLabel, accepted: 0, rejected: 0 };
    if (accepted) current.accepted++;
    else current.rejected++;
    sourceStats.set(key, current);
  };

  for (const example of examples) {
    const metadata = parseMetadata(example.metadataJson);
    const line = toTrajectoryTrainingLine(example);
    if (!line) {
      rejected.push(
        JSON.stringify({
          id: example.id,
          source_kind: example.sourceKind,
          source_id: example.sourceId,
          status: example.status,
          label: example.label,
          training_score: metadataNumber(metadata, 'trainingScore'),
          learning_score: metadataNumber(metadata, 'learningScore'),
          rejection_reasons: metadata.trainingRejectionReasons ?? ['not_trajectory_ready'],
          invalidated_by: metadata.invalidatedBy ?? null,
          issue_key: metadata.issueKey ?? null,
          source_label: metadata.sourceLabel ?? null,
        }),
      );
      bumpSource(metadata, false);
      continue;
    }
    exportedIds.push(example.id);
    bumpSource(metadata, true);
    if (splitForValidation(example.id, validationRatio)) validation.push(line);
    else train.push(line);
  }

  writeFileSync(trainPath, `${train.join('\n')}${train.length > 0 ? '\n' : ''}`, 'utf8');
  writeFileSync(
    validationPath,
    `${validation.join('\n')}${validation.length > 0 ? '\n' : ''}`,
    'utf8',
  );
  writeFileSync(rejectedPath, `${rejected.join('\n')}${rejected.length > 0 ? '\n' : ''}`, 'utf8');

  const approvedInputCount = examples.filter((example) => example.status === 'approved').length;
  const candidateInputCount = examples.filter((example) => example.status === 'candidate').length;
  const ignoredInputCount = allExamples.filter((example) => example.status === 'ignored').length;
  const manifest = {
    schema: 'orkestral.training_pack.v1',
    workspaceId: input.workspaceId,
    createdAt: new Date().toISOString(),
    technique: 'trajectory_curation_rft_ready',
    format: 'trajectory-jsonl',
    validationRatio,
    includeCandidates: input.includeCandidates === true,
    files: {
      train: trainPath,
      validation: validationPath,
      rejected: rejectedPath,
    },
    counts: {
      input: examples.length,
      train: train.length,
      validation: validation.length,
      accepted: train.length + validation.length,
      rejected: rejected.length,
      approvedInput: approvedInputCount,
      candidateInput: candidateInputCount,
      ignoredInput: ignoredInputCount,
    },
    gates: {
      minTrainingScore: 0.65,
      requiresTrajectory: true,
      rejectsUndoInvalidated: true,
      rejectsUnverified: true,
      acceptedStatuses:
        input.includeCandidates === true
          ? ['approved', 'exported', 'candidate']
          : ['approved', 'exported'],
    },
    sources: [...sourceStats.values()].sort((a, b) => b.accepted - a.accepted),
    nextSteps: [
      'Use train.trajectory.jsonl for SFT/RFT adapter training.',
      'Use validation.trajectory.jsonl for holdout evaluation before accepting an adapter.',
      'Review rejected.trajectory.jsonl to improve data quality and curation rules.',
      'Never train on examples invalidated by undo or unverified execution.',
    ],
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  aiLearningRepo.updateTrainingExamplesStatus({ ids: exportedIds, status: 'exported' });

  return {
    dir,
    manifestPath,
    trainPath,
    validationPath,
    rejectedPath,
    format: 'trajectory-jsonl',
    trainCount: train.length,
    validationCount: validation.length,
    rejectedCount: rejected.length,
    approvedInputCount,
    candidateInputCount,
    ignoredInputCount,
  };
}

export function curateTrainingExample(input: {
  id: string;
  status?: 'candidate' | 'approved' | 'exported' | 'ignored';
  label?: 'positive' | 'negative' | 'correction' | 'neutral';
  expectedOutput?: string | null;
  actualOutput?: string | null;
  metadata?: Record<string, unknown> | null;
}): AiTrainingExample | null {
  return aiLearningRepo.updateTrainingExample(input) as AiTrainingExample | null;
}

export async function runRagBenchmarkFromFeedback(input: {
  workspaceId: string;
  limit?: number;
}): Promise<RagBenchmarkSummary> {
  const examples = aiLearningRepo
    .listTrainingExamples(input.workspaceId, input.limit ?? 200)
    .filter(
      (example) =>
        example.sourceKind === 'rag_feedback' &&
        !!example.sourceId &&
        (example.label === 'positive' || example.label === 'correction') &&
        (example.status === 'approved' || example.status === 'exported'),
    );
  const runs: RagEvaluationRun[] = [];
  for (const example of examples) {
    runs.push(
      await evaluateRagQuery({
        workspaceId: input.workspaceId,
        query: example.inputText,
        expectedPageIds: [example.sourceId!],
        limit: 10,
      }),
    );
  }
  const metricRows = runs.map(
    (run) =>
      run.metricsJson as {
        precisionAtK?: number;
        recallAtK?: number;
        mrr?: number;
      },
  );
  const avg = (key: 'precisionAtK' | 'recallAtK' | 'mrr'): number =>
    metricRows.length === 0
      ? 0
      : metricRows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0) / metricRows.length;
  return {
    total: runs.length,
    passed: runs.filter((run) => run.status === 'passed').length,
    failed: runs.filter((run) => run.status === 'failed').length,
    needsReview: runs.filter((run) => run.status === 'needs_review').length,
    avgPrecisionAtK: avg('precisionAtK'),
    avgRecallAtK: avg('recallAtK'),
    avgMrr: avg('mrr'),
    runIds: runs.map((run) => run.id),
  };
}

// Nº de palavras do trecho de conteúdo usado como query do goldset automático.
const RAG_QUERY_SNIPPET_WORDS = 12;

/**
 * Extrai um trecho de conteúdo "saliente" da página para usar como query do
 * benchmark — as primeiras ~N palavras do corpo APÓS remover o título/heading
 * markdown. Usar o próprio título como query vazava a resposta (title-echo),
 * inflando artificialmente o retrieval; o trecho de conteúdo mede recuperação
 * real. Retorna '' quando não sobra conteúdo útil.
 */
function contentSnippetQuery(contentMd: string): string {
  const lines = contentMd.split('\n');
  // Pula a primeira linha de heading markdown (#, ##, …) e linhas vazias iniciais.
  let start = 0;
  while (start < lines.length && (lines[start]!.trim() === '' || /^#{1,6}\s/.test(lines[start]!))) {
    start++;
  }
  const body = lines
    .slice(start)
    .join(' ')
    // Tira marcação markdown comum (ênfase, código inline, links) p/ não poluir a query.
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return body.split(' ').slice(0, RAG_QUERY_SNIPPET_WORDS).join(' ').trim();
}

export async function runAutomaticSourceRagBenchmark(input: {
  workspaceId: string;
  sourceId: string;
  sourceLabel?: string | null;
  limit?: number;
}): Promise<RagBenchmarkSummary> {
  const pages = new KbPageRepository()
    .listByWorkspace(input.workspaceId, false)
    .filter(
      (page) => page.sourceId === input.sourceId && (page.contentMd ?? '').trim().length >= 120,
    )
    .sort((a, b) => (b.contentMd ?? '').length - (a.contentMd ?? '').length)
    .slice(0, Math.min(Math.max(input.limit ?? 8, 1), 16));
  const runs: RagEvaluationRun[] = [];
  // Pula títulos vazios/duplicados — golds ambíguos sujam a métrica.
  const seenTitles = new Set<string>();
  for (const page of pages) {
    const normalizedTitle = page.title.trim().toLowerCase();
    if (!normalizedTitle || seenTitles.has(normalizedTitle)) continue;
    seenTitles.add(normalizedTitle);
    const query = contentSnippetQuery(page.contentMd ?? '');
    if (!query) continue;
    const run = await evaluateRagQuery({
      workspaceId: input.workspaceId,
      query,
      expectedPageIds: [page.id],
      limit: 10,
      metadata: {
        automatic: true,
        sourceId: input.sourceId,
        sourceLabel: input.sourceLabel ?? null,
        expectedTitle: page.title,
      },
    });
    runs.push(run);
  }
  const metricRows = runs.map(
    (run) =>
      run.metricsJson as {
        precisionAtK?: number;
        recallAtK?: number;
        mrr?: number;
      },
  );
  const avg = (key: 'precisionAtK' | 'recallAtK' | 'mrr'): number =>
    metricRows.length === 0
      ? 0
      : metricRows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0) / metricRows.length;
  return {
    total: runs.length,
    passed: runs.filter((run) => run.status === 'passed').length,
    failed: runs.filter((run) => run.status === 'failed').length,
    needsReview: runs.filter((run) => run.status === 'needs_review').length,
    avgPrecisionAtK: avg('precisionAtK'),
    avgRecallAtK: avg('recallAtK'),
    avgMrr: avg('mrr'),
    runIds: runs.map((run) => run.id),
  };
}
