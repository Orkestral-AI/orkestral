import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';
import { KbPageRepository } from '../db/repositories/kb-page.repo';
import { kbAnalysisJobRepo } from '../db/repositories/kb-analysis-job.repo';
import { kbEmbeddingJobRepo } from '../db/repositories/kb-embedding-job.repo';
import { listSourceAgentAssignments } from './source-agent-assignment-service';
import type {
  KbEmbeddingJobSummary,
  KbSourceCoverageSummary,
  WorkspaceSource,
} from '../../shared/types';

const sourceRepo = new WorkspaceSourceRepository();
const pageRepo = new KbPageRepository();

function sourceLocation(source: WorkspaceSource): string | null {
  return source.path ?? source.repoFullName ?? null;
}

function healthFor(input: {
  pageCount: number;
  analysis: KbSourceCoverageSummary['latestAnalysis'];
  embedding: KbEmbeddingJobSummary | null;
}): KbSourceCoverageSummary['health'] {
  if (input.analysis?.status === 'failed' || input.embedding?.status === 'failed') return 'failed';
  if (
    input.analysis?.status === 'queued' ||
    input.analysis?.status === 'running' ||
    input.embedding?.status === 'queued' ||
    input.embedding?.status === 'running'
  ) {
    return 'indexing';
  }
  if (input.pageCount === 0) return 'empty';
  if (input.analysis?.status === 'completed' && input.embedding?.status === 'completed')
    return 'ready';
  return 'stale';
}

export function listKbSourceCoverage(workspaceId: string): KbSourceCoverageSummary[] {
  const sources = sourceRepo.listByWorkspace(workspaceId);
  const pages = pageRepo.listByWorkspace(workspaceId, true);
  const analysisJobs = kbAnalysisJobRepo.listByWorkspace(workspaceId, 200);
  const embeddingJobs = kbEmbeddingJobRepo.listByWorkspace(workspaceId, 200);
  const assignments = listSourceAgentAssignments(workspaceId);

  return sources.map((source) => {
    const sourcePages = pages.filter((page) => page.sourceId === source.id);
    const latestAnalysis = analysisJobs.find((job) => job.sourceId === source.id) ?? null;
    const latestEmbedding =
      embeddingJobs.find((job) => job.sourceId === source.id) ??
      (latestAnalysis?.embeddingJobId
        ? (embeddingJobs.find((job) => job.id === latestAnalysis.embeddingJobId) ?? null)
        : null);
    const assignment = assignments.find((item) => item.sourceId === source.id) ?? null;
    return {
      sourceId: source.id,
      sourceLabel: source.label,
      sourceKind: source.kind,
      sourceRole: source.role,
      location: sourceLocation(source),
      pageCount: sourcePages.filter((page) => !page.isArchived).length,
      autoPageCount: sourcePages.filter(
        (page) => page.kind === 'auto-generated' && !page.isArchived,
      ).length,
      filesScanned: latestAnalysis?.filesScanned ?? 0,
      coveragePages: latestAnalysis?.coveragePages ?? 0,
      latestAnalysis,
      latestEmbedding,
      assignment,
      health: healthFor({
        pageCount: sourcePages.length,
        analysis: latestAnalysis,
        embedding: latestEmbedding,
      }),
      updatedAt:
        latestEmbedding?.completedAt ??
        latestAnalysis?.completedAt ??
        latestAnalysis?.startedAt ??
        source.updatedAt,
    };
  });
}
