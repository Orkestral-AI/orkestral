import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Workspace } from '@shared/types';
import {
  AlertTriangle,
  Download,
  FolderOpen,
  Eraser,
  Database,
  Bot,
  MessageSquare,
  MessagesSquare,
  CircleDot,
  FileText,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { PanelShell, Field, SettingsSection, ToggleRow } from './PanelShell';
import { WorkspacePicker } from '@renderer/components/workspace/WorkspacePicker';
import { useToastStore } from '@renderer/stores/toastStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT } from '@renderer/i18n';

/** Formata bytes em unidade legível (B/KB/MB/GB). */
function humanBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

interface StatTileData {
  label: string;
  value: string;
  icon: LucideIcon;
}

function StatTile({ label, value, icon: Icon }: StatTileData) {
  return (
    <div className="rounded-lg border border-border bg-surface/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-text-faint">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-[16px] font-semibold tabular-nums text-text-primary">{value}</div>
    </div>
  );
}

/** Grade de tiles; mostra esqueletos enquanto as stats carregam. */
function StatGrid({
  tiles,
  loading,
  skeletons,
}: {
  tiles: StatTileData[];
  loading: boolean;
  skeletons: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {loading
        ? Array.from({ length: skeletons }).map((_, i) => (
            <div
              key={i}
              className="h-[58px] animate-pulse rounded-lg border border-border bg-surface/40"
            />
          ))
        : tiles.map((tile) => <StatTile key={tile.label} {...tile} />)}
    </div>
  );
}

export function DataPanel() {
  const { t } = useT();
  const pushToast = useToastStore((s) => s.push);
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [runningCleanup, setRunningCleanup] = useState(false);
  const [cancellingEmbeddingJob, setCancellingEmbeddingJob] = useState(false);

  // Workspace em visualização: inicia no ativo, mas o usuário pode trocar pelo
  // WorkspacePicker sem sair das configurações. Todas as contagens/ações desta
  // tela seguem este workspace (não mexe no workspace ativo global).
  const [viewWs, setViewWs] = useState<Workspace | null>(activeWorkspace);
  useEffect(() => {
    if (!viewWs && activeWorkspace) setViewWs(activeWorkspace);
  }, [activeWorkspace, viewWs]);
  const viewWsId = viewWs?.id;

  const statsQuery = useQuery({
    queryKey: ['data-stats', viewWsId],
    queryFn: () => window.orkestral['data:stats']({ workspaceId: viewWsId }),
  });
  const stats = statsQuery.data;

  const cleanupQuery = useQuery({
    queryKey: ['data-cleanup-preview', viewWsId],
    queryFn: () => window.orkestral['data:cleanup-preview']({ workspaceId: viewWs!.id }),
    enabled: !!viewWs,
  });
  const cleanup = cleanupQuery.data;
  const embeddingJobsQuery = useQuery({
    queryKey: ['kb-embedding-status', viewWsId],
    queryFn: () => window.orkestral['kb:embedding-status']({ workspaceId: viewWs!.id }),
    enabled: !!viewWs,
  });
  const latestEmbeddingJob = embeddingJobsQuery.data?.[0] ?? null;

  const workspaceTiles: StatTileData[] = stats
    ? [
        { label: t('settings.data.tileAgents'), value: String(stats.counts.agents), icon: Bot },
        {
          label: t('settings.data.tileSessions'),
          value: String(stats.counts.sessions),
          icon: MessageSquare,
        },
        {
          label: t('settings.data.tileMessages'),
          value: String(stats.counts.messages),
          icon: MessagesSquare,
        },
        {
          label: t('settings.data.tileIssues'),
          value: String(stats.counts.issues),
          icon: CircleDot,
        },
      ]
    : [];

  const knowledgeTiles: StatTileData[] = stats
    ? [
        {
          label: t('settings.data.tileKbPages'),
          value: String(stats.counts.kbPages),
          icon: FileText,
        },
        {
          label: t('settings.data.tileKbChunks'),
          value: String(stats.counts.kbChunks),
          icon: Database,
        },
        {
          label: t('settings.data.tileKbEmbeddings'),
          value: String(stats.counts.kbEmbeddings),
          icon: Search,
        },
        {
          label: t('settings.data.tileTraceEvents'),
          value: String(stats.counts.agentTraceEvents),
          icon: Sparkles,
        },
      ]
    : [];

  async function doExport() {
    setExporting(true);
    try {
      const res = await window.orkestral['data:export']();
      if (res.ok) {
        const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
        pushToast({
          title: t('settings.data.exportSuccessTitle'),
          description: t('settings.data.exportSuccessDescription', { total, path: res.path }),
          tone: 'success',
        });
      }
      // cancelado -> silencio
    } catch (err) {
      pushToast({
        title: t('settings.data.exportFailTitle'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setExporting(false);
    }
  }

  async function doReveal() {
    setRevealing(true);
    try {
      await window.orkestral['data:reveal']();
    } catch (err) {
      pushToast({
        title: t('settings.data.revealFailTitle'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setRevealing(false);
    }
  }

  async function doClearCache() {
    setClearing(true);
    try {
      await window.orkestral['data:clear-cache']();
      pushToast({ title: t('settings.data.cacheClearedTitle'), tone: 'success' });
    } catch (err) {
      pushToast({
        title: t('settings.data.clearCacheFailTitle'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setClearing(false);
    }
  }

  async function doCleanup() {
    if (!viewWs || !cleanup || cleanup.suggestions.length === 0) return;
    setRunningCleanup(true);
    try {
      const res = await window.orkestral['data:cleanup-run']({
        workspaceId: viewWs.id,
        suggestionIds: cleanup.suggestions.map((s) => s.id),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['data-stats'] }),
        queryClient.invalidateQueries({ queryKey: ['data-cleanup-preview', viewWs.id] }),
        queryClient.invalidateQueries({ queryKey: ['kb-tree'] }),
        queryClient.invalidateQueries({ queryKey: ['kb-graph'] }),
        queryClient.invalidateQueries({ queryKey: ['logs'] }),
      ]);
      pushToast({
        title: t('settings.data.cleanupSuccessTitle'),
        description: t('settings.data.cleanupSuccessDescription', {
          rows: res.deletedRows,
          bytes: humanBytes(res.reclaimedBytesEstimate),
        }),
        tone: 'success',
      });
    } catch (err) {
      pushToast({
        title: t('settings.data.cleanupFailTitle'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setRunningCleanup(false);
      setConfirmCleanup(false);
    }
  }

  async function cancelEmbeddingJob() {
    if (!latestEmbeddingJob) return;
    setCancellingEmbeddingJob(true);
    try {
      const res = await window.orkestral['kb:cancel-embedding-job']({
        jobId: latestEmbeddingJob.id,
      });
      if (res.cancelled) {
        pushToast({ title: t('settings.data.embeddingCancelSuccess'), tone: 'success' });
      }
      if (viewWs) {
        await queryClient.invalidateQueries({
          queryKey: ['kb-embedding-status', viewWs.id],
        });
      }
    } catch (err) {
      pushToast({
        title: t('settings.data.embeddingCancelFail'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setCancellingEmbeddingJob(false);
    }
  }

  return (
    <PanelShell
      icon={Database}
      title={t('settings.data.title')}
      description={t('settings.data.description')}
    >
      {/* Hero de armazenamento: métrica-chave + caminho do banco */}
      <div className="rounded-xl border border-border bg-surface/40 p-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-accent-purple/25 bg-accent-purple/15">
            <Database className="h-5 w-5 text-accent-purple" />
          </div>
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-wide text-text-faint">
              {t('settings.data.tileDbSize')}
            </div>
            <div className="text-[22px] font-semibold leading-tight tabular-nums text-text-primary">
              {stats ? humanBytes(stats.dbSizeBytes) : '—'}
            </div>
          </div>
        </div>
        {stats && (
          <div
            className="mt-3 truncate font-mono text-[10.5px] text-text-faint"
            title={stats.dbPath}
          >
            {stats.dbPath}
          </div>
        )}
      </div>

      {/* Seletor de workspace: filtra as contagens sem sair das configurações */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] text-text-muted">{t('settings.data.scopeLabel')}</span>
        <WorkspacePicker value={viewWsId} onChange={setViewWs} align="end" />
      </div>

      {/* Contagens do workspace selecionado */}
      <SettingsSection title={viewWs?.name ?? t('settings.data.groupWorkspace')}>
        <StatGrid tiles={workspaceTiles} loading={statsQuery.isLoading} skeletons={4} />
      </SettingsSection>

      {/* Contagens da base de conhecimento */}
      <SettingsSection title={t('settings.data.groupKnowledge')}>
        <StatGrid tiles={knowledgeTiles} loading={statsQuery.isLoading} skeletons={4} />
      </SettingsSection>

      {latestEmbeddingJob && (
        <div className="rounded-lg border border-border bg-surface/35 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-text-faint">
                <Sparkles className="h-3 w-3" />
                {t('settings.data.embeddingJobLabel')}
              </div>
              <div className="mt-1 truncate text-[12.5px] text-text-secondary">
                {t(`settings.data.embeddingJobStatus.${latestEmbeddingJob.status}`)}
              </div>
            </div>
            <div className="shrink-0 text-right text-[12px] tabular-nums text-text-muted">
              {latestEmbeddingJob.current}/{latestEmbeddingJob.total}
            </div>
            {(latestEmbeddingJob.status === 'queued' ||
              latestEmbeddingJob.status === 'running') && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                title={t('settings.data.embeddingCancel')}
                onClick={cancelEmbeddingJob}
                disabled={cancellingEmbeddingJob}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}

      <Field
        label={t('settings.data.cleanupLabel')}
        description={
          viewWs
            ? cleanup && cleanup.suggestions.length > 0
              ? t('settings.data.cleanupDescription', {
                  items: cleanup.totalItems,
                  bytes: humanBytes(cleanup.totalBytes),
                })
              : t('settings.data.cleanupEmpty')
            : t('settings.data.cleanupNoWorkspace')
        }
      >
        <div className="flex w-full flex-col gap-2">
          {cleanup && cleanup.suggestions.length > 0 && (
            <div className="grid gap-2">
              {cleanup.suggestions.map((suggestion) => (
                <div
                  key={suggestion.id}
                  className="rounded-lg border border-border bg-surface/35 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-semibold text-text-primary">
                        {suggestion.title}
                      </div>
                      <div className="mt-0.5 text-[11.5px] leading-snug text-text-muted">
                        {suggestion.summary}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[11px] tabular-nums text-text-faint">
                      <div>{suggestion.itemCount}</div>
                      <div>{humanBytes(suggestion.estimatedBytes)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!confirmCleanup ? (
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              onClick={() => setConfirmCleanup(true)}
              disabled={!viewWs || !cleanup || cleanup.suggestions.length === 0}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('settings.data.cleanupButton')}
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-accent-red" />
              <span className="text-[12px] text-text-secondary">
                {t('settings.data.cleanupConfirmPrompt')}
              </span>
              <Button variant="destructive" size="sm" onClick={doCleanup} disabled={runningCleanup}>
                {runningCleanup ? t('settings.data.cleaning') : t('common.confirm')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmCleanup(false)}
                disabled={runningCleanup}
              >
                {t('common.cancel')}
              </Button>
            </div>
          )}
        </div>
      </Field>

      <SettingsSection
        title={t('settings.data.maintenanceTitle')}
        description={t('settings.data.maintenanceDescription')}
      >
        <ToggleRow
          label={t('settings.data.exportLabel')}
          description={t('settings.data.exportDescription')}
          right={
            <Button variant="secondary" size="sm" onClick={doExport} disabled={exporting}>
              <Download className="h-3.5 w-3.5" />
              {exporting ? t('settings.data.exporting') : t('settings.data.exportToJson')}
            </Button>
          }
        />
        <ToggleRow
          label={t('settings.data.revealLabel')}
          description={t('settings.data.revealDescription')}
          right={
            <Button variant="secondary" size="sm" onClick={doReveal} disabled={revealing}>
              <FolderOpen className="h-3.5 w-3.5" />
              {t('settings.data.openFolder')}
            </Button>
          }
        />
        <ToggleRow
          label={t('settings.data.clearCacheLabel')}
          description={t('settings.data.clearCacheDescription')}
          right={
            <Button variant="secondary" size="sm" onClick={doClearCache} disabled={clearing}>
              <Eraser className="h-3.5 w-3.5" />
              {clearing ? t('settings.data.clearing') : t('settings.data.clearCache')}
            </Button>
          }
        />
      </SettingsSection>
    </PanelShell>
  );
}
