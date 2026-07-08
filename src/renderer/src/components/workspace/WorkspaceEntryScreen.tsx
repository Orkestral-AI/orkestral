import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Loader2, Plus, Trash2 } from 'lucide-react';
import { WorkspaceAvatar, workspaceCode } from '@renderer/components/layout/WorkspaceAvatar';
import { CreateWorkspaceWizard } from './CreateWorkspaceWizard';
import { Button } from '@renderer/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT } from '@renderer/i18n';
import logoIcon from '@renderer/assets/logo_icon.png';
import { cn } from '@renderer/lib/utils';
import type { Workspace, WorkspaceSource } from '@shared/types';

export function WorkspaceEntryScreen() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const setActive = useWorkspaceStore((s) => s.setActive);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => window.orkestral['workspace:list'](),
  });

  const switchMutation = useMutation({
    mutationFn: (workspaceId: string) => window.orkestral['workspace:switch']({ workspaceId }),
    onSuccess: (workspace) => {
      setActive(workspace);
      window.location.hash = '#/';
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['sessions', workspace.id] });
      queryClient.invalidateQueries({ queryKey: ['agents', workspace.id] });
      queryClient.invalidateQueries({ queryKey: ['sources', workspace.id] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (workspaceId: string) => window.orkestral['workspace:delete']({ workspaceId }),
    onSuccess: async () => {
      setDeleteTarget(null);
      setActive(null);
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });

  const workspaces = workspacesQuery.data ?? [];
  const pendingId = switchMutation.variables ?? null;

  return (
    <div className="window-drag relative flex h-full w-full items-center justify-center overflow-hidden bg-[#0b0a10] px-6">
      <EntryBackground />

      <div className="window-no-drag relative z-10 flex w-full max-w-[760px] flex-col">
        <div className="mb-8 flex items-center gap-3">
          <img src={logoIcon} alt="Orkestral" className="h-9 w-9 shrink-0" draggable={false} />
          <div>
            <div className="text-[18px] font-medium tracking-tight text-text-primary">
              {t('workspace.entry.title')}
            </div>
            <div className="mt-0.5 text-[12.5px] text-text-muted">
              {t('workspace.entry.subtitle')}
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-hairline-strong bg-surface-subtle shadow-2xl shadow-black/35">
          <div className="border-b border-hairline px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
              {t('workspace.entry.available')}
            </div>
          </div>

          <div className="thin-scrollbar max-h-[420px] overflow-y-auto p-2">
            {workspacesQuery.isPending ? (
              <div className="flex h-32 items-center justify-center text-[12.5px] text-text-muted">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('workspace.entry.loading')}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {workspaces.map((workspace) => (
                  <WorkspaceEntryRow
                    key={workspace.id}
                    workspace={workspace}
                    pending={pendingId === workspace.id}
                    onOpen={() => switchMutation.mutate(workspace.id)}
                    onDelete={() => setDeleteTarget(workspace)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-hairline px-4 py-3">
            <span className="text-[11.5px] text-text-muted">{t('workspace.entry.footer')}</span>
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-hairline-heavy bg-surface-1 px-3 text-[12.5px] font-medium text-text-primary transition-colors hover:bg-surface-4"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('workspace.entry.newWorkspace')}
            </button>
          </div>
        </div>
      </div>

      <CreateWorkspaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      <DeleteWorkspaceDialog
        workspace={deleteTarget}
        busy={deleteMutation.isPending}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}

function WorkspaceEntryRow({
  workspace,
  pending,
  onOpen,
  onDelete,
}: {
  workspace: Workspace;
  pending: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  const sourcesQuery = useQuery<WorkspaceSource[]>({
    queryKey: ['sources', workspace.id],
    queryFn: () => window.orkestral['source:list']({ workspaceId: workspace.id }),
  });

  const sources = sourcesQuery.data ?? [];
  const fallbackDescription = workspace.mission || workspace.gitRemote || workspace.path;
  const description =
    sources.length > 0
      ? sourceSummary(sources, t('workspace.entry.sourceCount', { count: sources.length }))
      : sourcesQuery.isPending
        ? (fallbackDescription ?? t('workspace.entry.loadingSources'))
        : (fallbackDescription ?? t('workspace.entry.localOnly'));
  const visibleSources = sources.slice(0, 4);
  const hiddenSources = Math.max(0, sources.length - visibleSources.length);

  return (
    <div
      role="button"
      tabIndex={pending ? -1 : 0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (pending) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors',
        'hover:bg-white/[0.055] focus:outline-none focus:ring-1 focus:ring-hairline-bright',
        pending && 'cursor-wait opacity-70',
      )}
    >
      <WorkspaceAvatar workspace={workspace} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-text-primary">
            {workspace.name}
          </span>
          <span className="rounded bg-surface-active px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
            {workspaceCode(workspace.name)}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-text-muted">{description}</div>
        {visibleSources.length > 0 && (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
            {visibleSources.map((source) => (
              <span
                key={source.id}
                className={cn(
                  'inline-flex max-w-[160px] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] leading-none',
                  source.isPrimary
                    ? 'border-accent-purple/25 bg-accent-purple/10 text-text-secondary'
                    : 'border-hairline bg-surface-3 text-text-muted',
                )}
                title={sourceTooltip(source)}
              >
                <span className="truncate">{sourceChipLabel(source)}</span>
                {source.isPrimary && (
                  <span className="shrink-0 text-[8px] uppercase tracking-wide text-accent-purple">
                    {t('workspace.entry.primary')}
                  </span>
                )}
              </span>
            ))}
            {hiddenSources > 0 && (
              <span className="inline-flex rounded-md border border-hairline bg-surface-subtle px-1.5 py-0.5 text-[10px] leading-none text-text-faint">
                {t('workspace.entry.moreSources', { count: hiddenSources })}
              </span>
            )}
          </div>
        )}
        {sourcesQuery.isError && (
          <div className="mt-1 text-[10.5px] text-accent-red">
            {t('workspace.entry.sourcesLoadError')}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-faint opacity-0 transition-colors hover:bg-accent-red/10 hover:text-accent-red group-hover:opacity-100"
        title={t('workspace.entry.delete')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors group-hover:bg-surface-active group-hover:text-text-primary">
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ArrowRight className="h-3.5 w-3.5" />
        )}
      </div>
    </div>
  );
}

function sourceSummary(sources: WorkspaceSource[], countLabel: string): string {
  const names = sources.slice(0, 2).map(sourceChipLabel).filter(Boolean);
  if (names.length === 0) return countLabel;
  const suffix = sources.length > names.length ? ` +${sources.length - names.length}` : '';
  return `${countLabel} · ${names.join(', ')}${suffix}`;
}

function sourceChipLabel(source: WorkspaceSource): string {
  const raw = source.label || source.repoFullName || source.path || source.kind;
  if (!raw) return source.kind;
  return compactSourceName(raw);
}

function sourceTooltip(source: WorkspaceSource): string {
  return source.repoFullName || source.path || source.label || source.kind;
}

function compactSourceName(value: string): string {
  const clean = value.replace(/\.git$/i, '');
  if (/^https?:\/\//i.test(clean)) {
    try {
      const url = new URL(clean);
      const path = url.pathname
        .replace(/^\/+/, '')
        .replace(/\/_git\//i, '/')
        .replace(/\.git$/i, '');
      return path.split('/').filter(Boolean).slice(-2).join('/') || url.hostname;
    } catch {
      return clean;
    }
  }
  if (clean.includes('/')) {
    return clean.split('/').filter(Boolean).slice(-2).join('/');
  }
  return clean;
}

function DeleteWorkspaceDialog({
  workspace,
  busy,
  onOpenChange,
  onConfirm,
}: {
  workspace: Workspace | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog open={!!workspace} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" hideClose={busy}>
        <div className="border-b border-hairline px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-red/10">
              <Trash2 className="h-4 w-4 text-accent-red" />
            </span>
            {t('workspace.entry.deleteTitle')}
          </DialogTitle>
        </div>
        <div className="px-5 py-4">
          <p className="text-[12.5px] leading-relaxed text-text-secondary">
            {t('workspace.entry.deleteBody', { name: workspace?.name ?? '' })}
          </p>
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-accent-red/25 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-accent-red">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('workspace.entry.deleteWarning')}</span>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline px-5 py-4">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('workspace.entry.deleteAction')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EntryBackground() {
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0 opacity-55"
        style={{
          backgroundImage:
            'radial-gradient(1px 1px at 18% 20%, rgba(220,222,230,0.42) 50%, transparent 100%),' +
            'radial-gradient(1px 1px at 72% 16%, rgba(220,222,230,0.38) 50%, transparent 100%),' +
            'radial-gradient(1.2px 1.2px at 82% 76%, rgba(220,222,230,0.36) 50%, transparent 100%),' +
            'radial-gradient(0.8px 0.8px at 30% 84%, rgba(255,255,255,0.3) 50%, transparent 100%)',
          backgroundRepeat: 'no-repeat',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(60% 50% at 50% 10%, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0) 70%)',
        }}
      />
    </div>
  );
}
