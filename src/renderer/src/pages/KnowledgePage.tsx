import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Database,
  Download,
  Eye,
  FileText,
  GitBranch,
  Plus,
  Loader2,
  Sparkles,
  XCircle,
  UserPlus,
} from 'lucide-react';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import type {
  AiTrainingExample,
  FineTuningReadiness,
  KbBacklink,
  KbPage,
  KbSourceCoverageSummary,
  RagBenchmarkSummary,
  RagEvaluationRun,
} from '@shared/types';
import { KbBlockEditor } from '@renderer/components/knowledge/KbBlockEditor';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useT } from '@renderer/i18n';
import { toast } from '@renderer/stores/toastStore';

export function KnowledgePage() {
  const { pageId } = useParams<{ pageId?: string }>();
  const navigate = useNavigate();
  const workspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const { t } = useT();

  const treeQuery = useQuery({
    queryKey: ['kb-tree', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['kb:tree']({ workspaceId: workspace!.id }),
    refetchInterval: 20_000,
  });

  const pageQuery = useQuery({
    queryKey: ['kb-page', pageId],
    enabled: !!pageId,
    queryFn: () => window.orkestral['kb:get-page']({ pageId: pageId! }),
  });

  const createPage = useMutation({
    mutationFn: () =>
      window.orkestral['kb:create-page']({
        workspaceId: workspace!.id,
        title: t('knowledge.newPageTitle'),
        kind: 'doc',
      }),
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ['kb-tree'] });
      navigate(`/knowledge/${page.id}`);
    },
  });

  if (!workspace) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('knowledge.selectWorkspaceFirst')}
        </div>
      </Shell>
    );
  }

  // Sem página selecionada — index com cards de páginas recentes
  if (!pageId) {
    return (
      <Shell>
        <KnowledgeIndex
          workspaceId={workspace.id}
          pages={treeQuery.data ?? []}
          onCreate={() => createPage.mutate()}
          onOpen={(id) => navigate(`/knowledge/${id}`)}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      {pageQuery.data ? (
        <KbPageEditor page={pageQuery.data.page} backlinks={pageQuery.data.backlinks} />
      ) : pageQuery.isPending ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('knowledge.pageNotFound')}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {children}
      </div>
    </div>
  );
}

// ============================================================================
// Index — quando entra em /knowledge sem id
// ============================================================================

function KnowledgeIndex({
  workspaceId,
  pages,
  onCreate,
  onOpen,
}: {
  workspaceId: string;
  pages: Array<{ id: string; title: string; kind: string; descendantCount: number }>;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [curationOpen, setCurationOpen] = useState(false);
  const knowledgeSettings = useSettingsStore((s) => s.settings?.knowledge);
  const updateKnowledge = useSettingsStore((s) => s.updateKnowledge);
  const coverageQuery = useQuery({
    queryKey: ['kb-source-coverage', workspaceId],
    queryFn: () => window.orkestral['kb:source-coverage']({ workspaceId }),
    refetchInterval: 15_000,
  });
  const readinessQuery = useQuery({
    queryKey: ['kb-fine-tuning-readiness', workspaceId],
    queryFn: () => window.orkestral['kb:fine-tuning-readiness']({ workspaceId }),
    refetchInterval: 20_000,
  });
  const ragEvaluationQuery = useQuery({
    queryKey: ['kb-rag-evaluations', workspaceId],
    queryFn: () => window.orkestral['kb:list-rag-evaluations']({ workspaceId, limit: 50 }),
    refetchInterval: 30_000,
  });
  const trainingExamplesQuery = useQuery({
    queryKey: ['kb-training-examples', workspaceId],
    enabled: curationOpen,
    queryFn: () => window.orkestral['kb:list-training-examples']({ workspaceId, limit: 200 }),
    refetchInterval: curationOpen ? 20_000 : false,
  });
  const createSpecialist = useMutation({
    mutationFn: (sourceId: string) =>
      window.orkestral['agent:create-source-specialist']({ workspaceId, sourceId }),
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ['agent'] });
      queryClient.invalidateQueries({ queryKey: ['agent:list'] });
      queryClient.invalidateQueries({ queryKey: ['kb-source-coverage', workspaceId] });
      toast.success(t('knowledge.coverage.agentCreated', { name: agent.name }));
    },
    onError: (err) => {
      toast.error(
        t('knowledge.coverage.agentCreateFailed'),
        err instanceof Error ? err.message : String(err),
      );
    },
  });
  const analyzeSource = useMutation({
    mutationFn: (sourceId: string) =>
      window.orkestral['kb:analyze-source']({ workspaceId, sourceId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb-source-coverage', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['kb-fine-tuning-readiness', workspaceId] });
    },
  });
  const exportDataset = useMutation({
    mutationFn: () =>
      window.orkestral['kb:export-training-dataset']({
        workspaceId,
        includeCandidates: false,
        format: 'chat-jsonl',
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['kb-fine-tuning-readiness', workspaceId] });
      toast.success(
        t('knowledge.fineTuning.exportedTitle'),
        t('knowledge.fineTuning.exportedBody', {
          train: result.trainCount,
          validation: result.validationCount,
        }),
      );
    },
    onError: (err) => {
      toast.error(
        t('knowledge.fineTuning.exportFailed'),
        err instanceof Error ? err.message : String(err),
      );
    },
  });
  const curateExample = useMutation({
    mutationFn: (input: {
      id: string;
      status?: AiTrainingExample['status'];
      label?: AiTrainingExample['label'];
      expectedOutput?: string | null;
      actualOutput?: string | null;
      metadata?: Record<string, unknown> | null;
    }) => window.orkestral['kb:curate-training-example'](input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb-training-examples', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['kb-fine-tuning-readiness', workspaceId] });
    },
    onError: (err) => {
      toast.error(
        t('knowledge.fineTuning.curationFailed'),
        err instanceof Error ? err.message : String(err),
      );
    },
  });
  const ragBenchmark = useMutation({
    mutationFn: () => window.orkestral['kb:run-rag-benchmark']({ workspaceId, limit: 100 }),
    onSuccess: (summary) => {
      queryClient.invalidateQueries({ queryKey: ['kb-rag-evaluations', workspaceId] });
      toast.success(
        t('knowledge.rag.benchmarkDone'),
        t('knowledge.rag.benchmarkDoneBody', { total: summary.total }),
      );
    },
    onError: (err) => {
      toast.error(
        t('knowledge.rag.benchmarkFailed'),
        err instanceof Error ? err.message : String(err),
      );
    },
  });
  const recent = pages.slice(0, 24);
  // Subtitle embeds a styled <code>[[...]]</code> token. Translate the full
  // sentence with a {wikilink} placeholder, then split on it to inject the JSX.
  const [subtitlePre, subtitlePost] = t('knowledge.index.subtitle').split('{wikilink}');
  return (
    <div className="thin-scrollbar flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div className="flex items-center gap-3">
          <Brain className="h-6 w-6 text-text-secondary" />
          <h1 className="text-[22px] font-semibold tracking-tight text-text-primary">
            {t('knowledge.title')}
          </h1>
        </div>
        <p className="mt-2 text-[13px] text-text-muted">
          {subtitlePre}
          <code className="rounded bg-surface-active px-1 py-0.5 text-[11.5px]">[[...]]</code>
          {subtitlePost}
        </p>

        <button
          type="button"
          onClick={onCreate}
          className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-accent-blue/15 px-3 py-1.5 text-[12.5px] font-medium text-accent-blue hover:bg-accent-blue/25"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('knowledge.index.createPage')}
        </button>

        <SourceCoverageDashboard
          rows={coverageQuery.data ?? []}
          loading={coverageQuery.isPending}
          creatingSourceId={createSpecialist.variables ?? null}
          analyzingSourceId={analyzeSource.variables ?? null}
          onCreateAgent={(sourceId) => createSpecialist.mutate(sourceId)}
          onAnalyze={(sourceId) => analyzeSource.mutate(sourceId)}
        />

        <FineTuningReadinessPanel
          report={readinessQuery.data ?? null}
          loading={readinessQuery.isPending}
          exporting={exportDataset.isPending}
          onExport={() => exportDataset.mutate()}
          onOpenCuration={() => setCurationOpen(true)}
        />

        <RagQualityPanel
          evaluations={ragEvaluationQuery.data ?? []}
          running={ragBenchmark.isPending}
          latestSummary={ragBenchmark.data ?? null}
          onRun={() => ragBenchmark.mutate()}
        />

        <TrainingCurationDialog
          open={curationOpen}
          onOpenChange={setCurationOpen}
          examples={trainingExamplesQuery.data ?? []}
          loading={trainingExamplesQuery.isPending}
          mutatingId={curateExample.variables?.id ?? null}
          autoApproval={knowledgeSettings?.autoApproveTrainingExamples ?? false}
          autoApprovalMinScore={knowledgeSettings?.autoApprovalMinScore ?? 0.72}
          onAutoApprovalChange={(enabled) =>
            updateKnowledge({ autoApproveTrainingExamples: enabled })
          }
          onCurate={(input) => curateExample.mutate(input)}
        />

        {recent.length === 0 ? (
          <div className="mt-10 rounded-lg border border-dashed border-hairline-strong px-6 py-10 text-center">
            <p className="text-[13px] text-text-muted">{t('knowledge.index.empty')}</p>
          </div>
        ) : (
          <>
            <h2 className="mt-10 text-[11px] font-medium uppercase tracking-wider text-text-faint">
              {t('knowledge.index.recentPages')}
            </h2>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {recent.map((p) => {
                const Icon = p.kind === 'auto-generated' ? Sparkles : FileText;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onOpen(p.id)}
                    className="group flex items-center gap-2.5 rounded-lg border border-hairline bg-surface-faint px-3 py-2.5 text-left transition-colors hover:border-hairline-vivid hover:bg-surface-2"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-text-muted group-hover:text-text-primary" />
                    <span className="flex-1 truncate text-[13px] text-text-primary">{p.title}</span>
                    {p.descendantCount > 0 && (
                      <span className="font-mono text-[10px] text-text-faint">
                        {p.descendantCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SourceCoverageDashboard({
  rows,
  loading,
  creatingSourceId,
  analyzingSourceId,
  onCreateAgent,
  onAnalyze,
}: {
  rows: KbSourceCoverageSummary[];
  loading: boolean;
  creatingSourceId: string | null;
  analyzingSourceId: string | null;
  onCreateAgent: (sourceId: string) => void;
  onAnalyze: (sourceId: string) => void;
}) {
  const { t } = useT();
  if (loading) {
    return (
      <div className="mt-7 rounded-lg border border-hairline bg-surface-veil px-4 py-4 text-[12px] text-text-muted">
        <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />
        {t('knowledge.coverage.loading')}
      </div>
    );
  }
  if (rows.length === 0) return null;

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-text-faint">
            {t('knowledge.coverage.title')}
          </h2>
          <p className="mt-1 text-[11.5px] text-text-muted">
            {t('knowledge.coverage.description')}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2">
        {rows.map((row) => (
          <CoverageRow
            key={row.sourceId}
            row={row}
            creating={creatingSourceId === row.sourceId}
            analyzing={analyzingSourceId === row.sourceId}
            onCreateAgent={() => onCreateAgent(row.sourceId)}
            onAnalyze={() => onAnalyze(row.sourceId)}
          />
        ))}
      </div>
    </section>
  );
}

function CoverageRow({
  row,
  creating,
  analyzing,
  onCreateAgent,
  onAnalyze,
}: {
  row: KbSourceCoverageSummary;
  creating: boolean;
  analyzing: boolean;
  onCreateAgent: () => void;
  onAnalyze: () => void;
}) {
  const { t } = useT();
  const Icon =
    row.health === 'ready' ? CheckCircle2 : row.health === 'failed' ? AlertTriangle : Database;
  const canCreateAgent = row.assignment?.needsNewAgent && row.assignment.recommendedAgentRole;
  return (
    <div className="rounded-lg border border-hairline bg-surface-faint px-3.5 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-1 text-text-muted">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-text-primary">
              {row.sourceLabel}
            </span>
            <span className="rounded bg-surface-active px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-text-muted">
              {row.sourceRole ?? t('knowledge.coverage.unclassified')}
            </span>
            <span className="rounded bg-surface-active px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-text-muted">
              {t(`knowledge.coverage.health.${row.health}`)}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-text-faint">
            <span>{t('knowledge.coverage.pages', { count: row.pageCount })}</span>
            <span>{t('knowledge.coverage.autoPages', { count: row.autoPageCount })}</span>
            <span>{t('knowledge.coverage.files', { count: row.filesScanned })}</span>
            {row.latestEmbedding && (
              <span>
                {t('knowledge.coverage.embeddings', {
                  current: row.latestEmbedding.current,
                  total: row.latestEmbedding.total,
                })}
              </span>
            )}
          </div>
          {row.assignment?.needsNewAgent && (
            <div className="mt-2 flex items-start gap-1.5 rounded-md border border-accent-yellow/20 bg-accent-yellow/8 px-2.5 py-2 text-[11px] text-text-secondary">
              <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-yellow" />
              <span>{row.assignment.reason}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canCreateAgent && (
            <button
              type="button"
              onClick={onCreateAgent}
              disabled={creating}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-blue/20 bg-accent-blue/12 px-2.5 text-[11.5px] font-medium text-accent-blue transition-colors hover:bg-accent-blue/18 disabled:opacity-60"
            >
              {creating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserPlus className="h-3.5 w-3.5" />
              )}
              {t('knowledge.coverage.createAgent')}
            </button>
          )}
          <button
            type="button"
            onClick={onAnalyze}
            disabled={analyzing || row.health === 'indexing'}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-med bg-surface-subtle px-2.5 text-[11.5px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
          >
            {analyzing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {t('knowledge.coverage.analyze')}
          </button>
        </div>
      </div>
    </div>
  );
}

function pct(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function FineTuningReadinessPanel({
  report,
  loading,
  exporting,
  onExport,
  onOpenCuration,
}: {
  report: FineTuningReadiness | null;
  loading: boolean;
  exporting: boolean;
  onExport: () => void;
  onOpenCuration: () => void;
}) {
  const { t } = useT();
  if (loading) {
    return (
      <section className="mt-8 rounded-lg border border-hairline bg-surface-veil px-4 py-4 text-[12px] text-text-muted">
        <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />
        {t('knowledge.fineTuning.loading')}
      </section>
    );
  }
  if (!report) return null;
  const canExport =
    report.status === 'ready_to_export' ||
    report.status === 'ready_to_train' ||
    report.approvedExamples > 0 ||
    report.exportedExamples > 0;
  return (
    <section className="mt-8 rounded-lg border border-hairline bg-surface-faint px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-text-faint">
            <Brain className="h-3.5 w-3.5 text-accent-purple" />
            {t('knowledge.fineTuning.title')}
          </h2>
          <p className="mt-1 text-[11.5px] text-text-muted">{report.recommendation}</p>
        </div>
        <span className="shrink-0 rounded bg-surface-active px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          {t(`knowledge.fineTuning.status.${report.status}`)}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile
          label={t('knowledge.fineTuning.readiness')}
          value={pct(report.readinessScore)}
        />
        <MetricTile
          label={t('knowledge.fineTuning.usable')}
          value={String(report.usableExamples)}
        />
        <MetricTile
          label={t('knowledge.fineTuning.avgScore')}
          value={pct(report.avgLearningScore)}
        />
        <MetricTile
          label={t('knowledge.fineTuning.ignored')}
          value={String(report.ignoredExamples)}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-text-faint">
        <span>{t('knowledge.fineTuning.total', { count: report.totalExamples })}</span>
        <span>{t('knowledge.fineTuning.approved', { count: report.approvedExamples })}</span>
        <span>{t('knowledge.fineTuning.exported', { count: report.exportedExamples })}</span>
        <span>
          {t('knowledge.fineTuning.undoInvalidated', { count: report.invalidatedByUndo })}
        </span>
        <span>{t('knowledge.fineTuning.highQuality', { count: report.highQualityExamples })}</span>
        <span>{t(`knowledge.fineTuning.stage.${report.trainingStage}`)}</span>
        <span>
          {report.weightTrainingAvailable
            ? t('knowledge.fineTuning.weightTrainingAvailable')
            : t('knowledge.fineTuning.weightTrainingPending')}
        </span>
      </div>

      {report.sources.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {report.sources.slice(0, 4).map((source) => (
            <div
              key={source.sourceId ?? 'workspace'}
              className="flex items-center gap-2 rounded-md bg-surface-subtle px-2.5 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-secondary">
                {source.sourceLabel}
              </span>
              <span className="font-mono text-[10.5px] text-text-faint">
                {source.usable}/{source.total}
              </span>
              <span className="w-12 text-right font-mono text-[10.5px] text-text-faint">
                {pct(source.avgLearningScore)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onOpenCuration}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-med bg-surface-subtle px-2.5 text-[11.5px] font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
        >
          <Eye className="h-3.5 w-3.5" />
          {t('knowledge.fineTuning.curate')}
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={!canExport || exporting}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-purple/20 bg-accent-purple/12 px-2.5 text-[11.5px] font-medium text-accent-purple transition-colors hover:bg-accent-purple/18 disabled:opacity-50"
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {t('knowledge.fineTuning.export')}
        </button>
      </div>
    </section>
  );
}

type CurateInput = {
  id: string;
  status?: AiTrainingExample['status'];
  label?: AiTrainingExample['label'];
  expectedOutput?: string | null;
  actualOutput?: string | null;
  metadata?: Record<string, unknown> | null;
};

function TrainingCurationDialog({
  open,
  onOpenChange,
  examples,
  loading,
  mutatingId,
  autoApproval,
  autoApprovalMinScore,
  onAutoApprovalChange,
  onCurate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  examples: AiTrainingExample[];
  loading: boolean;
  mutatingId: string | null;
  autoApproval: boolean;
  autoApprovalMinScore: number;
  onAutoApprovalChange: (enabled: boolean) => void;
  onCurate: (input: CurateInput) => void;
}) {
  const { t } = useT();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expectedDraft, setExpectedDraft] = useState('');
  const ordered = [...examples].sort((a, b) => {
    const rank = { candidate: 0, approved: 1, exported: 2, ignored: 3 };
    return rank[a.status] - rank[b.status];
  });

  function startEdit(example: AiTrainingExample) {
    setEditingId(example.id);
    setExpectedDraft(example.expectedOutput ?? example.actualOutput ?? '');
  }

  function saveEdit(example: AiTrainingExample) {
    onCurate({
      id: example.id,
      status: 'approved',
      label: example.label === 'negative' ? 'correction' : example.label,
      expectedOutput: expectedDraft.trim() || null,
    });
    setEditingId(null);
  }

  function handleAutoApprovalChange(checked: boolean) {
    onAutoApprovalChange(checked);
    if (!checked) return;
    for (const example of examples) {
      if (example.status !== 'candidate') continue;
      if (
        (metadataNumber(parseTrainingMetadata(example.metadataJson), 'learningScore') ?? 0) <
        autoApprovalMinScore
      ) {
        continue;
      }
      onCurate({
        id: example.id,
        status: 'approved',
        label: example.label === 'negative' ? 'correction' : example.label,
        expectedOutput: example.expectedOutput ?? example.actualOutput ?? null,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <div className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <Brain className="h-4 w-4 text-accent-purple" />
            {t('knowledge.fineTuning.curationTitle')}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px]">
            {t('knowledge.fineTuning.curationDescription')}
          </DialogDescription>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <label className="flex min-w-0 items-center gap-2 text-[12px] text-text-secondary">
            <input
              type="checkbox"
              checked={autoApproval}
              onChange={(event) => handleAutoApprovalChange(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-border bg-surface-accent accent-accent-purple"
            />
            <span>{t('knowledge.fineTuning.autoApproval')}</span>
          </label>
          <span className="shrink-0 rounded bg-accent-yellow/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-accent-yellow">
            {autoApproval
              ? t('knowledge.fineTuning.autoApprovalArmed', { score: pct(autoApprovalMinScore) })
              : t('knowledge.fineTuning.manualApproval')}
          </span>
        </div>

        <div className="thin-scrollbar max-h-[64vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-[12px] text-text-muted">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              {t('knowledge.fineTuning.loadingExamples')}
            </div>
          ) : ordered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-hairline-strong px-6 py-10 text-center text-[12px] text-text-muted">
              {t('knowledge.fineTuning.emptyCuration')}
            </div>
          ) : (
            <div className="space-y-2">
              {ordered.map((example) => (
                <TrainingExampleRow
                  key={example.id}
                  example={example}
                  editing={editingId === example.id}
                  expectedDraft={expectedDraft}
                  busy={mutatingId === example.id}
                  onExpectedDraftChange={setExpectedDraft}
                  onEdit={() => startEdit(example)}
                  onCancelEdit={() => setEditingId(null)}
                  onSaveEdit={() => saveEdit(example)}
                  onApprove={() =>
                    onCurate({
                      id: example.id,
                      status: 'approved',
                      label: example.label === 'negative' ? 'correction' : example.label,
                      expectedOutput: example.expectedOutput ?? example.actualOutput ?? null,
                    })
                  }
                  onIgnore={() => onCurate({ id: example.id, status: 'ignored' })}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TrainingExampleRow({
  example,
  editing,
  expectedDraft,
  busy,
  onExpectedDraftChange,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onApprove,
  onIgnore,
}: {
  example: AiTrainingExample;
  editing: boolean;
  expectedDraft: string;
  busy: boolean;
  onExpectedDraftChange: (value: string) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onApprove: () => void;
  onIgnore: () => void;
}) {
  const { t } = useT();
  const metadata = parseTrainingMetadata(example.metadataJson);
  const score = metadataNumber(metadata, 'learningScore');
  const reasons = Array.isArray(metadata.learningScoreReasons)
    ? metadata.learningScoreReasons.filter((item): item is string => typeof item === 'string')
    : [];
  const sourceLabel =
    metadataString(metadata, 'sourceLabel') ?? t('knowledge.fineTuning.workspaceScope');
  const issueKey = metadataString(metadata, 'issueKey');
  const invalidatedBy = metadataString(metadata, 'invalidatedBy');
  const scoreText = score == null ? '--' : pct(score);

  return (
    <article className="rounded-lg border border-hairline bg-surface-faint px-3.5 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-1 text-text-muted">
          {example.status === 'ignored' ? (
            <XCircle className="h-4 w-4" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="rounded bg-surface-active px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-text-muted">
              {t(`knowledge.fineTuning.statusLabel.${example.status}`)}
            </span>
            <span className="rounded bg-surface-active px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-text-muted">
              {example.label}
            </span>
            <span className="rounded bg-accent-purple/10 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wide text-accent-purple">
              {scoreText}
            </span>
            {issueKey && (
              <span className="rounded bg-surface-active px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-text-muted">
                {issueKey}
              </span>
            )}
            {invalidatedBy && (
              <span className="rounded bg-accent-yellow/10 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-accent-yellow">
                {t('knowledge.fineTuning.invalidated')}
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-text-faint">
            {sourceLabel} · {example.sourceKind} · {example.taskType}
          </div>
          <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-text-secondary">
            {compactText(example.inputText)}
          </p>
          {editing ? (
            <div className="mt-3">
              <textarea
                value={expectedDraft}
                onChange={(event) => onExpectedDraftChange(event.target.value)}
                className="min-h-28 w-full resize-y rounded-md border border-hairline-strong bg-surface-subtle px-3 py-2 text-[12px] leading-5 text-text-primary outline-none focus:border-accent-purple/40"
                placeholder={t('knowledge.fineTuning.expectedOutput')}
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="inline-flex h-7 items-center rounded-md border border-hairline-med px-2.5 text-[11px] text-text-secondary hover:bg-surface-2"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={onSaveEdit}
                  disabled={busy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-accent-purple/20 bg-accent-purple/12 px-2.5 text-[11px] font-medium text-accent-purple hover:bg-accent-purple/18 disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t('common.save')}
                </button>
              </div>
            </div>
          ) : (
            <>
              {(example.expectedOutput || example.actualOutput) && (
                <p className="mt-2 line-clamp-2 rounded-md bg-surface-subtle px-2.5 py-2 text-[11px] leading-4 text-text-muted">
                  {compactText(example.expectedOutput ?? example.actualOutput ?? '')}
                </p>
              )}
              {reasons.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {reasons.slice(0, 4).map((reason) => (
                    <span
                      key={reason}
                      className="rounded bg-surface-1 px-1.5 py-0.5 font-mono text-[9.5px] text-text-faint"
                    >
                      {reason}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onEdit}
            disabled={busy || editing}
            className="inline-flex h-8 items-center rounded-md border border-hairline-med px-2.5 text-[11px] text-text-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            {t('knowledge.fineTuning.edit')}
          </button>
          <button
            type="button"
            onClick={onIgnore}
            disabled={busy || example.status === 'ignored'}
            className="inline-flex h-8 items-center rounded-md border border-hairline-med px-2.5 text-[11px] text-text-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            {t('knowledge.fineTuning.ignore')}
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={busy || example.status === 'approved' || example.status === 'exported'}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-purple/20 bg-accent-purple/12 px-2.5 text-[11px] font-medium text-accent-purple hover:bg-accent-purple/18 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('knowledge.fineTuning.approve')}
          </button>
        </div>
      </div>
    </article>
  );
}

function parseTrainingMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-hairline-faint bg-surface-subtle px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-text-faint">{label}</div>
      <div className="mt-1 font-mono text-[15px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function RagQualityPanel({
  evaluations,
  running,
  latestSummary,
  onRun,
}: {
  evaluations: RagEvaluationRun[];
  running: boolean;
  latestSummary: RagBenchmarkSummary | null;
  onRun: () => void;
}) {
  const { t } = useT();
  const latest = evaluations.slice(0, 20);
  const metrics = latest.map((run) => run.metricsJson);
  const avg = (key: 'precisionAtK' | 'recallAtK' | 'mrr') =>
    metrics.length === 0
      ? 0
      : metrics.reduce((sum, row) => sum + (typeof row[key] === 'number' ? row[key] : 0), 0) /
        metrics.length;
  const passed = latest.filter((run) => run.status === 'passed').length;
  const failed = latest.filter((run) => run.status === 'failed').length;
  const needsReview = latest.filter((run) => run.status === 'needs_review').length;

  return (
    <section className="mt-8 rounded-lg border border-hairline bg-surface-faint px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-text-faint">
            <Database className="h-3.5 w-3.5 text-accent-blue" />
            {t('knowledge.rag.title')}
          </h2>
          <p className="mt-1 text-[11.5px] text-text-muted">{t('knowledge.rag.description')}</p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-blue/20 bg-accent-blue/12 px-2.5 text-[11.5px] font-medium text-accent-blue transition-colors hover:bg-accent-blue/18 disabled:opacity-50"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {t('knowledge.rag.runBenchmark')}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile label={t('knowledge.rag.precision')} value={pct(avg('precisionAtK'))} />
        <MetricTile label={t('knowledge.rag.recall')} value={pct(avg('recallAtK'))} />
        <MetricTile label={t('knowledge.rag.mrr')} value={pct(avg('mrr'))} />
        <MetricTile label={t('knowledge.rag.evaluations')} value={String(evaluations.length)} />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-text-faint">
        <span>{t('knowledge.rag.passed', { count: passed })}</span>
        <span>{t('knowledge.rag.failed', { count: failed })}</span>
        <span>{t('knowledge.rag.needsReview', { count: needsReview })}</span>
        {latestSummary && <span>{t('knowledge.rag.lastRun', { total: latestSummary.total })}</span>}
      </div>
    </section>
  );
}

// ============================================================================
// Editor (full-width Notion-like)
// ============================================================================

function KbPageEditor({ page, backlinks }: { page: KbPage; backlinks: KbBacklink[] }) {
  const { t } = useT();
  const [title, setTitle] = useState(page.title);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const workspace = useWorkspaceStore((s) => s.active);

  // Reset state quando muda de página
  useEffect(() => {
    const frame = requestAnimationFrame(() => setTitle(page.title));
    return () => cancelAnimationFrame(frame);
  }, [page.id, page.title]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<{ title: string; content: string }>({
    title: page.title,
    content: page.contentJson ?? '',
  });

  function scheduleSave(content: string, currentTitle: string) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (lastSavedRef.current.content === content && lastSavedRef.current.title === currentTitle) {
        return;
      }
      lastSavedRef.current = { title: currentTitle, content };
      const wikilinks = extractWikilinks(content);
      void window.orkestral['kb:update-page']({
        pageId: page.id,
        patch: {
          title: currentTitle,
          contentJson: content,
          contentMd: jsonToPlainMarkdown(content),
        },
        links: wikilinks.map((label) => ({
          targetKind: 'page' as const,
          targetLabel: label,
        })),
      }).then(async () => {
        if (wikilinks.length > 0 && workspace) {
          const resolvedLinks = await Promise.all(
            wikilinks.map(async (label) => {
              const resolved = await window.orkestral['kb:resolve-wikilink']({
                workspaceId: workspace.id,
                label,
              });
              return {
                targetKind: 'page' as const,
                targetId: resolved?.id ?? null,
                targetLabel: label,
              };
            }),
          );
          await window.orkestral['kb:update-page']({
            pageId: page.id,
            patch: {},
            links: resolvedLinks,
          });
        }
        queryClient.invalidateQueries({ queryKey: ['kb-tree'] });
        queryClient.invalidateQueries({ queryKey: ['kb-page', page.id] });
      });
    }, 700);
  }

  function onTitleBlur() {
    if (title.trim() === '' || title === page.title) return;
    scheduleSave(lastSavedRef.current.content, title.trim());
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="thin-scrollbar flex-1 overflow-y-auto">
        {/* pl-20 reserva espaço pros botões side-menu (+ e ⋮⋮) do BlockNote.
            pt-14 dá respiro no topo. Título e blocos compartilham a mesma
            coluna X (CSS overrides zeram a margem interna dos blocos). */}
        <div className="pl-20 pr-20 pb-16 pt-14">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={onTitleBlur}
            className="mb-8 w-full bg-transparent text-[40px] font-bold leading-tight tracking-tight text-text-primary placeholder:text-text-faint focus:outline-none"
            placeholder={t('knowledge.untitled')}
          />

          <KbBlockEditor
            key={page.id}
            initialContentJson={page.contentJson}
            initialMarkdown={page.contentMd}
            onChange={(content) => scheduleSave(content, title)}
          />

          {backlinks.length > 0 && (
            <div className="mt-16 border-t border-hairline pt-6">
              <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-text-faint">
                {t('knowledge.editor.backlinksHeading', { count: backlinks.length })}
              </h3>
              <div className="flex flex-col gap-1.5">
                {backlinks.map((b, idx) => (
                  <button
                    key={`${b.sourcePageId}-${idx}`}
                    type="button"
                    onClick={() => navigate(`/knowledge/${b.sourcePageId}`)}
                    className="flex items-center gap-2 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2 text-left text-[12px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
                  >
                    <FileText className="h-3.5 w-3.5 opacity-70" />
                    <span className="flex-1 truncate">{b.sourcePageTitle}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

function extractWikilinks(content: string): string[] {
  const links = new Set<string>();
  let text = '';
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      const out: string[] = [];
      walkText(data, out);
      text = out.join('\n');
    }
  } catch {
    text = content;
  }
  let m;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const label = m[1].trim();
    if (label) links.add(label);
  }
  return [...links];
}

function walkText(blocks: unknown[], out: string[]): void {
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Record<string, unknown>;
    const content = block.content as unknown;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (typeof c === 'string') out.push(c);
        else if (c && typeof c === 'object' && 'text' in c) {
          out.push(String((c as { text: unknown }).text ?? ''));
        }
      }
    }
    const children = block.children as unknown;
    if (Array.isArray(children)) walkText(children, out);
  }
}

function jsonToPlainMarkdown(json: string): string {
  try {
    const data = JSON.parse(json);
    if (!Array.isArray(data)) return '';
    const lines: string[] = [];
    walkAsMarkdown(data, lines);
    return lines.join('\n');
  } catch {
    return '';
  }
}

function walkAsMarkdown(blocks: unknown[], out: string[]): void {
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Record<string, unknown>;
    const type = block.type as string | undefined;
    const content = block.content;
    const txt = blockTextOf(content);
    if (type === 'heading') {
      const lv = ((block.props as Record<string, unknown> | undefined)?.level as number) ?? 1;
      out.push(`${'#'.repeat(Math.min(6, Math.max(1, lv)))} ${txt}`);
    } else if (type === 'bulletListItem') {
      out.push(`- ${txt}`);
    } else if (type === 'numberedListItem') {
      out.push(`1. ${txt}`);
    } else if (type === 'codeBlock') {
      out.push(`\`\`\`\n${txt}\n\`\`\``);
    } else if (txt) {
      out.push(txt);
    }
    const children = block.children as unknown;
    if (Array.isArray(children)) walkAsMarkdown(children, out);
  }
}

function blockTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object' && 'text' in c) {
        return String((c as { text: unknown }).text ?? '');
      }
      return '';
    })
    .join('');
}
