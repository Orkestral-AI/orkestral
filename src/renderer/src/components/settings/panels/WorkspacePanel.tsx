import { useState, useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Trash2,
  ArchiveRestore,
  Briefcase,
  Github,
  Folder,
  Laptop,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { PanelShell, Field } from './PanelShell';
import { WorkspacePicker } from '@renderer/components/workspace/WorkspacePicker';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { cn } from '@renderer/lib/utils';
import { formatDateTime } from '@renderer/lib/time';
import { useT } from '@renderer/i18n';
import { AutonomySlider, type AutonomyLevel } from '@renderer/components/agents/AutonomySlider';
import type { Agent, Workspace, WorkspaceSource } from '@shared/types';

/**
 * Painel "Workspace" das Configurações.
 *  - Mostra dados do workspace ativo (nome, missão, repo/pasta)
 *  - Permite arquivar (some do switcher, dados preservados)
 *  - Permite excluir permanentemente (com confirmação)
 *  - Lista workspaces arquivados pra reativar/excluir
 */
export function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const active = useWorkspaceStore((s) => s.active);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const queryClient = useQueryClient();

  // Workspace em visualização: inicia no ativo, mas o picker permite inspecionar
  // e arquivar/excluir qualquer workspace (não-arquivado) sem trocar o ativo.
  const [viewWs, setViewWs] = useState<Workspace | null>(active);
  useEffect(() => {
    if (!viewWs && active) setViewWs(active);
  }, [active, viewWs]);

  const archivedQuery = useQuery({
    queryKey: ['workspaces', 'archived'],
    queryFn: () => window.orkestral['workspace:list-archived'](),
  });

  const archiveMutation = useMutation({
    mutationFn: (workspaceId: string) => window.orkestral['workspace:archive']({ workspaceId }),
    onSuccess: () => invalidateAll(queryClient),
  });
  const unarchiveMutation = useMutation({
    mutationFn: (workspaceId: string) => window.orkestral['workspace:unarchive']({ workspaceId }),
    onSuccess: () => invalidateAll(queryClient),
  });
  const deleteMutation = useMutation({
    mutationFn: (workspaceId: string) => window.orkestral['workspace:delete']({ workspaceId }),
    onSuccess: () => invalidateAll(queryClient),
  });

  const [confirm, setConfirm] = useState<{
    workspace: Workspace;
    action: 'archive' | 'delete';
  } | null>(null);

  async function handleConfirm() {
    if (!confirm) return;
    const { workspace, action } = confirm;
    if (action === 'archive') {
      await archiveMutation.mutateAsync(workspace.id);
    } else {
      await deleteMutation.mutateAsync(workspace.id);
    }

    // Se tocamos o workspace ativo, decidimos pra onde ir:
    //   - tem outro ativo no DB → troca pra ele
    //   - vazio → limpa active e fecha Settings; o OnboardingGate detecta
    //     workspaces.length === 0 e abre o wizard pra criar um novo.
    if (active?.id === workspace.id) {
      const fresh = await window.orkestral['workspace:list']();
      if (fresh.length > 0) {
        const next = await window.orkestral['workspace:switch']({
          workspaceId: fresh[0].id,
        });
        setActive(next);
        setViewWs(next);
        window.location.hash = '#/';
      } else {
        setActive(null);
        setViewWs(null);
        onClose();
      }
    } else if (viewWs?.id === workspace.id) {
      // Arquivamos/excluímos o workspace em visualização (não-ativo): ele sumiu
      // da lista, então volta a visualização pro ativo.
      setViewWs(active);
    }
    setConfirm(null);
  }

  const archived = archivedQuery.data ?? [];

  return (
    <PanelShell icon={Briefcase} title={t('settings.workspace.title')}>
      {/* Seletor: escolhe qual workspace inspecionar/gerenciar sem trocar o ativo */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] text-text-muted">{t('settings.workspace.scopeLabel')}</span>
        <WorkspacePicker value={viewWs?.id} onChange={setViewWs} align="end" />
      </div>

      {viewWs ? (
        <>
          <Field
            label={t('settings.workspace.activeLabel')}
            description={t('settings.workspace.activeDescription')}
          >
            <WorkspaceCard workspace={viewWs} />
          </Field>

          {/* Autonomia é config GLOBAL do workspace (vive no orquestrador), por
              isso fica aqui em Configurações — não na config de cada agente. */}
          <WorkspaceAutonomy workspaceId={viewWs.id} />

          <Field
            label={t('settings.workspace.archiveLabel')}
            description={t('settings.workspace.archiveDescription')}
          >
            <Button
              variant="secondary"
              size="sm"
              className="w-fit gap-2"
              onClick={() => setConfirm({ workspace: viewWs, action: 'archive' })}
            >
              <Archive className="h-3.5 w-3.5" />
              {t('settings.workspace.archiveButton')}
            </Button>
          </Field>

          <Field
            label={t('settings.workspace.deleteLabel')}
            description={t('settings.workspace.deleteDescription')}
          >
            <Button
              variant="secondary"
              size="sm"
              className="w-fit gap-2 border-accent-red/40 text-accent-red hover:bg-accent-red/10"
              onClick={() => setConfirm({ workspace: viewWs, action: 'delete' })}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('settings.workspace.deleteButton')}
            </Button>
          </Field>
        </>
      ) : (
        <div className="text-[12.5px] text-text-muted">{t('settings.workspace.noneActive')}</div>
      )}

      {archived.length > 0 && (
        <Field
          label={t('settings.workspace.archivedLabel')}
          description={t('settings.workspace.archivedDescription')}
        >
          <div className="flex flex-col gap-2">
            {archived.map((ws) => (
              <ArchivedRow
                key={ws.id}
                workspace={ws}
                onUnarchive={() => unarchiveMutation.mutate(ws.id)}
                onDelete={() => setConfirm({ workspace: ws, action: 'delete' })}
              />
            ))}
          </div>
        </Field>
      )}

      {confirm && (
        <ConfirmDialog
          workspace={confirm.workspace}
          action={confirm.action}
          busy={archiveMutation.isPending || deleteMutation.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={handleConfirm}
        />
      )}
    </PanelShell>
  );
}

/**
 * Slider de autonomia do workspace. A autonomia é GLOBAL e vive no
 * `runtimeConfig.autonomyLevel` do agente orquestrador (CEO) — um por workspace.
 * Optimistic update no cache pra o slider responder na hora.
 */
function WorkspaceAutonomy({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: ['agents', workspaceId],
    queryFn: () => window.orkestral['agent:list']({ workspaceId }),
  });
  const orchestrator = (agentsQuery.data ?? []).find((a) => a.isOrchestrator) ?? null;
  const rc = (orchestrator?.runtimeConfig ?? {}) as { autonomyLevel?: AutonomyLevel };
  const level: AutonomyLevel = rc.autonomyLevel ?? 'medium';

  const mutation = useMutation({
    mutationFn: (next: AutonomyLevel) => {
      if (!orchestrator) throw new Error('no orchestrator');
      return window.orkestral['agent:update']({
        agentId: orchestrator.id,
        patch: {
          runtimeConfig: {
            ...(orchestrator.runtimeConfig ?? {}),
            autonomyLevel: next,
          } as Record<string, unknown>,
        },
      });
    },
    onMutate: (next) => {
      queryClient.setQueryData(['agents', workspaceId], (old: Agent[] | undefined) =>
        old?.map((a) =>
          a.id === orchestrator?.id
            ? { ...a, runtimeConfig: { ...(a.runtimeConfig ?? {}), autonomyLevel: next } }
            : a,
        ),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents', workspaceId] }),
  });

  if (!orchestrator) return null;
  return <AutonomySlider value={level} onChange={(v) => mutation.mutate(v)} />;
}

function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const { t } = useT();
  const planLabel =
    workspace.planMode === 'team'
      ? t('settings.workspace.planTeam')
      : t('settings.workspace.planLocal');
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-hairline bg-surface-faint p-4">
      {/* Cabeçalho: nome + org + plano */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-text-primary">
            {workspace.name}
          </div>
          {workspace.companyName && (
            <div className="mt-0.5 truncate text-[11.5px] text-text-secondary">
              {t('settings.workspace.organization', { name: workspace.companyName })}
            </div>
          )}
          <div className="mt-1 text-[10.5px] text-text-faint">
            {t('settings.workspace.createdAt', { date: formatDateTime(workspace.createdAt) })}
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-accent-purple/30 bg-accent-purple/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-purple">
          {planLabel}
        </span>
      </div>

      {/* Missão */}
      {workspace.mission && (
        <p className="text-[11.5px] leading-relaxed text-text-muted">{workspace.mission}</p>
      )}

      {/* Stats ao vivo */}
      <WorkspaceStats workspaceId={workspace.id} />

      {/* Sources do workspace */}
      <WorkspaceSourcesList workspaceId={workspace.id} fallback={workspace} />
    </div>
  );
}

/** Contadores ao vivo: agentes, sources, issues, páginas KB. */
function WorkspaceStats({ workspaceId }: { workspaceId: string }) {
  const { t } = useT();
  const agentsQuery = useQuery({
    queryKey: ['ws-stat-agents', workspaceId],
    queryFn: () => window.orkestral['agent:list']({ workspaceId }),
  });
  const sourcesQuery = useQuery({
    queryKey: ['ws-stat-sources', workspaceId],
    queryFn: () => window.orkestral['source:list']({ workspaceId }),
  });
  const issuesQuery = useQuery({
    queryKey: ['ws-stat-issues', workspaceId],
    queryFn: () => window.orkestral['issue:counts-by-status']({ workspaceId }),
  });
  const kbQuery = useQuery({
    queryKey: ['ws-stat-kb', workspaceId],
    queryFn: () => window.orkestral['kb:list-pages']({ workspaceId }),
  });

  const issueTotal = issuesQuery.data
    ? Object.values(issuesQuery.data).reduce((a, b) => a + b, 0)
    : null;

  const tiles: Array<{ label: string; value: number | null; loading: boolean }> = [
    {
      label: t('settings.workspace.statAgents'),
      value: agentsQuery.data?.length ?? null,
      loading: agentsQuery.isPending,
    },
    {
      label: t('settings.workspace.statSources'),
      value: sourcesQuery.data?.length ?? null,
      loading: sourcesQuery.isPending,
    },
    {
      label: t('settings.workspace.statIssues'),
      value: issueTotal,
      loading: issuesQuery.isPending,
    },
    {
      label: t('settings.workspace.statKbPages'),
      value: kbQuery.data?.length ?? null,
      loading: kbQuery.isPending,
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-2">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="flex flex-col items-center gap-0.5 rounded-md border border-hairline-faint bg-surface-veil px-2 py-2.5"
        >
          <span className="text-[16px] font-semibold tabular-nums text-text-primary">
            {t.loading ? '—' : (t.value ?? 0)}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-text-faint">{t.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Lista todos os sources do workspace com ícone + label + repo/path. */
function WorkspaceSourcesList({
  workspaceId,
  fallback,
}: {
  workspaceId: string;
  fallback: Workspace;
}) {
  const { t } = useT();
  const sourcesQuery = useQuery({
    queryKey: ['ws-sources', workspaceId],
    queryFn: () => window.orkestral['source:list']({ workspaceId }),
  });
  const sources = sourcesQuery.data ?? [];

  if (sourcesQuery.isPending) {
    return (
      <div className="text-[11px] text-text-faint">{t('settings.workspace.loadingSources')}</div>
    );
  }

  // Sem sources cadastrados → mostra o fallback do próprio workspace.
  if (sources.length === 0) {
    const Icon = fallback.provider === 'github' ? Github : fallback.path ? Folder : Laptop;
    const subline =
      fallback.provider === 'github' && fallback.gitRemote
        ? githubFullName(fallback.gitRemote)
        : (fallback.path ?? t('settings.workspace.noFolder'));
    return (
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-text-faint">
          {t('settings.workspace.sources')}
        </div>
        <SourceRow icon={Icon} label={fallback.name} subline={subline} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-text-faint">
        {t('settings.workspace.sources')}
      </div>
      <div className="flex flex-col gap-1.5">
        {sources.map((s) => (
          <SourceRow
            key={s.id}
            icon={s.kind === 'github_repo' ? Github : Folder}
            label={sourceLabel(s, t('settings.workspace.sourceFallback'))}
            subline={s.repoFullName ?? s.path ?? t('settings.workspace.noPath')}
            role={s.role}
            primary={s.isPrimary}
          />
        ))}
      </div>
    </div>
  );
}

function SourceRow({
  icon: Icon,
  label,
  subline,
  role,
  primary,
}: {
  icon: typeof Github;
  label: string;
  subline: string;
  role?: WorkspaceSource['role'];
  primary?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-hairline-soft bg-surface-veil px-2.5 py-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] text-text-primary">{label}</span>
          {primary && (
            <span className="shrink-0 rounded bg-surface-active px-1 py-px text-[8.5px] uppercase tracking-wide text-text-muted">
              {t('settings.workspace.primary')}
            </span>
          )}
          {role && (
            <span className="shrink-0 rounded bg-surface-active px-1 py-px text-[8.5px] uppercase tracking-wide text-text-muted">
              {role}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[10px] text-text-faint">{subline}</div>
      </div>
    </div>
  );
}

function sourceLabel(s: WorkspaceSource, fallback: string): string {
  if (s.label) return s.label;
  if (s.repoFullName) return s.repoFullName;
  if (s.path) return s.path.split('/').pop() ?? s.path;
  return fallback;
}

function ArchivedRow({
  workspace,
  onUnarchive,
  onDelete,
}: {
  workspace: Workspace;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-3 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-text-primary">{workspace.name}</div>
        <div className="truncate text-[10.5px] text-text-faint">
          {t('settings.workspace.archivedAt', { date: fmtDate(workspace.archivedAt) })}
        </div>
      </div>
      <Button variant="secondary" size="sm" className="gap-1.5" onClick={onUnarchive}>
        <ArchiveRestore className="h-3 w-3" />
        {t('settings.workspace.restore')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className="gap-1.5 border-accent-red/40 text-accent-red hover:bg-accent-red/10"
        onClick={onDelete}
      >
        <Trash2 className="h-3 w-3" />
        {t('settings.workspace.delete')}
      </Button>
    </div>
  );
}

function ConfirmDialog({
  workspace,
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  workspace: Workspace;
  action: 'archive' | 'delete';
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  const isDelete = action === 'delete';
  return createPortal(
    <div
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: 99999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          WebkitAppRegion: 'no-drag',
        } as CSSProperties
      }
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-dialog"
        style={
          {
            position: 'relative',
            zIndex: 100000,
            pointerEvents: 'auto',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12,
            padding: 24,
            width: '100%',
            maxWidth: 440,
            boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            WebkitAppRegion: 'no-drag',
          } as CSSProperties
        }
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
              isDelete ? 'bg-accent-red/10' : 'bg-surface-2',
            )}
          >
            {isDelete ? (
              <Trash2 className="h-4 w-4 text-accent-red" />
            ) : (
              <Archive className="h-4 w-4 text-text-primary" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold tracking-tight">
              {isDelete
                ? t('settings.workspace.confirmDeleteTitle')
                : t('settings.workspace.confirmArchiveTitle')}
            </div>
            <div className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">
              {isDelete ? (
                <>
                  {t('settings.workspace.confirmDeleteBodyPrefix')}{' '}
                  <strong>{t('settings.workspace.confirmDeletePermanent')}</strong>
                  {t('settings.workspace.confirmDeleteBodyMid')}{' '}
                  <span className="font-mono text-text-primary">"{workspace.name}"</span>
                  {t('settings.workspace.confirmDeleteBodySuffix')}
                </>
              ) : (
                <>
                  {t('settings.workspace.confirmArchiveBodyPrefix')}{' '}
                  <span className="font-mono text-text-primary">"{workspace.name}"</span>{' '}
                  {t('settings.workspace.confirmArchiveBodySuffix')}
                </>
              )}
            </div>
            {isDelete && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t('settings.workspace.confirmDeleteWarning')}</span>
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            className={cn(isDelete && 'bg-accent-red text-white hover:bg-accent-red/90')}
          >
            {busy
              ? t('settings.workspace.processing')
              : isDelete
                ? t('settings.workspace.confirmDeleteAction')
                : t('settings.workspace.confirmArchiveAction')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function githubFullName(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
  } catch {
    return url;
  }
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: ['workspaces'] });
  qc.invalidateQueries({ queryKey: ['workspaces', 'archived'] });
  qc.invalidateQueries({ queryKey: ['sessions'] });
  qc.invalidateQueries({ queryKey: ['agents'] });
}
