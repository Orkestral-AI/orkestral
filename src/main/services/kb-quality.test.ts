import { describe, expect, it, vi } from 'vitest';
import { evaluateRagQuery, toTrajectoryTrainingLine } from './kb-quality';
import type { AiTrainingExample, KbSearchHit } from '../../shared/types';

// `evaluateRagQuery` chama `searchPages` (busca, toca DB) e o repositório
// (escrita). Mockamos ambos para testar SÓ a lógica pura de scoring sem subir
// runtime de embedding nem Electron/SQLite. O mock do repo devolve a própria
// linha inserida (como o repo real), então o `status` calculado flui para o run.
const ragHits: KbSearchHit[] = [];

vi.mock('./kb-service', () => ({
  searchPages: vi.fn(async () => ragHits.slice()),
}));

vi.mock('../db/repositories/ai-learning.repo', () => ({
  aiLearningRepo: {
    createRagEvaluationRun: (input: {
      workspaceId: string;
      query: string;
      expectedPageIds: string[];
      resultPageIds: string[];
      metrics: Record<string, unknown>;
      status: 'passed' | 'failed' | 'needs_review';
    }) => ({
      id: 'run-1',
      workspaceId: input.workspaceId,
      query: input.query,
      expectedPageIdsJson: input.expectedPageIds,
      resultPageIdsJson: input.resultPageIds,
      metricsJson: input.metrics,
      status: input.status,
      createdAt: '2026-06-18T00:00:00.000Z',
    }),
  },
}));

function setRagHits(pageIds: string[]): void {
  ragHits.length = 0;
  for (const pageId of pageIds) {
    ragHits.push({
      pageId,
      title: pageId,
      slug: pageId,
      sourceId: 'src-1',
      excerpt: '',
      score: 1,
      retrievalMode: 'hybrid',
    });
  }
}

function example(metadata: Record<string, unknown>): AiTrainingExample {
  return {
    id: 'example-1',
    workspaceId: 'workspace-1',
    sourceKind: 'issue_run',
    sourceId: 'issue-1',
    taskType: 'code',
    inputText: 'Issue: adicionar telefone no cadastro',
    expectedOutput: 'Patch aplicado com campo phone e validação concluída.',
    actualOutput: 'Patch aplicado com campo phone e validação concluída.',
    label: 'positive',
    metadataJson: JSON.stringify(metadata),
    status: 'approved',
    createdAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
  };
}

describe('toTrajectoryTrainingLine', () => {
  it('serializes only verified high-quality trajectories for post-training', () => {
    const line = toTrajectoryTrainingLine(
      example({
        trainingScore: 0.82,
        trainingScoreReasons: ['verified_execution:+0.22'],
        trainingRejectionReasons: [],
        postTrainingTechnique: 'trajectory_curation_rft_ready',
        issueKey: 12,
        sourceLabel: 'web',
        filesChanged: ['src/register.tsx'],
        trajectory: {
          schemaVersion: 1,
          issueId: 'issue-1',
          issueKey: 12,
          runId: 'run-1',
          workspaceId: 'workspace-1',
          sourceId: 'source-1',
          sourceLabel: 'web',
          sourceRole: 'frontend',
          agentName: 'Frontend Agent',
          modelUsed: 'local',
          outcome: 'done',
          verification: 'verified',
          filesChanged: ['src/register.tsx'],
          contextPack: 'prior memory',
          changeBlock: '<orkestral:code-changes />',
          capturedAt: '2026-06-14T00:00:00.000Z',
        },
      }),
    );

    expect(line).toBeTruthy();
    const parsed = JSON.parse(line!);
    expect(parsed.schema).toBe('orkestral.swe_trajectory.v1');
    expect(parsed.reward).toMatchObject({
      score: 0.82,
      passed: true,
      verification: 'verified',
      undo_invalidated: false,
    });
    expect(parsed.quality_gate.technique).toBe('trajectory_curation_rft_ready');
  });

  it('rejects trajectories with rejection reasons or low score', () => {
    expect(
      toTrajectoryTrainingLine(
        example({
          trainingScore: 0.8,
          trainingRejectionReasons: ['unverified_execution'],
          trajectory: { verification: 'unverified', outcome: 'done' },
        }),
      ),
    ).toBeNull();

    expect(
      toTrajectoryTrainingLine(
        example({
          trainingScore: 0.4,
          trainingRejectionReasons: [],
          trajectory: { verification: 'verified', outcome: 'done' },
        }),
      ),
    ).toBeNull();
  });
});

/**
 * Gate de aprovação do benchmark RAG é por POSIÇÃO (página-ouro dentro do
 * top-K), não por precisão — o antigo gate por precisão (>=0.2) era impossível
 * de passar com 1 gold em até 10 resultados (precisão máxima 0.1), reprovando
 * todo caso mesmo com recall alto.
 */
describe('evaluateRagQuery — gate de aprovação por posição', () => {
  it('aprova quando a página-ouro está no rank 0 entre 10 resultados (regressão do gate por precisão)', async () => {
    const resultIds = Array.from({ length: 10 }, (_, i) => (i === 0 ? 'gold' : `noise-${i}`));
    setRagHits(resultIds);
    const run = await evaluateRagQuery({
      workspaceId: 'ws-1',
      query: 'consulta',
      expectedPageIds: ['gold'],
      limit: 10,
    });
    expect(run.status).toBe('passed');
    // precisionAtK segue sendo 0.1 (1/10) — não deve mais reprovar.
    expect((run.metricsJson as { precisionAtK: number }).precisionAtK).toBeCloseTo(0.1);
  });

  it('reprova quando a página-ouro está ausente dos resultados', async () => {
    setRagHits(Array.from({ length: 10 }, (_, i) => `noise-${i}`));
    const run = await evaluateRagQuery({
      workspaceId: 'ws-1',
      query: 'consulta',
      expectedPageIds: ['gold'],
      limit: 10,
    });
    expect(run.status).toBe('failed');
  });

  it('reprova quando a página-ouro está no rank 5 com K=3 (gate de posição funciona)', async () => {
    const resultIds = Array.from({ length: 10 }, (_, i) => (i === 5 ? 'gold' : `noise-${i}`));
    setRagHits(resultIds);
    const run = await evaluateRagQuery({
      workspaceId: 'ws-1',
      query: 'consulta',
      expectedPageIds: ['gold'],
      limit: 10,
    });
    // recall=1 mas rank 5 > top-K (3) → reprova.
    expect(run.status).toBe('failed');
  });

  it('marca needs_review quando não há gold esperado', async () => {
    setRagHits(['page-a', 'page-b']);
    const run = await evaluateRagQuery({
      workspaceId: 'ws-1',
      query: 'consulta',
      expectedPageIds: [],
      limit: 10,
    });
    expect(run.status).toBe('needs_review');
  });
});
