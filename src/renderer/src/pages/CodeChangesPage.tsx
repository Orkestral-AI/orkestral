import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  GitBranch,
  GitCommit,
  GitPullRequest,
  Plus,
  Loader2,
  RefreshCw,
  Upload,
  Download,
  FileText,
  CheckCircle2,
  FilePlus2,
  FileMinus2,
  FileDiff,
  ArrowRightLeft,
  ChevronDown,
  Filter,
  Undo2,
  History,
  X,
  Lock,
  GitMerge,
  Copy,
  FolderOpen,
  ExternalLink,
  EyeOff,
  Search,
  Check,
  Sparkles,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT, type TFunction } from '@renderer/i18n';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import {
  useUIStore,
  FILELIST_MIN_WIDTH,
  FILELIST_MAX_WIDTH,
  FILELIST_DEFAULT_WIDTH,
} from '@renderer/stores/uiStore';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { ConflictModal } from '@renderer/components/code-changes/ConflictModal';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@renderer/components/ui/dialog';
import {
  ContextMenu,
  useContextMenu,
  type ContextMenuItem,
} from '@renderer/components/ui/context-menu';
import type { WorkspaceSource } from '@shared/types';
import { Highlight } from 'prism-react-renderer';
import { useCodeTheme } from '@renderer/hooks/useCodeTheme';
import { langFromPath } from '@renderer/lib/diffLang';

type StatusLite = { branch: string | null; ahead: number; behind: number; upstream: string | null };

/**
 * Code Changes — clone funcional do GitHub Desktop, conectado ao git CLI.
 *
 * Estrutura:
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  [Repositório] │ [Branch atual] │ [Origin (↑↓)]                │
 *   ├──────────────────┬─────────────────────────────────────────────┤
 *   │ Tabs Changes/Hist│  Diff viewer com line numbers              │
 *   │ Filtro arquivos  │                                             │
 *   │ Lista de files   │                                             │
 *   │ ─────────        │                                             │
 *   │ Summary input    │                                             │
 *   │ Description      │                                             │
 *   │ [Commit em X]    │                                             │
 *   └──────────────────┴─────────────────────────────────────────────┘
 */
export function CodeChangesPage() {
  const { t } = useT();
  const workspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();

  const sourcesQuery = useQuery({
    queryKey: ['source-list', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['source:list']({ workspaceId: workspace!.id }),
  });
  const sources = (sourcesQuery.data ?? []).filter((s) => !!s.path);
  const [sourceId, setSourceId] = useState<string | null>(null);

  useEffect(() => {
    if (!sourceId && sources.length > 0) {
      const nextSourceId = sources.find((s) => s.isPrimary)?.id ?? sources[0].id;
      const frame = requestAnimationFrame(() => setSourceId(nextSourceId));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [sources, sourceId]);

  if (!workspace) {
    return (
      <Shell>
        <EmptyState
          icon={<GitBranch className="h-7 w-7" />}
          title={t('issues.code.noActiveWorkspaceTitle')}
          description={t('issues.code.noActiveWorkspaceBody')}
        />
      </Shell>
    );
  }
  if (sources.length === 0) {
    return (
      <Shell>
        <EmptyState
          icon={<GitBranch className="h-7 w-7" />}
          title={t('issues.code.noSourcesTitle')}
          description={t('issues.code.noSourcesBody')}
        />
      </Shell>
    );
  }
  if (!sourceId) return null;
  const source = sources.find((s) => s.id === sourceId);
  if (!source) return null;

  return (
    <Shell>
      <CodeChangesInner
        source={source}
        allSources={sources}
        onSourceChange={setSourceId}
        queryClient={queryClient}
      />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {children}
      </div>
    </div>
  );
}

type Tab = 'changes' | 'history';

export function CodeChangesInner({
  source,
  allSources,
  onSourceChange,
  queryClient,
}: {
  source: WorkspaceSource;
  allSources: WorkspaceSource[];
  onSourceChange: (id: string) => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { t } = useT();
  const sourceId = source.id;
  const fileListWidth = useUIStore((s) => s.fileListWidth);
  const fileListResizing = useUIStore((s) => s.fileListResizing);
  const setFileListWidth = useUIStore((s) => s.setFileListWidth);
  const setFileListResizing = useUIStore((s) => s.setFileListResizing);
  const [tab, setTab] = useState<Tab>('changes');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [stagedSelection, setStagedSelection] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [filter, setFilter] = useState('');
  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const [showPrDialog, setShowPrDialog] = useState(false);
  const fileCtx = useContextMenu();
  const headerCtx = useContextMenu();
  const [ctxPath, setCtxPath] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string[] | null>(null);
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);

  const statusQuery = useQuery({
    queryKey: ['git-status', sourceId],
    queryFn: () => window.orkestral['git:status']({ sourceId }),
    refetchInterval: 10_000,
  });
  const status = statusQuery.data;

  const branchesQuery = useQuery({
    queryKey: ['git-branches', sourceId],
    queryFn: () => window.orkestral['git:branches']({ sourceId }),
  });
  const branches = branchesQuery.data ?? [];

  const logQuery = useQuery({
    queryKey: ['git-log', sourceId, tab],
    enabled: tab === 'history',
    queryFn: () => window.orkestral['git:log']({ sourceId, limit: 80 }),
  });

  const selectedFileEntry = status?.files.find((f) => f.path === selectedFile);
  const diffQuery = useQuery({
    queryKey: [
      'git-diff',
      sourceId,
      selectedFile,
      !!selectedFileEntry?.staged && !selectedFileEntry?.unstaged,
    ],
    enabled: !!selectedFile && tab === 'changes',
    queryFn: () => {
      const file = status?.files.find((f) => f.path === selectedFile);
      const staged = !!file?.staged && !file?.unstaged;
      return window.orkestral['git:diff']({ sourceId, filePath: selectedFile!, staged });
    },
  });

  useEffect(() => {
    if (!status) return;
    const frame = requestAnimationFrame(() => {
      setStagedSelection((prev) => {
        const next = new Set(prev);
        for (const f of status.files) if (!next.has(f.path)) next.add(f.path);
        for (const path of Array.from(next)) {
          if (!status.files.some((f) => f.path === path)) next.delete(path);
        }
        return next;
      });
      if (!selectedFile && status.files.length > 0) setSelectedFile(status.files[0].path);
      if (selectedFile && !status.files.some((f) => f.path === selectedFile)) {
        setSelectedFile(status.files[0]?.path ?? null);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [status, selectedFile]);

  // Detecta conflitos de merge logo após um pull, lendo o status já revalidado.
  useEffect(() => {
    if (!pendingConflictCheck.current) return;
    pendingConflictCheck.current = false;
    const conflicted = (status?.files ?? [])
      .filter((f) => f.indexStatus === 'U' || f.workingStatus === 'U')
      .map((f) => f.path);
    if (conflicted.length > 0) setConflictFiles(conflicted);
  }, [status]);

  // Sem canal IPC de abort no backend (git:merge-abort não existe), o "Abortar
  // merge" só fecha a modal. Resolver os conflitos manualmente segue sendo o
  // caminho — adicionar um handler de abort de merge está fora de escopo.
  const handleAbortMerge = () => setConflictFiles([]);

  const checkoutMutation = useMutation({
    mutationFn: (branch: string) => window.orkestral['git:checkout']({ sourceId, branch }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['git-status', sourceId] });
      queryClient.invalidateQueries({ queryKey: ['git-branches', sourceId] });
    },
  });
  const createBranchMutation = useMutation({
    mutationFn: (name: string) => window.orkestral['git:create-branch']({ sourceId, name }),
    onSuccess: () => {
      setShowCreateBranch(false);
      queryClient.invalidateQueries({ queryKey: ['git-status', sourceId] });
      queryClient.invalidateQueries({ queryKey: ['git-branches', sourceId] });
    },
  });
  const fetchMutation = useMutation({
    mutationFn: () => window.orkestral['git:fetch']({ sourceId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['git-status', sourceId] });
      queryClient.invalidateQueries({ queryKey: ['git-branches', sourceId] });
    },
  });
  const commitMutation = useMutation({
    mutationFn: () => {
      const msg = [summary.trim(), description.trim()].filter(Boolean).join('\n\n');
      return window.orkestral['git:commit']({
        sourceId,
        message: msg,
        files: Array.from(stagedSelection),
      });
    },
    onSuccess: () => {
      setSummary('');
      setDescription('');
      queryClient.invalidateQueries({ queryKey: ['git-status', sourceId] });
      queryClient.invalidateQueries({ queryKey: ['git-branches', sourceId] });
      queryClient.invalidateQueries({ queryKey: ['git-log', sourceId] });
    },
  });
  const pushMutation = useMutation({
    mutationFn: () => window.orkestral['git:push']({ sourceId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['git-status', sourceId] });
    },
  });
  // Após um pull, marcamos esta flag pra que o efeito abaixo reavalie o status
  // recém-revalidado e detecte arquivos em conflito (status 'U' no índice ou na
  // árvore de trabalho). A detecção fica no efeito porque o status novo só chega
  // num re-render posterior à invalidação da query.
  const pendingConflictCheck = useRef(false);
  const pullMutation = useMutation({
    mutationFn: () => window.orkestral['git:pull']({ sourceId, rebase: false }),
    onSuccess: () => {
      pendingConflictCheck.current = true;
      queryClient.invalidateQueries({ queryKey: ['git-status', sourceId] });
      queryClient.invalidateQueries({ queryKey: ['git-log', sourceId] });
    },
  });
  const discardMutation = useMutation({
    mutationFn: (files: string[]) => window.orkestral['git:discard']({ sourceId, files }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['git-status', sourceId] });
    },
  });
  const suggestCommitMutation = useMutation({
    mutationFn: () =>
      window.orkestral['git:suggest-commit']({
        sourceId,
        files: Array.from(stagedSelection),
      }),
    onSuccess: ({ summary: s, description: d }) => {
      setSummary(s);
      setDescription(d);
    },
  });

  const toggleFile = (path: string) =>
    setStagedSelection((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const totalCount = status?.files.length ?? 0;
  const filteredFiles = useMemo(() => {
    const list = status?.files ?? [];
    if (!filter.trim()) return list;
    const q = filter.toLowerCase();
    return list.filter((f) => f.path.toLowerCase().includes(q));
  }, [status?.files, filter]);
  const checkedCount = stagedSelection.size;
  const allChecked = totalCount > 0 && checkedCount === totalCount;
  const isProtectedBranch = status?.branch === 'main' || status?.branch === 'master';

  return (
    <>
      {/* ─── Top segmented bar (Repo │ Branch │ Origin) ─── */}
      <header className="flex h-14 shrink-0 items-stretch overflow-hidden border-b border-border">
        {/* Repo picker é redundante dentro de um único source — escondê-lo libera
            bastante largura pra o botão "Abrir PR" nunca ser cortado. */}
        {allSources.length > 1 && (
          <SegmentedPicker
            label={t('issues.code.currentRepo')}
            icon={<GitBranch className="h-3.5 w-3.5" />}
            value={source.label}
            items={allSources.map((s) => ({
              value: s.id,
              label: s.label,
              sub: s.repoFullName ?? s.path ?? '',
            }))}
            onSelect={(v) => onSourceChange(v)}
          />
        )}
        <BranchPicker
          currentBranch={status?.branch ?? null}
          loading={statusQuery.isLoading}
          branches={branches}
          isProtected={isProtectedBranch}
          onSelect={(v) => checkoutMutation.mutate(v)}
          onNewBranch={() => setShowCreateBranch(true)}
          t={t}
        />
        <OriginButton
          status={status}
          loading={fetchMutation.isPending || pushMutation.isPending || pullMutation.isPending}
          fetching={fetchMutation.isPending}
          pulling={pullMutation.isPending}
          pushing={pushMutation.isPending}
          onFetch={() => fetchMutation.mutate()}
          onPush={() => pushMutation.mutate()}
          onPull={() => pullMutation.mutate()}
          t={t}
        />
        <div className="flex-1" />
        {/* Aparece quando há algo pra PR: commits à frente OU branch ainda sem
            remoto (nunca publicada) — nesse caso o fluxo publica antes de abrir. */}
        {source.repoFullName &&
          status?.branch &&
          ((status?.ahead ?? 0) > 0 || !status?.upstream) && (
            <button
              type="button"
              onClick={() => setShowPrDialog(true)}
              disabled={!status?.branch || isProtectedBranch}
              className="my-2 mr-3 inline-flex h-8 shrink-0 items-center gap-1.5 self-center rounded-md border border-hairline-strong bg-surface-faint px-3 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              title={
                isProtectedBranch
                  ? t('issues.code.openPrProtectedTooltip')
                  : t('issues.code.openPrTooltip')
              }
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              {t('issues.code.openPr')}
            </button>
          )}
      </header>

      {/* ─── Body: aside (left) + diff (right) ─── */}
      <div className="flex min-h-0 flex-1">
        {/* Aside */}
        <aside
          style={{ width: fileListWidth }}
          className="flex shrink-0 flex-col border-r border-border bg-background-card/30"
        >
          {/* Tabs */}
          <div className="flex h-10 shrink-0 items-stretch border-b border-border">
            <TabButton active={tab === 'changes'} onClick={() => setTab('changes')}>
              {t('issues.code.tabChanges')}
              {totalCount > 0 && (
                <span className="ml-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-surface-strong px-1 text-[10px] tabular-nums text-text-secondary">
                  {totalCount}
                </span>
              )}
            </TabButton>
            <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
              {t('issues.code.tabHistory')}
            </TabButton>
          </div>

          {tab === 'changes' ? (
            <>
              {/* Filter */}
              <div className="flex shrink-0 items-center gap-2 border-b border-l-2 border-transparent border-b-border px-3 py-2">
                <Filter className="h-3 w-3 shrink-0 text-text-faint" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t('issues.code.filterFiles')}
                  className="h-6 w-full bg-transparent text-[12px] text-text-primary placeholder:text-text-faint focus:outline-none"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => setFilter('')}
                    className="text-text-faint hover:text-text-primary"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>

              {/* All checkbox — botão direito abre "Descartar tudo" */}
              <div
                className="flex shrink-0 items-center gap-2 border-b border-l-2 border-transparent border-b-border px-3 py-1.5"
                onContextMenu={(e) => {
                  if (totalCount > 0) {
                    e.preventDefault();
                    headerCtx.open(e);
                  }
                }}
              >
                <Checkbox
                  checked={allChecked}
                  indeterminate={checkedCount > 0 && !allChecked}
                  onChange={() => {
                    if (allChecked) setStagedSelection(new Set());
                    else setStagedSelection(new Set((status?.files ?? []).map((f) => f.path)));
                  }}
                />
                <span className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
                  {totalCount === 0
                    ? t('issues.code.workingTreeClean')
                    : t('issues.code.filesSelected', {
                        checked: checkedCount,
                        total: totalCount,
                        label:
                          totalCount === 1
                            ? t('issues.code.fileSingular')
                            : t('issues.code.filePlural'),
                      })}
                </span>
              </div>

              {/* File list */}
              <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto pb-2">
                {statusQuery.isLoading && totalCount === 0 && (
                  <div className="flex h-full items-center justify-center gap-2 px-3 text-[12px] text-text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('issues.code.loadingStatus')}
                  </div>
                )}
                {statusQuery.isError && (
                  <div className="m-3 rounded-md border border-accent-red/30 bg-accent-red/10 p-3 text-[11.5px] text-accent-red">
                    {statusQuery.error instanceof Error
                      ? statusQuery.error.message
                      : t('issues.code.statusReadFailed')}
                  </div>
                )}
                {!statusQuery.isLoading && totalCount === 0 && (
                  <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                    <CheckCircle2 className="h-6 w-6 text-text-faint" />
                    <div className="mt-2 text-[12.5px] text-text-secondary">
                      {t('issues.code.noChangesTitle')}
                    </div>
                    <div className="mt-1 text-[11.5px] text-text-muted">
                      {t('issues.code.noChangesJumpPre')}{' '}
                      <button
                        type="button"
                        onClick={() => setTab('history')}
                        className="underline underline-offset-2 hover:text-text-primary"
                      >
                        {t('issues.code.tabHistory')}
                      </button>{' '}
                      {t('issues.code.noChangesJumpPost')}
                    </div>
                  </div>
                )}
                {filteredFiles.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    checked={stagedSelection.has(file.path)}
                    selected={selectedFile === file.path}
                    onToggle={() => toggleFile(file.path)}
                    onSelect={() => setSelectedFile(file.path)}
                    onDiscard={() => setConfirmDiscard([file.path])}
                    onContextMenu={(e) => {
                      setCtxPath(file.path);
                      fileCtx.open(e);
                    }}
                    t={t}
                  />
                ))}
                {filter && filteredFiles.length === 0 && totalCount > 0 && (
                  <div className="px-3 py-6 text-center text-[11.5px] text-text-muted">
                    {t('issues.code.noFilesMatch', { filter })}
                  </div>
                )}
              </div>

              {/* Commit footer — Summary + Description (GH Desktop style) */}
              <div className="shrink-0 border-t border-border bg-background-card/60 p-3">
                <input
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder={
                    checkedCount === 1
                      ? t('issues.code.commitSummaryOnePlaceholder', {
                          file: Array.from(stagedSelection)[0]?.split('/').pop() ?? '',
                        })
                      : t('issues.code.commitSummaryPlaceholder')
                  }
                  className="mb-2 h-8 w-full rounded-md border border-border bg-surface-subtle px-3 text-[12px] text-text-primary placeholder:text-text-faint focus:border-white/30 focus:outline-none"
                />
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('issues.code.commitDescriptionPlaceholder')}
                  rows={3}
                  className="thin-scrollbar mb-2 w-full resize-none rounded-md border border-border bg-surface-subtle px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-faint focus:border-white/30 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => suggestCommitMutation.mutate()}
                  disabled={suggestCommitMutation.isPending || totalCount === 0}
                  className="mb-2 inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-hairline-strong bg-surface-faint px-2.5 text-[11.5px] font-medium text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    totalCount === 0
                      ? t('issues.code.noChangesToSummarize')
                      : t('issues.code.generateTooltip')
                  }
                >
                  {suggestCommitMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 shrink-0" />
                  )}
                  {suggestCommitMutation.isPending
                    ? t('issues.code.generating')
                    : t('issues.code.generateWithAi')}
                </button>
                <button
                  type="button"
                  onClick={() => commitMutation.mutate()}
                  disabled={
                    commitMutation.isPending ||
                    !summary.trim() ||
                    checkedCount === 0 ||
                    !status?.branch
                  }
                  className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-accent-purple px-3 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-accent-purple/90 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted disabled:shadow-none"
                >
                  {commitMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <GitCommit className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="truncate">
                    Commit{checkedCount > 0 ? ` (${checkedCount})` : ''} {t('issues.code.commitOn')}{' '}
                    <span className="font-mono text-white/85">{status?.branch ?? '—'}</span>
                  </span>
                </button>
                {commitMutation.isError && (
                  <div className="mt-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-2 py-1 text-[11px] text-accent-red">
                    {commitMutation.error instanceof Error
                      ? commitMutation.error.message
                      : t('issues.code.commitFailed')}
                  </div>
                )}
                {pushMutation.isError && (
                  <div className="mt-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-2 py-1 text-[11px] text-accent-red">
                    {pushMutation.error instanceof Error
                      ? pushMutation.error.message
                      : t('issues.code.pushFailed')}
                  </div>
                )}
              </div>
            </>
          ) : (
            <HistoryList
              loading={logQuery.isLoading}
              error={logQuery.error instanceof Error ? logQuery.error.message : null}
              commits={logQuery.data ?? []}
              selected={selectedCommit}
              onSelect={setSelectedCommit}
              t={t}
            />
          )}
        </aside>

        {/* Borda arrastável no seam aside↔diff — espelha o SidebarResizer.
            O border-r do aside já é o divisor em repouso; o handle acende no
            hover/drag. Duplo clique reseta pra largura padrão. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={FILELIST_MIN_WIDTH}
          aria-valuemax={FILELIST_MAX_WIDTH}
          aria-valuenow={fileListWidth}
          title={t('layout.sidebar.resizeHint')}
          onMouseDown={(e) => {
            e.preventDefault();
            setFileListResizing(true);
            const startX = e.clientX;
            const startW = fileListWidth;
            const onMove = (ev: MouseEvent) => setFileListWidth(startW + (ev.clientX - startX));
            const onUp = () => {
              setFileListResizing(false);
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
          onDoubleClick={() => setFileListWidth(FILELIST_DEFAULT_WIDTH)}
          className="group relative z-10 -mx-px w-1 shrink-0 cursor-col-resize"
        >
          <span
            className={cn(
              'absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 transition-colors',
              fileListResizing ? 'bg-accent' : 'bg-transparent group-hover:bg-accent/70',
            )}
          />
        </div>

        {/* Right: diff viewer */}
        <main className="flex min-w-0 flex-1 flex-col">
          {tab === 'changes' ? (
            <ChangesRightPane
              filePath={selectedFile}
              fileEntry={selectedFileEntry}
              diff={diffQuery.data?.diff ?? ''}
              loading={diffQuery.isPending && !!selectedFile}
              empty={totalCount === 0}
              t={t}
            />
          ) : (
            <HistoryRightPane
              sourceId={sourceId}
              commit={(logQuery.data ?? []).find((c) => c.sha === selectedCommit) ?? null}
              t={t}
            />
          )}
        </main>
      </div>

      {fileCtx.state &&
        ctxPath &&
        (() => {
          const relPath = ctxPath;
          const ext = relPath.includes('.') ? relPath.split('.').pop() : null;
          const items: ContextMenuItem[] = [
            {
              label: t('issues.code.discardChangesMenu'),
              icon: <Undo2 className="h-3.5 w-3.5" />,
              danger: true,
              onSelect: () => setConfirmDiscard([relPath]),
            },
            { type: 'separator' },
            {
              label: t('issues.code.copyPath'),
              icon: <Copy className="h-3.5 w-3.5" />,
              onSelect: () =>
                navigator.clipboard.writeText(source.path ? `${source.path}/${relPath}` : relPath),
            },
            {
              label: t('issues.code.copyRelativePath'),
              icon: <Copy className="h-3.5 w-3.5" />,
              onSelect: () => navigator.clipboard.writeText(relPath),
            },
            { type: 'separator' },
            {
              label: t('issues.code.revealInFinder'),
              icon: <FolderOpen className="h-3.5 w-3.5" />,
              onSelect: () => window.orkestral['shell:reveal']({ sourceId, relPath }),
            },
            {
              label: t('issues.code.openInEditor'),
              icon: <ExternalLink className="h-3.5 w-3.5" />,
              onSelect: () => window.orkestral['shell:open-path']({ sourceId, relPath }),
            },
            { type: 'separator' },
            {
              label: t('issues.code.ignoreFile'),
              icon: <EyeOff className="h-3.5 w-3.5" />,
              onSelect: () =>
                window.orkestral['git:ignore']({ sourceId, patterns: [relPath] }).then(() =>
                  queryClient.invalidateQueries({ queryKey: ['git-status', sourceId] }),
                ),
            },
          ];
          if (ext) {
            items.push({
              label: t('issues.code.ignoreAll', { ext }),
              icon: <EyeOff className="h-3.5 w-3.5" />,
              onSelect: () =>
                window.orkestral['git:ignore']({ sourceId, patterns: [`*.${ext}`] }).then(() =>
                  queryClient.invalidateQueries({ queryKey: ['git-status', sourceId] }),
                ),
            });
          }
          return (
            <ContextMenu
              x={fileCtx.state.x}
              y={fileCtx.state.y}
              onClose={fileCtx.close}
              items={items}
            />
          );
        })()}

      {headerCtx.state && (
        <ContextMenu
          x={headerCtx.state.x}
          y={headerCtx.state.y}
          onClose={headerCtx.close}
          items={[
            {
              label: t('issues.code.discardAllMenu'),
              icon: <Undo2 className="h-3.5 w-3.5" />,
              danger: true,
              onSelect: () => setConfirmDiscard((status?.files ?? []).map((f) => f.path)),
            },
          ]}
        />
      )}

      {confirmDiscard && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDiscard(null)}>
          <DialogContent className="max-w-[440px]" hideClose>
            <div className="border-b border-hairline px-5 py-3.5">
              <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
                <Undo2 className="h-4 w-4 text-accent-red" />
                {t('issues.code.discardTitle')}
              </DialogTitle>
              <DialogDescription className="mt-1 text-[12px] text-text-muted">
                {confirmDiscard.length === 1 ? (
                  <>
                    {t('issues.code.discardBodyOnePre')}{' '}
                    <code className="rounded bg-surface-2 px-1 text-text-secondary">
                      {confirmDiscard[0]}
                    </code>{' '}
                    {t('issues.code.discardBodyOnePost')}
                  </>
                ) : (
                  t('issues.code.discardBodyMany', { n: confirmDiscard.length })
                )}
              </DialogDescription>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-hairline bg-black/20 px-5 py-3">
              <button
                type="button"
                onClick={() => setConfirmDiscard(null)}
                className="inline-flex h-8 items-center rounded-md border border-hairline-strong bg-surface-faint px-3 text-[12px] text-text-secondary hover:bg-surface-active"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  discardMutation.mutate(confirmDiscard);
                  setConfirmDiscard(null);
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-red px-3 text-[12px] font-medium text-white hover:bg-accent-red/90"
              >
                <Undo2 className="h-3.5 w-3.5" />
                {t('issues.code.discard')}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {showCreateBranch && (
        <CreateBranchModal
          currentBranch={status?.branch ?? null}
          onClose={() => setShowCreateBranch(false)}
          onCreate={(name) => createBranchMutation.mutate(name)}
          busy={createBranchMutation.isPending}
          error={
            createBranchMutation.error instanceof Error ? createBranchMutation.error.message : null
          }
        />
      )}

      {showPrDialog && status?.branch && source.repoFullName && (
        <OpenPrModal
          sourceId={sourceId}
          repoFullName={source.repoFullName}
          headBranch={status.branch}
          defaultTitle={summary || ''}
          defaultBody={description || ''}
          onClose={() => setShowPrDialog(false)}
        />
      )}

      <ConflictModal
        open={conflictFiles.length > 0}
        onOpenChange={(v) => {
          if (!v) setConflictFiles([]);
        }}
        files={conflictFiles}
        onAbort={handleAbortMerge}
        onOpenFile={(p) => setSelectedFile(p)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Segmented top picker (Repositório / Branch)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Branch picker — estilo GitHub Desktop (busca + seções + Nova branch)
// ---------------------------------------------------------------------------

type BranchItem = {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  lastCommit?: { sha: string; subject: string; relativeDate: string };
};

function BranchPicker({
  currentBranch,
  loading,
  branches,
  onSelect,
  onNewBranch,
  isProtected,
  t,
}: {
  currentBranch: string | null;
  loading: boolean;
  branches: BranchItem[];
  onSelect: (name: string) => void;
  onNewBranch: () => void;
  isProtected: boolean;
  t: TFunction;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => {
        setQuery('');
        setTimeout(() => inputRef.current?.focus(), 0);
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [open]);

  const { defaultBranch, otherLocal, remotes } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (b: BranchItem) => !q || b.name.toLowerCase().includes(q);
    const locals = branches.filter((b) => !b.remote && match(b));
    const remoteList = branches.filter((b) => b.remote && match(b));
    const def = locals.find((b) => b.name === 'main' || b.name === 'master') ?? null;
    return {
      defaultBranch: def,
      otherLocal: locals.filter((b) => b !== def),
      remotes: remoteList,
    };
  }, [branches, query]);

  const renderItem = (b: BranchItem) => {
    const isCurrent = b.name === currentBranch;
    return (
      <button
        key={b.name}
        type="button"
        onClick={() => {
          if (!isCurrent) onSelect(b.name);
          setOpen(false);
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] outline-none transition-colors hover:bg-surface-2',
          isCurrent ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
        )}
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-faint" />
        <span className="min-w-0 flex-1 truncate font-medium">{b.name}</span>
        {b.lastCommit?.relativeDate && (
          <span className="shrink-0 text-[10.5px] text-text-faint">
            {b.lastCommit.relativeDate}
          </span>
        )}
        {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-accent-purple" />}
      </button>
    );
  };

  const empty = !defaultBranch && otherLocal.length === 0 && remotes.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 shrink items-stretch border-r border-border">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-[240px] min-w-0 max-w-[240px] shrink items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface-1 text-text-secondary">
              {isProtected ? (
                <Lock className="h-3.5 w-3.5 text-accent-yellow" />
              ) : (
                <GitBranch className="h-3.5 w-3.5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wider text-text-faint">
                {t('issues.code.currentBranch')}
              </div>
              <div className="truncate text-[12.5px] font-medium text-text-primary">
                {currentBranch ?? (loading ? t('issues.code.branchLoading') : '—')}
              </div>
            </div>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-faint" />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent
        align="start"
        className="w-[300px] p-0"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        {/* Search + Nova branch */}
        <div className="flex items-center gap-2 border-b border-hairline p-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-hairline-strong bg-surface-hover px-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-faint" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('issues.code.filterBranches')}
              className="h-7 w-full min-w-0 bg-transparent text-[12px] text-text-primary placeholder:text-text-faint focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNewBranch();
            }}
            className="flex shrink-0 items-center gap-1 rounded-md border border-hairline-strong bg-surface-hover px-2 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('issues.code.newBranch')}
          </button>
        </div>
        {/* Lista agrupada */}
        <div className="thin-scrollbar max-h-[320px] overflow-y-auto p-1">
          {defaultBranch && (
            <>
              <div className="px-2.5 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-text-faint">
                {t('issues.code.defaultBranch')}
              </div>
              {renderItem(defaultBranch)}
            </>
          )}
          {otherLocal.length > 0 && (
            <>
              <div className="px-2.5 pb-1 pt-2 text-[10px] uppercase tracking-wider text-text-faint">
                {t('issues.code.otherBranches')}
              </div>
              {otherLocal.map(renderItem)}
            </>
          )}
          {remotes.length > 0 && (
            <>
              <div className="px-2.5 pb-1 pt-2 text-[10px] uppercase tracking-wider text-text-faint">
                {t('issues.code.remoteBranches')}
              </div>
              {remotes.map(renderItem)}
            </>
          )}
          {empty && (
            <div className="px-2.5 py-4 text-center text-[12px] text-text-muted">
              {branches.length === 0 ? t('issues.code.noBranches') : t('issues.code.noBranchMatch')}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SegmentedPicker({
  label,
  icon,
  value,
  items,
  onSelect,
  right,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  items: Array<{ value: string; label: string; sub?: string; meta?: string }>;
  onSelect: (v: string) => void;
  right?: ReactNode;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 shrink items-stretch border-r border-border">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-[240px] min-w-0 max-w-[240px] shrink items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface-1 text-text-secondary">
              {icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wider text-text-faint">{label}</div>
              <div className="truncate text-[12.5px] font-medium text-text-primary">{value}</div>
            </div>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-faint" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="thin-scrollbar max-h-[420px] w-[320px] overflow-y-auto p-1"
        >
          {items.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-text-muted">
              {t('issues.code.nothingAvailable')}
            </div>
          )}
          {items.map((it) => (
            <button
              key={it.value}
              type="button"
              onClick={() => {
                onSelect(it.value);
                setOpen(false);
              }}
              className="block w-full cursor-pointer rounded-md px-2.5 py-2 text-left text-[12.5px] text-text-secondary outline-none transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-text-primary">{it.label}</span>
                {it.meta && (
                  <span className="shrink-0 text-[10.5px] text-text-faint">{it.meta}</span>
                )}
              </div>
              {it.sub && (
                <div className="mt-0.5 truncate text-[11px] text-text-muted">{it.sub}</div>
              )}
            </button>
          ))}
        </PopoverContent>
      </Popover>
      {right}
    </div>
  );
}

function OriginButton({
  status,
  loading,
  fetching,
  pulling,
  pushing,
  onFetch,
  onPush,
  onPull,
  t,
}: {
  status?: StatusLite;
  loading: boolean;
  fetching: boolean;
  pulling: boolean;
  pushing: boolean;
  onFetch: () => void;
  onPush: () => void;
  onPull: () => void;
  t: TFunction;
}) {
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const hasOrigin = !!status?.upstream;
  const [open, setOpen] = useState(false);
  const primaryAction: 'pull' | 'push' | 'fetch' | 'publish' = !hasOrigin
    ? 'publish'
    : behind > 0
      ? 'pull'
      : ahead > 0
        ? 'push'
        : 'fetch';
  const primaryLabel =
    primaryAction === 'pull'
      ? t('issues.code.pullLabel', { n: behind })
      : primaryAction === 'push'
        ? t('issues.code.pushLabel', { n: ahead })
        : primaryAction === 'publish'
          ? t('issues.code.publishBranch')
          : t('issues.code.synced');
  const PrimaryIcon =
    primaryAction === 'pull'
      ? Download
      : primaryAction === 'push'
        ? Upload
        : primaryAction === 'publish'
          ? Upload
          : RefreshCw;
  const runPrimary = () => {
    if (primaryAction === 'pull') onPull();
    else if (primaryAction === 'push') onPush();
    else if (primaryAction === 'publish') onPush();
    else onFetch(); // sincronizado → fetch só pra verificar remoto
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex w-[220px] min-w-0 max-w-[220px] shrink items-stretch border-r border-border">
        {/* Botão primário — executa SOMENTE a ação primária (nunca abre menu). */}
        <button
          type="button"
          onClick={runPrimary}
          disabled={loading}
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span
            className={cn(
              'grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors',
              primaryAction === 'pull'
                ? 'bg-accent-purple/15 text-accent-purple'
                : primaryAction === 'push' || primaryAction === 'publish'
                  ? 'bg-accent-purple/15 text-accent-purple'
                  : 'bg-surface-1 text-text-secondary',
            )}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <PrimaryIcon className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wider text-text-faint">
              {hasOrigin ? t('issues.code.origin') : t('issues.code.noRemote')}
            </div>
            <div className="truncate text-[12.5px] font-medium text-text-primary">
              {pulling
                ? t('issues.code.pulling')
                : pushing
                  ? t('issues.code.pushing')
                  : fetching
                    ? t('issues.code.fetching')
                    : primaryLabel}
            </div>
          </div>
        </button>
        {/* Caret separado — APENAS abre o menu, nunca dispara ação. */}
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('issues.code.moreSyncActions')}
            className="grid w-7 shrink-0 place-items-center border-l border-border text-text-faint transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent align="start" className="w-[240px] p-1">
        <button
          type="button"
          onClick={() => {
            onFetch();
            setOpen(false);
          }}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] text-text-primary outline-none hover:bg-surface-2"
        >
          <RefreshCw className="h-3.5 w-3.5 text-text-secondary" />
          <span className="flex-1 text-left">{t('issues.code.fetchOrigin')}</span>
          <kbd className="text-[10px] text-text-faint">{t('issues.code.fetchHint')}</kbd>
        </button>
        <button
          type="button"
          onClick={() => {
            onPull();
            setOpen(false);
          }}
          disabled={!hasOrigin || !status?.branch}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] text-text-primary outline-none hover:bg-surface-2 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5 text-text-secondary" />
          <span className="flex-1 text-left">
            {t('issues.code.pullOrigin')} {behind > 0 ? `(↓ ${behind})` : ''}
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            onPush();
            setOpen(false);
          }}
          disabled={!status?.branch || (hasOrigin && ahead === 0)}
          title={hasOrigin && ahead === 0 ? t('issues.code.pushNothingTooltip') : undefined}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] text-text-primary outline-none hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Upload className="h-3.5 w-3.5 text-text-secondary" />
          <span className="flex-1 text-left">
            {hasOrigin ? `Push ${ahead > 0 ? `(↑ ${ahead})` : ''}` : t('issues.code.publishBranch')}
          </span>
          {hasOrigin && ahead === 0 && (
            <span className="text-[10px] text-text-faint">{t('issues.code.pushNothingNew')}</span>
          )}
        </button>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// File row (left list)
// ---------------------------------------------------------------------------

function FileRow({
  file,
  checked,
  selected,
  onToggle,
  onSelect,
  onDiscard,
  onContextMenu,
  t,
}: {
  file: {
    path: string;
    indexStatus: string;
    workingStatus: string;
    staged: boolean;
    unstaged: boolean;
  };
  checked: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onDiscard: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  t: TFunction;
}) {
  const code = file.workingStatus !== ' ' ? file.workingStatus : file.indexStatus;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
      }}
      className={cn(
        'group flex h-8 items-center gap-2 border-l-2 border-transparent px-3 transition-colors',
        selected ? 'border-l-accent-purple bg-accent-purple/[0.08]' : 'hover:bg-surface-1',
      )}
    >
      <Checkbox checked={checked} onChange={onToggle} onClick={(e) => e.stopPropagation()} />
      <FileStatusIcon code={code} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-primary">
        <PathDisplay path={file.path} />
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDiscard();
        }}
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-faint opacity-0 transition-opacity hover:bg-surface-2 hover:text-accent-red group-hover:opacity-100"
        title={t('issues.code.discardFileTooltip')}
      >
        <Undo2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function PathDisplay({ path }: { path: string }) {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return <span className="text-text-primary">{path}</span>;
  return (
    <>
      <span className="text-text-faint">{path.slice(0, idx + 1)}</span>
      <span className="text-text-primary">{path.slice(idx + 1)}</span>
    </>
  );
}

function FileStatusIcon({ code }: { code: string }) {
  if (code === 'A' || code === '?') {
    return <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-accent-green" />;
  }
  if (code === 'D') return <FileMinus2 className="h-3.5 w-3.5 shrink-0 text-accent-red" />;
  if (code === 'R') return <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-accent-blue" />;
  if (code === 'U') return <GitMerge className="h-3.5 w-3.5 shrink-0 text-accent-yellow" />;
  return <FileDiff className="h-3.5 w-3.5 shrink-0 text-accent-yellow" />;
}

// ---------------------------------------------------------------------------
// Tab button
// ---------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-full flex-1 items-center justify-center gap-1.5 text-[12px] font-medium transition-colors',
        active
          ? 'border-b-2 border-accent-purple text-text-primary'
          : 'border-b-2 border-transparent text-text-muted hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Right pane — Changes mode (diff viewer)
// ---------------------------------------------------------------------------

function ChangesRightPane({
  filePath,
  fileEntry,
  diff,
  loading,
  empty,
  t,
}: {
  filePath: string | null;
  fileEntry?: { indexStatus: string; workingStatus: string; oldPath?: string };
  diff: string;
  loading: boolean;
  empty: boolean;
  t: TFunction;
}) {
  if (empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <CheckCircle2 className="h-10 w-10 text-text-faint" />
        <div className="mt-3 text-[14px] font-medium text-text-primary">
          {t('issues.code.allCleanTitle')}
        </div>
        <div className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-text-muted">
          {t('issues.code.allCleanBody')}
        </div>
      </div>
    );
  }
  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-text-muted">
        {t('issues.code.selectFileForDiff')}
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('issues.code.loadingDiff')}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background-card/40 px-4">
        <FileStatusIcon
          code={
            fileEntry?.workingStatus !== ' '
              ? (fileEntry?.workingStatus ?? 'M')
              : (fileEntry?.indexStatus ?? 'M')
          }
        />
        <span className="font-mono text-[12px] text-text-primary">
          <PathDisplay path={filePath} />
        </span>
        {fileEntry?.oldPath && fileEntry.oldPath !== filePath && (
          <span className="ml-2 font-mono text-[11px] text-text-faint">← {fileEntry.oldPath}</span>
        )}
        <div className="ml-auto flex items-center gap-2 text-[10.5px] uppercase tracking-wider text-text-faint">
          <DiffStats diff={diff} />
        </div>
      </div>
      <DiffViewer diff={diff} path={filePath ?? ''} />
    </div>
  );
}

function DiffStats({ diff }: { diff: string }) {
  const { adds, dels } = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) adds++;
      else if (line.startsWith('-') && !line.startsWith('---')) dels++;
    }
    return { adds, dels };
  }, [diff]);
  if (adds === 0 && dels === 0) return null;
  return (
    <>
      <span className="text-accent-green">+{adds}</span>
      <span className="text-accent-red">−{dels}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Diff viewer with line numbers (GH Desktop style)
// ---------------------------------------------------------------------------

interface DiffLine {
  kind: 'add' | 'del' | 'hunk' | 'meta' | 'context';
  oldNum: number | null;
  newNum: number | null;
  text: string;
}

function parseDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNum = 0;
  let newNum = 0;
  for (const line of raw.split('\n')) {
    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('similarity ') ||
      line.startsWith('rename ') ||
      line.startsWith('Binary files')
    ) {
      out.push({ kind: 'meta', oldNum: null, newNum: null, text: line });
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+),?\d* \+(\d+),?\d* @@/.exec(line);
      if (m) {
        oldNum = parseInt(m[1], 10);
        newNum = parseInt(m[2], 10);
      }
      out.push({ kind: 'hunk', oldNum: null, newNum: null, text: line });
      continue;
    }
    if (line.startsWith('+')) {
      out.push({ kind: 'add', oldNum: null, newNum: newNum++, text: line.slice(1) });
      continue;
    }
    if (line.startsWith('-')) {
      out.push({ kind: 'del', oldNum: oldNum++, newNum: null, text: line.slice(1) });
      continue;
    }
    out.push({
      kind: 'context',
      oldNum: oldNum++,
      newNum: newNum++,
      text: line.startsWith(' ') ? line.slice(1) : line,
    });
  }
  return out;
}

function DiffViewer({ diff, path }: { diff: string; path: string }) {
  const { t } = useT();
  const lines = useMemo(() => parseDiff(diff), [diff]);
  const { variant } = useCodeTheme();
  const language = langFromPath(path);
  if (lines.length === 0 || diff.trim() === '') {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-text-muted">
        {t('issues.code.noDiff')}
      </div>
    );
  }
  const rowBg = (kind: DiffLine['kind']) =>
    cn(
      kind === 'add' && 'bg-accent-green/[0.08]',
      kind === 'del' && 'bg-accent-red/[0.08]',
      kind === 'hunk' && 'bg-surface-hover',
    );
  return (
    <div className="thin-scrollbar min-h-0 flex-1 overflow-auto bg-background">
      {/* Linha flex de altura total: a calha (gutter) à esquerda estica até o fim
          do painel via min-h-full, mesmo com poucas linhas de diff. */}
      <div className="flex min-h-full w-fit min-w-full font-mono text-[11.5px] leading-[18px]">
        {/* Calha contínua: colunas old#/new# com seus separadores, full-height. */}
        <div className="flex min-h-full shrink-0 select-none">
          {/* Calha unica: um numero por linha (novo; cai pro antigo em linhas removidas). */}
          <div className="flex min-h-full w-[52px] flex-col border-r border-hairline">
            {lines.map((l, i) => (
              <div
                key={i}
                className={cn(
                  'px-1.5 text-right text-[10.5px] tabular-nums',
                  rowBg(l.kind),
                  l.kind === 'add'
                    ? 'text-accent-green/60'
                    : l.kind === 'del'
                      ? 'text-accent-red/60'
                      : 'text-text-faint',
                )}
              >
                {l.newNum ?? l.oldNum ?? ' '}
              </div>
            ))}
            <div className="flex-1" />
          </div>
        </div>
        {/* Coluna de código (sinal +/- + texto), cresce conforme conteúdo. */}
        <div className="flex min-h-full flex-1 flex-col">
          {lines.map((l, i) => (
            <div key={i} className={cn('flex pl-2', rowBg(l.kind))}>
              <span
                className={cn(
                  'w-[16px] shrink-0 select-none text-center text-[11px]',
                  l.kind === 'add' && 'text-accent-green',
                  l.kind === 'del' && 'text-accent-red',
                )}
              >
                {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
              </span>
              {l.kind === 'hunk' || l.kind === 'meta' ? (
                <span
                  className={cn(
                    'whitespace-pre px-3',
                    l.kind === 'hunk' && 'text-text-muted',
                    l.kind === 'meta' && 'text-text-faint',
                  )}
                >
                  {l.text || ' '}
                </span>
              ) : (
                <Highlight code={l.text || ' '} language={language} theme={variant.prism}>
                  {({ tokens, getTokenProps }) => (
                    <span className="whitespace-pre px-3">
                      {(tokens[0] ?? []).map((token, k) => (
                        <span key={k} {...getTokenProps({ token })} />
                      ))}
                    </span>
                  )}
                </Highlight>
              )}
            </div>
          ))}
          {/* preenche o restante para a calha alinhar à direita do código */}
          <div className="flex-1" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History list + right pane
// ---------------------------------------------------------------------------

function HistoryList({
  loading,
  error,
  commits,
  selected,
  onSelect,
  t,
}: {
  loading: boolean;
  error: string | null;
  commits: Array<{
    sha: string;
    shortSha: string;
    subject: string;
    authorName: string;
    relativeDate: string;
  }>;
  selected: string | null;
  onSelect: (sha: string) => void;
  t: TFunction;
}) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('issues.code.loadingHistory')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="m-3 rounded-md border border-accent-red/30 bg-accent-red/10 p-3 text-[11.5px] text-accent-red">
        {error}
      </div>
    );
  }
  if (commits.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-text-muted">
        {t('issues.code.noCommits')}
      </div>
    );
  }
  return (
    <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
      {commits.map((c) => (
        <button
          key={c.sha}
          type="button"
          onClick={() => onSelect(c.sha)}
          className={cn(
            'flex w-full flex-col gap-0.5 border-l-2 border-transparent border-b border-white/[0.025] px-3 py-2 text-left transition-colors',
            selected === c.sha
              ? 'border-l-accent-purple bg-accent-purple/[0.06]'
              : 'hover:bg-surface-hover',
          )}
        >
          <span className="truncate text-[12.5px] font-medium text-text-primary">{c.subject}</span>
          <span className="flex items-center gap-1.5 text-[10.5px] text-text-muted">
            <code className="rounded bg-surface-2 px-1 font-mono text-[10px] text-text-faint">
              {c.shortSha}
            </code>
            <span className="truncate">{c.authorName}</span>
            <span>·</span>
            <span>{c.relativeDate}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function HistoryRightPane({
  sourceId,
  commit,
  t,
}: {
  sourceId: string;
  commit: {
    sha: string;
    shortSha: string;
    subject: string;
    body: string;
    authorName: string;
    authorEmail: string;
    relativeDate: string;
    isoDate: string;
  } | null;
  t: TFunction;
}) {
  // Diff de um commit — usamos git:diff com truque: passamos um pseudo path
  // Para simplificar, mostramos só metadata + corpo da mensagem por enquanto.
  void sourceId;
  if (!commit) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-text-muted">
        {t('issues.code.selectCommit')}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border bg-background-card/40 px-5 py-3">
        <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-wider text-text-faint">
          <History className="h-3 w-3" />
          {t('issues.code.commitLabel')} · {commit.relativeDate}
        </div>
        <div className="mt-1 text-[14.5px] font-semibold tracking-tight text-text-primary">
          {commit.subject}
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-text-muted">
          <code className="rounded bg-surface-2 px-1 font-mono">{commit.shortSha}</code>
          <span>·</span>
          <span>{commit.authorName}</span>
          <span className="text-text-faint">&lt;{commit.authorEmail}&gt;</span>
        </div>
      </div>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {commit.body ? (
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-text-secondary">
            {commit.body}
          </pre>
        ) : (
          <div className="text-[12px] italic text-text-muted">{t('issues.code.noMessageBody')}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function CreateBranchModal({
  currentBranch,
  onClose,
  onCreate,
  busy,
  error,
}: {
  currentBranch: string | null;
  onClose: () => void;
  onCreate: (name: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[440px]" hideClose>
        <div className="border-b border-hairline px-5 py-3.5">
          <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
            <GitBranch className="h-4 w-4 text-text-secondary" />
            {t('issues.code.newBranch')}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px] text-text-muted">
            {t('issues.code.createBranchFrom')}{' '}
            <code className="rounded bg-surface-2 px-1 text-text-secondary">
              {currentBranch ?? 'HEAD'}
            </code>
          </DialogDescription>
        </div>
        <div className="px-5 py-4">
          <label className="mb-1.5 block text-[11px] uppercase tracking-wider text-text-faint">
            {t('issues.code.branchName')}
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) onCreate(name.trim());
              if (e.key === 'Escape') onClose();
            }}
            placeholder={t('issues.code.branchNamePlaceholder')}
            className="h-10 w-full rounded-md border border-hairline-strong bg-black/30 px-3 text-[13px] text-text-primary placeholder:text-text-faint focus:border-accent-purple/50 focus:outline-none"
          />
          {error && (
            <div className="mt-3 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-1.5 text-[11.5px] text-accent-red">
              {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-hairline bg-black/20 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-md border border-hairline-strong bg-surface-faint px-3 text-[12px] text-text-secondary hover:bg-surface-active"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => name.trim() && onCreate(name.trim())}
            disabled={busy || !name.trim()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-purple px-3 text-[12px] font-medium text-white hover:bg-accent-purple/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {t('issues.code.createBranch')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OpenPrModal({
  sourceId,
  repoFullName,
  headBranch,
  defaultTitle,
  defaultBody,
  onClose,
}: {
  sourceId: string;
  repoFullName: string;
  headBranch: string;
  defaultTitle: string;
  defaultBody: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState(defaultBody);
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(false);
  const [result, setResult] = useState<{ number: number; htmlUrl: string } | null>(null);

  // Prefill inteligente: título/corpo a partir do DIFF da branch vs base + a base
  // default do repo. Só preenche campos que o usuário ainda não mexeu.
  const suggest = useMutation({
    mutationFn: () => window.orkestral['git:suggest-pr']({ sourceId }),
    onSuccess: (s) => {
      setTitle((cur) => (cur.trim() ? cur : s.title));
      setBody((cur) => (cur.trim() ? cur : s.body));
      setBase((cur) => (cur.trim() ? cur : s.base));
    },
  });
  useEffect(() => {
    suggest.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cria o PR "prontinho": publica a branch (push -u) + resolve a base + abre o PR.
  const mutation = useMutation({
    mutationFn: () =>
      window.orkestral['git:create-pr']({
        sourceId,
        title: title.trim(),
        body: body.trim() || undefined,
        base: base.trim() || undefined,
        draft,
      }),
    onSuccess: (res) => setResult(res),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[600px]" hideClose>
        <div className="border-b border-hairline px-5 py-3.5">
          <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
            <GitPullRequest className="h-4 w-4 text-text-secondary" />
            {t('issues.code.openPullRequest')}
          </DialogTitle>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-text-muted">
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{repoFullName}</code>
            <code className="rounded bg-accent-blue/[0.12] px-1.5 py-0.5 font-mono text-accent-blue">
              {headBranch}
            </code>
            <span className="text-text-faint">→</span>
            <input
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder={t('issues.code.prBasePlaceholder')}
              className="w-32 rounded border border-hairline bg-black/30 px-1.5 py-0.5 font-mono text-[11px] text-text-primary placeholder:text-text-faint focus:border-accent-purple/50 focus:outline-none"
              disabled={!!result}
            />
          </div>
        </div>

        <div className="px-5 py-4">
          {result ? (
            <div className="rounded-md border border-accent-green/30 bg-accent-green/10 p-4">
              <div className="flex items-center gap-2 text-[13px] font-medium text-accent-green">
                <CheckCircle2 className="h-4 w-4" />
                {t('issues.code.prCreated', { number: result.number })}
              </div>
              <div className="mt-2 text-[12px] text-text-secondary">
                <a
                  href={result.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-blue underline underline-offset-2 hover:text-accent-blue/80"
                >
                  {result.htmlUrl}
                </a>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[11px] uppercase tracking-wider text-text-faint">
                  {t('issues.code.prTitle')}
                </label>
                <button
                  type="button"
                  onClick={() => suggest.mutate()}
                  disabled={suggest.isPending}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-hairline-strong bg-surface-faint px-2 text-[11px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary disabled:opacity-50"
                >
                  {suggest.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  {t('issues.code.generateWithAi')}
                </button>
              </div>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('issues.code.prTitlePlaceholder')}
                className="mb-3 h-10 w-full rounded-md border border-hairline-strong bg-black/30 px-3 text-[13px] text-text-primary placeholder:text-text-faint focus:border-accent-purple/50 focus:outline-none"
              />
              <label className="mb-1.5 block text-[11px] uppercase tracking-wider text-text-faint">
                {t('issues.code.prDescription')}
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t('issues.code.prDescriptionPlaceholder')}
                rows={6}
                className="thin-scrollbar w-full resize-none rounded-md border border-hairline-strong bg-black/30 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-faint focus:border-accent-purple/50 focus:outline-none"
              />
              <label className="mt-3 flex items-center gap-2 text-[12px] text-text-secondary">
                <Checkbox checked={draft} onChange={(e) => setDraft(e.target.checked)} />
                {t('issues.code.markAsDraft')}
              </label>
              {mutation.isError && (
                <div className="mt-3 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-1.5 text-[11.5px] text-accent-red">
                  {mutation.error instanceof Error
                    ? mutation.error.message
                    : t('issues.code.prCreateFailed')}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline bg-black/20 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-md border border-hairline-strong bg-surface-faint px-3 text-[12px] text-text-secondary hover:bg-surface-active"
          >
            {result ? t('common.close') : t('common.cancel')}
          </button>
          {!result && (
            <button
              type="button"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !title.trim()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-purple px-3 text-[12px] font-medium text-white hover:bg-accent-purple/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitPullRequest className="h-3.5 w-3.5" />
              )}
              {t('issues.code.openPr')}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="text-text-muted">{icon}</div>
      <div className="mt-3 text-[14px] font-medium text-text-primary">{title}</div>
      <div className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-text-muted">
        {description}
      </div>
    </div>
  );
}

void FileText;
