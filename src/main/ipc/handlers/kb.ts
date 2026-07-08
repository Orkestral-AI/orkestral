import { registerHandler } from '../register';
import {
  cancelEmbeddingIndexJob,
  createPage,
  deletePage,
  getBkfInfo,
  getEmbeddingJobs,
  getGraph,
  getPageWithBacklinks,
  listPages,
  pageTree,
  rebuildSnapshots,
  resolveWikilink,
  searchPages,
  updatePage,
} from '../../services/kb-service';
import { analyzeSource, cancelAnalyze } from '../../services/kb-repo-analyzer';
import { analyzeKnowledgeCleanup } from '../../services/knowledge-cleanup';
import { requestSourceAnalysis } from '../../services/kb-request-analysis';
import {
  evaluateRagQuery,
  exportTrainingDataset,
  exportTrainingPack,
  curateTrainingExample,
  listRagEvaluationRuns,
  listTrainingExamples,
  getFineTuningReadiness,
  recordRagFeedback,
  runRagBenchmarkFromFeedback,
} from '../../services/kb-quality';
import {
  executeIssue,
  cancelIssueExecution,
  stopAllExecution,
  approveSessionPlan,
} from '../../services/issue-execution-service';
import { getLatestQaValidation } from '../../services/qa-validation-service';
import { qaValidationRepo } from '../../db/repositories/qa-validation.repo';
import { IssueRepository } from '../../db/repositories/issue.repo';
import { IssueExecutionEventRepository } from '../../db/repositories/issue-execution-event.repo';
import { kbAnalysisJobRepo } from '../../db/repositories/kb-analysis-job.repo';
import { listKbSourceCoverage } from '../../services/kb-source-coverage-service';

const _issueRepo = new IssueRepository();
const _issueExecutionEventRepo = new IssueExecutionEventRepository();

export function registerKbHandlers(): void {
  registerHandler('kb:list-pages', ({ workspaceId, includeArchived }) => {
    return listPages(workspaceId, includeArchived ?? false);
  });

  registerHandler('kb:tree', ({ workspaceId }) => {
    return pageTree(workspaceId);
  });

  registerHandler('kb:get-page', ({ pageId }) => {
    return getPageWithBacklinks(pageId);
  });

  registerHandler('kb:resolve-wikilink', ({ workspaceId, label }) => {
    return resolveWikilink(workspaceId, label);
  });

  registerHandler('kb:create-page', (input) => {
    return createPage(input);
  });

  registerHandler('kb:update-page', (input) => {
    const updated = updatePage(input);
    // Edição direta do usuário: se a página não existe mais, é erro real (≠ do race
    // silencioso da análise em background, que o updatePage tolera devolvendo null).
    if (!updated) throw new Error('Página não encontrada');
    return updated;
  });

  registerHandler('kb:delete-page', ({ pageId }) => {
    deletePage(pageId);
    return { ok: true as const };
  });

  registerHandler('kb:search', ({ workspaceId, query, limit, filters }) => {
    return searchPages(workspaceId, query, limit, filters);
  });

  registerHandler('kb:get-graph', ({ workspaceId }) => {
    return getGraph(workspaceId);
  });

  registerHandler('kb:rebuild-snapshots', ({ workspaceId }) => {
    return rebuildSnapshots(workspaceId);
  });

  registerHandler('kb:get-bkf-info', ({ workspaceId }) => {
    return getBkfInfo(workspaceId);
  });

  registerHandler('kb:cleanup-suggestions', ({ workspaceId }) => {
    return analyzeKnowledgeCleanup(workspaceId);
  });

  registerHandler('kb:embedding-status', ({ workspaceId }) => {
    return getEmbeddingJobs(workspaceId);
  });

  registerHandler('kb:analysis-status', ({ workspaceId }) => {
    return kbAnalysisJobRepo.listByWorkspace(workspaceId);
  });

  registerHandler('kb:source-coverage', ({ workspaceId }) => {
    return listKbSourceCoverage(workspaceId);
  });

  registerHandler('kb:cancel-embedding-job', ({ jobId }) => {
    return { cancelled: cancelEmbeddingIndexJob(jobId) };
  });

  registerHandler('kb:evaluate-rag', (input) => {
    return evaluateRagQuery(input);
  });

  registerHandler('kb:list-rag-evaluations', ({ workspaceId, limit }) => {
    return listRagEvaluationRuns(workspaceId, limit);
  });

  registerHandler('kb:record-rag-feedback', (input) => {
    return recordRagFeedback(input);
  });

  registerHandler('kb:list-training-examples', ({ workspaceId, limit }) => {
    return listTrainingExamples(workspaceId, limit);
  });

  registerHandler('kb:fine-tuning-readiness', ({ workspaceId }) => {
    return getFineTuningReadiness(workspaceId);
  });

  registerHandler('kb:curate-training-example', (input) => {
    return curateTrainingExample(input);
  });

  registerHandler('kb:export-training-dataset', (input) => {
    return exportTrainingDataset(input);
  });

  registerHandler('kb:export-training-pack', (input) => {
    return exportTrainingPack(input);
  });

  registerHandler('kb:run-rag-benchmark', (input) => {
    return runRagBenchmarkFromFeedback(input);
  });

  registerHandler('kb:analyze-source', ({ workspaceId, sourceId }) => {
    // Guard de duplicidade: duplo clique não deve disparar 2 análises do mesmo
    // source. Se já há um job queued/running, devolve o jobId dele.
    const active = kbAnalysisJobRepo.findActiveBySource(sourceId);
    if (active) return { jobId: active.id };
    return analyzeSource(workspaceId, sourceId);
  });

  registerHandler('kb:cancel-analyze', ({ jobId }) => {
    const cancelled = cancelAnalyze(jobId);
    return { cancelled };
  });

  registerHandler('kb:request-source-analysis', ({ workspaceId, sourceId }) => {
    return requestSourceAnalysis(workspaceId, sourceId);
  });

  registerHandler('issue:execute', ({ issueId }) => {
    return executeIssue(issueId);
  });

  registerHandler('qa:list-validations', ({ issueId }) => {
    return qaValidationRepo.listByIssue(issueId);
  });

  registerHandler('qa:get-latest-validation', ({ issueId }) => {
    return getLatestQaValidation(issueId);
  });

  registerHandler('issues:run-plan', ({ workspaceId, sessionId, selectedEpicIds, replanEpics }) =>
    // Núcleo compartilhado (mesma lógica usada pela aprovação por WhatsApp): aprova/roda
    // o plano da sessão; selectedEpicIds limita aos épicos escolhidos; replanEpics segura
    // o épico + comenta. Sem ambos = aprova o plano TODO.
    approveSessionPlan(workspaceId, sessionId, { selectedEpicIds, replanEpics }),
  );

  registerHandler('issue:cancel-execution', ({ issueId }) => {
    const cancelled = cancelIssueExecution(issueId);
    return { cancelled };
  });

  // STOP GLOBAL: o botão de parar do chat mata TODOS os runs do workspace + halta o
  // plano (não só o stream do chat). Instantâneo: SIGTERM→SIGKILL nos processos ativos.
  registerHandler('exec:stop-all', ({ workspaceId }) => {
    return stopAllExecution(workspaceId);
  });

  registerHandler('issue:list-runs', ({ issueId }) => {
    return _issueRepo.listRuns(issueId);
  });

  registerHandler('issue:list-execution-events', ({ issueIds, limitPerIssue }) => {
    return _issueExecutionEventRepo.listByIssues(issueIds, limitPerIssue ?? 200);
  });

  registerHandler('issue:get-by-key', ({ workspaceId, issueKey }) => {
    return _issueRepo.getByKey(workspaceId, issueKey);
  });
}
