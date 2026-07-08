import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Folder, Github, GitBranch, Loader2, ChevronRight, Search } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { useUIStore } from '@renderer/stores/uiStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import { ROLE_META, ROLE_ORDER } from '@renderer/lib/role-meta';
import type {
  GithubRepoSummary,
  AzureDevopsRepoSummary,
  WorkspaceSource,
  WorkspaceSourceKind,
  WorkspaceSourceRole,
} from '@shared/types';

const ROLE_SELECT_OPTIONS = ROLE_ORDER.map((value) => {
  const meta = ROLE_META[value];
  const Icon = meta.icon;
  return {
    value,
    label: meta.label,
    icon: <Icon className={cn('h-3.5 w-3.5', meta.color)} />,
  };
});

type AddTab = 'github' | 'azure' | 'folder';

/**
 * Modal global de "Adicionar source". Aberta via `useUIStore().openAddSource()`
 * de qualquer lugar (sidebar, comando, etc). Lê o workspace ativo do
 * workspaceStore. Já fica montada no `App.tsx`.
 */
export function AddSourceDialog() {
  const { t } = useT();
  const open = useUIStore((s) => s.addSourceOpen);
  const closeAddSource = useUIStore((s) => s.closeAddSource);
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AddTab>('github');

  const sourcesQuery = useQuery<WorkspaceSource[]>({
    queryKey: ['sources', activeWorkspace?.id],
    enabled: !!activeWorkspace && open,
    queryFn: () => window.orkestral['source:list']({ workspaceId: activeWorkspace!.id }),
  });
  const hasAnySource = (sourcesQuery.data ?? []).length > 0;

  const [analyzeAfterCreate, setAnalyzeAfterCreate] = useState(true);

  const createMutation = useMutation({
    mutationFn: (input: {
      workspaceId: string;
      kind: WorkspaceSourceKind;
      label: string;
      path?: string | null;
      repoFullName?: string | null;
      role?: WorkspaceSourceRole | null;
      isPrimary?: boolean;
      skipClone?: boolean;
      runHiringPlanAfterCreate?: boolean;
      runKnowledgeAnalysisAfterCreate?: boolean;
    }) => window.orkestral['source:create'](input),
    onSuccess: async (source) => {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
      queryClient.invalidateQueries({ queryKey: ['kb-source-coverage', source.workspaceId] });
      closeAddSource();
    },
  });

  // Linka um source local existente ao GitHub (promove pra github_repo) — usado quando
  // o repo escolhido já é uma pasta local com .git, pra não duplicar.
  const linkMutation = useMutation({
    mutationFn: (v: { sourceId: string; repoFullName: string }) =>
      window.orkestral['source:link-repo'](v),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
      closeAddSource();
    },
  });

  // Pasta local: cria várias de uma vez (a pasta-mãe + cada repo git achado na
  // varredura). Reusa o source:create com os flags de análise; o hiring plan
  // roda uma vez só (no último item), pra não propor vários times.
  const createFoldersMutation = useMutation({
    mutationFn: async (
      items: Array<{
        label: string;
        path: string;
        role: WorkspaceSourceRole | null;
        // Quando a pasta já é um repo git com remote e o usuário opta por "apontar
        // pro repo existente": linka como github_repo/azure_repo (sem re-clonar).
        kind?: WorkspaceSourceKind;
        repoFullName?: string | null;
      }>,
    ) => {
      let primary = !hasAnySource;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        await window.orkestral['source:create']({
          workspaceId: activeWorkspace!.id,
          kind: it.kind ?? 'local_folder',
          label: it.label,
          path: it.path,
          repoFullName: it.repoFullName ?? null,
          role: it.role,
          isPrimary: primary,
          runKnowledgeAnalysisAfterCreate: analyzeAfterCreate,
          runHiringPlanAfterCreate: analyzeAfterCreate && i === items.length - 1,
        });
        primary = false;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
      queryClient.invalidateQueries({ queryKey: ['kb-source-coverage', activeWorkspace!.id] });
      closeAddSource();
    },
    // Falha no meio do loop: parte dos itens já foi criada. Reflete o estado
    // parcial na lista (o source:create deduplica por path, então um re-submit
    // não duplica). O diálogo fica aberto pro usuário tentar o resto.
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
      queryClient.invalidateQueries({ queryKey: ['kb-source-coverage', activeWorkspace!.id] });
    },
  });

  if (!activeWorkspace) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeAddSource();
      }}
    >
      <DialogContent className="max-w-xl">
        <div className="border-b border-hairline-faint px-6 pt-6 pb-4">
          <DialogTitle className="text-[15px] font-semibold tracking-tight text-text-primary">
            {t('workspace.addSource.title')}
          </DialogTitle>
          <p className="mt-1 text-[11.5px] text-text-muted">{t('workspace.addSource.subtitle')}</p>

          <div className="mt-4 flex gap-1">
            <TabBtn active={tab === 'github'} onClick={() => setTab('github')}>
              <Github className="h-3.5 w-3.5" />
              {t('workspace.addSource.githubTab')}
            </TabBtn>
            <TabBtn active={tab === 'azure'} onClick={() => setTab('azure')}>
              <GitBranch className="h-3.5 w-3.5" />
              {t('workspace.addSource.azureTab')}
            </TabBtn>
            <TabBtn active={tab === 'folder'} onClick={() => setTab('folder')}>
              <Folder className="h-3.5 w-3.5" />
              {t('workspace.addSource.folderTab')}
            </TabBtn>
          </div>
        </div>

        <div className="px-6 py-5">
          {tab === 'github' ? (
            <GithubRepoForm
              busy={createMutation.isPending || linkMutation.isPending}
              error={
                createMutation.error instanceof Error
                  ? createMutation.error.message
                  : linkMutation.error instanceof Error
                    ? linkMutation.error.message
                    : null
              }
              workspaceId={activeWorkspace.id}
              onLink={(sourceId, repoFullName) => linkMutation.mutate({ sourceId, repoFullName })}
              onSubmit={({ addToTree, ...input }) =>
                createMutation.mutate({
                  workspaceId: activeWorkspace.id,
                  kind: 'github_repo',
                  ...input,
                  // Não adicionar à árvore = conectar só pra PRs (sem clonar).
                  skipClone: !addToTree,
                  isPrimary: !hasAnySource,
                  runHiringPlanAfterCreate: analyzeAfterCreate,
                  runKnowledgeAnalysisAfterCreate: analyzeAfterCreate,
                })
              }
            />
          ) : tab === 'azure' ? (
            <AzureRepoForm
              busy={createMutation.isPending}
              error={createMutation.error instanceof Error ? createMutation.error.message : null}
              onSubmit={(input) =>
                createMutation.mutate({
                  workspaceId: activeWorkspace.id,
                  kind: 'azure_repo',
                  ...input,
                  isPrimary: !hasAnySource,
                  runHiringPlanAfterCreate: analyzeAfterCreate,
                  runKnowledgeAnalysisAfterCreate: analyzeAfterCreate,
                })
              }
            />
          ) : (
            <LocalFolderForm
              busy={createFoldersMutation.isPending}
              error={
                createFoldersMutation.error instanceof Error
                  ? createFoldersMutation.error.message
                  : null
              }
              onSubmit={(items) => createFoldersMutation.mutate(items)}
            />
          )}

          <label className="mt-5 flex cursor-pointer items-start gap-2.5 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2.5 hover:bg-surface-hover">
            <input
              type="checkbox"
              checked={analyzeAfterCreate}
              onChange={(e) => setAnalyzeAfterCreate(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-accent-blue"
            />
            <div className="flex-1">
              <div className="text-[12.5px] font-medium text-text-primary">
                {t('workspace.addSource.analyzeTitle')}
              </div>
              <div className="mt-0.5 text-[11px] text-text-muted">
                {t('workspace.addSource.analyzeDescription')}
              </div>
            </div>
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TabBtn({
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
        'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors',
        active
          ? 'bg-surface-active text-text-primary'
          : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}

function GithubRepoForm({
  busy,
  error,
  workspaceId,
  onSubmit,
  onLink,
}: {
  busy: boolean;
  error: string | null;
  workspaceId: string;
  onSubmit: (input: {
    label: string;
    repoFullName: string;
    role: WorkspaceSourceRole | null;
    addToTree: boolean;
  }) => void;
  onLink: (sourceId: string, repoFullName: string) => void;
}) {
  const { t } = useT();
  const reposQuery = useQuery<GithubRepoSummary[]>({
    queryKey: ['github-repos'],
    queryFn: () => window.orkestral['github:list-repos'](),
  });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<GithubRepoSummary | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [roleDraft, setRoleDraft] = useState('');
  const [addToTree, setAddToTree] = useState(true);

  // Dedupe: o repo selecionado já é um source (github direto ou pasta local com .git)?
  const matchQuery = useQuery({
    queryKey: ['source-match-repo', workspaceId, selected?.fullName],
    enabled: !!selected,
    queryFn: () =>
      window.orkestral['source:match-repo']({ workspaceId, repoFullName: selected!.fullName }),
  });
  const match = selected ? (matchQuery.data?.source ?? null) : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reposQuery.data ?? [];
    return (reposQuery.data ?? []).filter((r) => r.fullName.toLowerCase().includes(q));
  }, [reposQuery.data, query]);

  if (selected) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3 rounded-lg border border-hairline bg-surface-faint p-3">
          <Github className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[12.5px] text-text-primary">
              {selected.fullName}
            </div>
            {selected.description && (
              <p className="mt-0.5 text-[11.5px] text-text-muted">{selected.description}</p>
            )}
          </div>
        </div>

        {matchQuery.isPending ? (
          <div className="flex items-center gap-2 py-2 text-[12px] text-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('workspace.addSource.checkingDuplicate')}
          </div>
        ) : match ? (
          // Já existe um source pra este repo → não duplica. github_repo = já conectado;
          // local_folder = oferece linkar (promove pra github_repo, mantém o checkout).
          <>
            <div className="rounded-md border border-accent-blue/30 bg-accent-blue/[0.06] px-3 py-2.5 text-[12px] leading-relaxed text-text-secondary">
              {match.kind === 'github_repo'
                ? t('workspace.addSource.alreadyConnected', { label: match.label })
                : t('workspace.addSource.alreadyLocalSource', { label: match.label })}
            </div>
            {error && (
              <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 border-t border-hairline-faint pt-4">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="inline-flex h-9 items-center rounded-lg border border-hairline-strong px-3.5 text-[12.5px] text-text-secondary hover:bg-surface-1 hover:text-text-primary"
              >
                {t('common.back')}
              </button>
              {match.kind !== 'github_repo' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onLink(match.id, selected.fullName)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t('workspace.addSource.connectForPrs')}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <Field label={t('workspace.addSource.labelLabel')}>
              <input
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                placeholder={selected.name}
                className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-muted transition-colors focus:border-hairline-intense focus:bg-surface-1 focus:outline-none"
              />
            </Field>

            <Field label={t('workspace.addSource.roleLabel')}>
              <DSSelect
                value={roleDraft}
                onChange={setRoleDraft}
                options={ROLE_SELECT_OPTIONS}
                placeholder={t('workspace.addSource.rolePlaceholder')}
                className="h-10 w-full text-[13px]"
              />
            </Field>

            {/* Adicionar à árvore = clonar o repo. Desmarcado: conecta só pra PRs (sem
                clonar, não aparece na árvore de código) — evita duplicar com pasta local. */}
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2.5 hover:bg-surface-hover">
              <input
                type="checkbox"
                checked={addToTree}
                onChange={(e) => setAddToTree(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-accent-blue"
              />
              <span className="min-w-0">
                <span className="block text-[12.5px] text-text-primary">
                  {t('workspace.addSource.addToTree')}
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">
                  {t('workspace.addSource.addToTreeHint')}
                </span>
              </span>
            </label>

            {error && (
              <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-hairline-faint pt-4">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="inline-flex h-9 items-center rounded-lg border border-hairline-strong px-3.5 text-[12.5px] text-text-secondary hover:bg-surface-1 hover:text-text-primary"
              >
                {t('common.back')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onSubmit({
                    label: labelDraft.trim() || selected.name,
                    repoFullName: selected.fullName,
                    role: (roleDraft || null) as WorkspaceSourceRole | null,
                    addToTree,
                  })
                }
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('workspace.addSource.submit')}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('workspace.addSource.searchPlaceholder')}
          className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle pl-9 pr-3 text-[13px] text-text-primary placeholder:text-text-muted transition-colors focus:border-hairline-intense focus:bg-surface-1 focus:outline-none"
        />
      </div>

      <div className="thin-scrollbar -mx-1 max-h-[340px] overflow-y-auto px-1">
        {reposQuery.isPending ? (
          <div className="flex items-center justify-center py-10 text-[12px] text-text-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('workspace.repoPicker.loading')}
          </div>
        ) : reposQuery.isError ? (
          <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] p-3 text-[11.5px] text-accent-red">
            {(reposQuery.error as Error)?.message ?? t('workspace.repoPicker.listError')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-text-muted">
            {t('workspace.repoPicker.empty')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.slice(0, 50).map((r) => (
              <button
                key={r.fullName}
                type="button"
                onClick={() => {
                  setSelected(r);
                  setLabelDraft(r.name);
                }}
                className="group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-1"
              >
                <Github className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted group-hover:text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[12px] text-text-primary">{r.fullName}</div>
                  {r.description && (
                    <div className="mt-0.5 truncate text-[11px] text-text-muted">
                      {r.description}
                    </div>
                  )}
                </div>
                <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-text-faint group-hover:text-text-secondary" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AzureRepoForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (input: {
    label: string;
    repoFullName: string;
    role: WorkspaceSourceRole | null;
  }) => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const accountQuery = useQuery({
    queryKey: ['azure-devops-account'],
    queryFn: () => window.orkestral['azure-devops:get-account'](),
  });
  const reposQuery = useQuery<AzureDevopsRepoSummary[]>({
    queryKey: ['azure-devops-repos'],
    enabled: !!accountQuery.data,
    queryFn: () => window.orkestral['azure-devops:list-repos']({}),
  });
  const startFlowMutation = useMutation({
    mutationFn: () => window.orkestral['azure-devops:start-device-flow'](),
    onSuccess: async (flow) => {
      await window.orkestral['azure-devops:open-verification']({ url: flow.verificationUri });
      const started = Date.now();
      let interval = Math.max(3, flow.interval);
      while (Date.now() - started < flow.expiresIn * 1000) {
        await new Promise((resolve) => window.setTimeout(resolve, interval * 1000));
        const poll = await window.orkestral['azure-devops:poll-device-flow']({
          deviceCode: flow.deviceCode,
        });
        if (poll.status === 'pending') continue;
        if (poll.status === 'slow_down') {
          interval = Math.max(interval + 2, poll.interval);
          continue;
        }
        if (poll.status === 'authorized') {
          queryClient.invalidateQueries({ queryKey: ['azure-devops-account'] });
          queryClient.invalidateQueries({ queryKey: ['azure-devops-repos'] });
          return;
        }
        throw new Error(t('workspace.addSource.azureAuthCancelled'));
      }
      throw new Error(t('workspace.addSource.azureAuthExpired'));
    },
  });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AzureDevopsRepoSummary | null>(null);
  const [label, setLabel] = useState('');
  const [role, setRole] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reposQuery.data ?? [];
    return (reposQuery.data ?? []).filter((r) => r.fullName.toLowerCase().includes(q));
  }, [reposQuery.data, query]);

  if (!accountQuery.data) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-hairline bg-surface-faint px-3 py-2.5 text-[11.5px] leading-relaxed text-text-muted">
          {t('workspace.addSource.azureConnectHelp')}
        </div>
        {startFlowMutation.error && (
          <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
            {(startFlowMutation.error as Error).message}
          </div>
        )}
        <div className="flex justify-end border-t border-hairline-faint pt-4">
          <button
            type="button"
            disabled={startFlowMutation.isPending}
            onClick={() => startFlowMutation.mutate()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
          >
            {startFlowMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('workspace.addSource.azureConnect')}
          </button>
        </div>
      </div>
    );
  }

  if (selected) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3 rounded-lg border border-hairline bg-surface-faint p-3">
          <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[12.5px] text-text-primary">
              {selected.fullName}
            </div>
            <p className="mt-0.5 text-[11.5px] text-text-muted">{selected.remoteUrl}</p>
          </div>
        </div>

        <Field label={t('workspace.addSource.labelLabel')}>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={selected.name}
            className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-muted transition-colors focus:border-hairline-intense focus:bg-surface-1 focus:outline-none"
          />
        </Field>

        <Field label={t('workspace.addSource.roleLabel')}>
          <DSSelect
            value={role}
            onChange={setRole}
            options={ROLE_SELECT_OPTIONS}
            placeholder={t('workspace.addSource.rolePlaceholder')}
            className="h-10 w-full text-[13px]"
          />
        </Field>

        {error && (
          <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-hairline-faint pt-4">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="inline-flex h-9 items-center rounded-lg border border-hairline-strong px-3.5 text-[12.5px] text-text-secondary hover:bg-surface-1 hover:text-text-primary"
          >
            {t('common.back')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onSubmit({
                label: label.trim() || selected.name,
                repoFullName: selected.remoteUrl,
                role: (role || null) as WorkspaceSourceRole | null,
              })
            }
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('workspace.addSource.submit')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('workspace.addSource.azureSearchPlaceholder')}
          className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle pl-9 pr-3 text-[13px] text-text-primary placeholder:text-text-muted transition-colors focus:border-hairline-intense focus:bg-surface-1 focus:outline-none"
        />
      </div>

      <div className="thin-scrollbar -mx-1 max-h-[340px] overflow-y-auto px-1">
        {reposQuery.isPending ? (
          <div className="flex items-center justify-center py-10 text-[12px] text-text-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('workspace.addSource.azureLoading')}
          </div>
        ) : reposQuery.isError ? (
          <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] p-3 text-[11.5px] text-accent-red">
            {(reposQuery.error as Error)?.message ?? t('workspace.addSource.azureListError')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-text-muted">
            {t('workspace.addSource.azureEmpty')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.slice(0, 80).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setSelected(r);
                  setLabel(r.name);
                }}
                className="group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-1"
              >
                <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted group-hover:text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[12px] text-text-primary">{r.fullName}</div>
                  <div className="mt-0.5 truncate text-[11px] text-text-muted">{r.remoteUrl}</div>
                </div>
                <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-text-faint group-hover:text-text-secondary" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type FolderPick = {
  path: string;
  label: string;
  role: WorkspaceSourceRole | null;
  isGit: boolean;
  checked: boolean;
};

function baseName(p: string): string {
  return p.split('/').filter(Boolean).pop() || p;
}

function LocalFolderForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (
    items: Array<{
      label: string;
      path: string;
      role: WorkspaceSourceRole | null;
      kind?: WorkspaceSourceKind;
      repoFullName?: string | null;
    }>,
  ) => void;
}) {
  const { t } = useT();
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [role, setRole] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // null = etapa inicial; array = etapa de seleção (achou repos dentro da pasta).
  const [picks, setPicks] = useState<FolderPick[] | null>(null);
  // Set quando a pasta JÁ é um repo git com remote github/azure → etapa de escolha
  // entre "apontar pro repo existente" ou "adicionar como pasta local".
  const [linkedRepo, setLinkedRepo] = useState<{
    provider: 'github' | 'azure';
    fullName: string;
  } | null>(null);

  async function pick() {
    const res = await window.orkestral['source:pick-folder']({});
    if (res.path) {
      setPath(res.path);
      if (!label) setLabel(baseName(res.path));
    }
  }

  async function proceed() {
    const p = path.trim();
    if (!p) return;
    setScanning(true);
    setScanError(null);
    try {
      const res = await window.orkestral['source:scan-folder']({ path: p });
      // Pasta JÁ é repo git com remote github/azure → oferece "apontar pro repo
      // existente" (linkar sem re-clonar) ou adicionar como pasta local.
      if (
        res.rootIsGit &&
        res.rootRemote &&
        (res.rootRemote.provider === 'github' || res.rootRemote.provider === 'azure')
      ) {
        setLinkedRepo({ provider: res.rootRemote.provider, fullName: res.rootRemote.fullName });
        return;
      }
      // Repo na raiz (sem remote) OU nenhum repo dentro → adiciona como pasta única.
      if (res.rootIsGit || res.repos.length === 0) {
        onSubmit([
          {
            label: label.trim() || baseName(p),
            path: p,
            role: (role || null) as WorkspaceSourceRole | null,
          },
        ]);
        return;
      }
      // Achou repos dentro → seleção: pasta-mãe + cada repo, tudo pré-marcado.
      setPicks([
        {
          path: p,
          label: label.trim() || baseName(p),
          role: (role || null) as WorkspaceSourceRole | null,
          isGit: false,
          checked: true,
        },
        ...res.repos.map((r) => ({
          path: r.path,
          label: r.name,
          role: null as WorkspaceSourceRole | null,
          isGit: true,
          checked: true,
        })),
      ]);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }

  function patchPick(idx: number, patch: Partial<FolderPick>) {
    setPicks((prev) => prev && prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  // ---- Etapa de escolha: a pasta já é um repo git com remote ----
  if (linkedRepo) {
    const finalLabel = label.trim() || baseName(path);
    const finalRole = (role || null) as WorkspaceSourceRole | null;
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-hairline-heavy bg-surface-hover px-3.5 py-3">
          <div className="flex items-center gap-2">
            {linkedRepo.provider === 'github' ? (
              <Github className="h-4 w-4 shrink-0 text-text-secondary" />
            ) : (
              <GitBranch className="h-4 w-4 shrink-0 text-text-secondary" />
            )}
            <span className="truncate font-mono text-[12px] text-text-primary">
              {linkedRepo.fullName}
            </span>
          </div>
          <p className="mt-1.5 text-[11.5px] text-text-muted">
            {t('workspace.folderPicker.existingRepoHint')}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onSubmit([
                {
                  label: finalLabel,
                  path,
                  role: finalRole,
                  kind: linkedRepo.provider === 'github' ? 'github_repo' : 'azure_repo',
                  repoFullName: linkedRepo.fullName,
                },
              ])
            }
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-white px-4 text-[12.5px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('workspace.folderPicker.linkExistingRepo')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSubmit([{ label: finalLabel, path, role: finalRole }])}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-hairline-strong bg-surface-1 px-4 text-[12.5px] font-medium text-text-primary hover:bg-surface-strong disabled:opacity-40"
          >
            {t('workspace.folderPicker.addAsLocalFolder')}
          </button>
        </div>

        {error && (
          <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={() => setLinkedRepo(null)}
          className="self-start text-[11.5px] text-text-muted hover:text-text-secondary"
        >
          {t('common.back')}
        </button>
      </div>
    );
  }

  // ---- Etapa de seleção (a pasta tem repos git dentro) ----
  if (picks) {
    const checkedCount = picks.filter((it) => it.checked).length;
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[12px] text-text-secondary">{t('workspace.folderPicker.scanFound')}</p>

        <div className="thin-scrollbar -mx-1 flex max-h-[320px] flex-col gap-1.5 overflow-y-auto px-1">
          {picks.map((it, idx) => (
            <div
              key={it.path}
              className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors',
                it.checked ? 'border-hairline-heavy bg-surface-hover' : 'border-hairline-faint',
              )}
            >
              <input
                type="checkbox"
                checked={it.checked}
                onChange={(e) => patchPick(idx, { checked: e.target.checked })}
                className="mt-1 h-3.5 w-3.5 cursor-pointer accent-accent-blue"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {it.isGit ? (
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-accent-yellow" />
                  )}
                  <span className="truncate font-mono text-[11px] text-text-muted">{it.path}</span>
                  {!it.isGit && (
                    <span className="shrink-0 rounded-full border border-hairline-heavy bg-surface-hover px-1.5 py-0.5 text-[9.5px] text-text-faint">
                      {t('workspace.folderPicker.localFolderBadge')}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={it.label}
                    onChange={(e) => patchPick(idx, { label: e.target.value })}
                    disabled={!it.checked}
                    placeholder={baseName(it.path)}
                    className="h-8 flex-1 rounded-md border border-hairline-strong bg-surface-subtle px-2.5 text-[12px] text-text-primary placeholder:text-text-muted transition-colors focus:border-hairline-intense focus:bg-surface-1 focus:outline-none disabled:opacity-40"
                  />
                  <DSSelect
                    value={it.role ?? ''}
                    onChange={(v) =>
                      patchPick(idx, { role: (v || null) as WorkspaceSourceRole | null })
                    }
                    options={ROLE_SELECT_OPTIONS}
                    placeholder={t('workspace.addSource.rolePlaceholder')}
                    className="h-8 w-36 text-[12px]"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        {error && (
          <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-hairline-faint pt-4">
          <button
            type="button"
            onClick={() => setPicks(null)}
            className="inline-flex h-9 items-center rounded-lg border border-hairline-strong px-3.5 text-[12.5px] text-text-secondary hover:bg-surface-1 hover:text-text-primary"
          >
            {t('common.back')}
          </button>
          <button
            type="button"
            disabled={busy || checkedCount === 0}
            onClick={() =>
              onSubmit(
                picks
                  .filter((it) => it.checked)
                  .map((it) => ({
                    label: it.label.trim() || baseName(it.path),
                    path: it.path,
                    role: it.role,
                  })),
              )
            }
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('workspace.folderPicker.addSelected', { count: checkedCount })}
          </button>
        </div>
      </div>
    );
  }

  // ---- Etapa inicial (escolher a pasta) ----
  return (
    <div className="flex flex-col gap-5">
      <Field label={t('workspace.folderPicker.folderLabel')}>
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t('workspace.folderPicker.folderPlaceholder')}
            className="h-10 flex-1 rounded-lg border border-hairline-strong bg-surface-subtle px-3 font-mono text-[12px] text-text-primary placeholder:text-text-muted transition-colors focus:border-hairline-intense focus:bg-surface-1 focus:outline-none"
          />
          <button
            type="button"
            onClick={pick}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-hairline-strong bg-surface-1 px-3 text-[12.5px] font-medium text-text-primary hover:bg-surface-strong"
          >
            <Folder className="h-3.5 w-3.5" />
            {t('common.choose')}
          </button>
        </div>
      </Field>

      <Field label={t('workspace.addSource.labelLabel')}>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('workspace.folderPicker.labelPlaceholder')}
          className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-muted transition-colors focus:border-hairline-intense focus:bg-surface-1 focus:outline-none"
        />
      </Field>

      <Field label={t('workspace.addSource.roleLabel')}>
        <DSSelect
          value={role}
          onChange={setRole}
          options={ROLE_SELECT_OPTIONS}
          placeholder={t('workspace.addSource.rolePlaceholder')}
          className="h-10 w-full text-[13px]"
        />
      </Field>

      {(error || scanError) && (
        <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
          {error || scanError}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-hairline-faint pt-4">
        <button
          type="button"
          disabled={busy || scanning || !path.trim()}
          onClick={proceed}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-4 text-[12.5px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
        >
          {(busy || scanning) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('workspace.addSource.submit')}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[10.5px] font-medium uppercase tracking-wider text-text-faint">
        {label}
      </label>
      {children}
    </div>
  );
}
