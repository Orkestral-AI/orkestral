import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Code2,
  Globe2,
  Loader2,
  Play,
  Square,
  X,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { Agent, ExecutionCheckbox, Issue, IssueRun, WorkspaceSource } from '@shared/types';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { progressStateForIssue } from '@shared/session-progress-ui';
import type { LiveExecEvent } from '@renderer/stores/executionStore';
import { PreviewPanel } from '@renderer/components/code-ide/PreviewPanel';
import { WorkspaceTree } from '@renderer/components/code-ide/WorkspaceTree';
import { SourceCodeInner } from '@renderer/pages/SourceCodePage';
import { usePreviewStore } from '@renderer/stores/previewStore';
import { useT } from '@renderer/i18n';

export type WorkspaceTab = 'preview' | 'code' | 'issues';

interface SessionWorkspaceProps {
  workspaceId: string;
  issues: Issue[];
  prefix: string;
  executionByIssue: Record<string, LiveExecEvent[]>;
  latestRunsByIssue: Record<string, IssueRun | null>;
  agents: Agent[];
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  onClose: () => void;
}

/** Ordena as issues do chat: épica primeiro, depois filhas por issueKey crescente. */
function sortChatIssues<T extends { issue: Issue }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aEpic = a.issue.parentIssueId === null ? 0 : 1;
    const bEpic = b.issue.parentIssueId === null ? 0 : 1;
    if (aEpic !== bEpic) return aEpic - bEpic;
    return a.issue.issueKey - b.issue.issueKey;
  });
}

/**
 * Painel WORKSPACE da sessão (estilo Lovable): abre ao lado do chat com as abas
 * Preview (webview do dev server gerenciado), Código (árvore + editor da IDE) e
 * Issues (KPIs + issues deste chat). Substitui os antigos cards laterais de
 * Progresso/Atividade/Arquivos. Reusa os componentes da IDE de Fontes — o
 * PreviewPanel traz de graça o seletor de componente, device toggles e reload.
 */
export function SessionWorkspace({
  workspaceId,
  issues,
  prefix,
  executionByIssue,
  latestRunsByIssue,
  agents,
  tab,
  onTabChange,
  onClose,
}: SessionWorkspaceProps) {
  const { t } = useT();
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ['preview:status', workspaceId],
    queryFn: () => window.orkestral['preview:status']({ workspaceId }),
    refetchOnWindowFocus: true,
  });
  const status = statusQuery.data;
  const running = status?.running ?? false;
  // Projeto NASCENDO neste chat (tem issues e nenhuma entregue): o scaffold cria
  // o package.json cedo e `runnable` liga no meio do parto — a aba Preview
  // aparecia antes de existir qualquer entrega ("liberou sem ver"). Segura a aba
  // até a primeira issue concluída; server já rodando ou repo maduro (sem issues
  // no chat) não mudam.
  const projectBeingBorn = issues.length > 0 && !issues.some((i) => i.status === 'done');
  const previewAvailable = running || ((status?.runnable ?? false) && !projectBeingBorn);

  useEffect(() => {
    const ev = (
      window as unknown as {
        orkestralEvents?: {
          onPreviewChanged?: (l: (e: { workspaceId: string }) => void) => () => void;
        };
      }
    ).orkestralEvents;
    const off = ev?.onPreviewChanged?.((e) => {
      if (e.workspaceId === workspaceId) {
        void queryClient.invalidateQueries({ queryKey: ['preview:status', workspaceId] });
      }
    });
    return off;
  }, [workspaceId, queryClient]);

  const sourcesQuery = useQuery<WorkspaceSource[]>({
    queryKey: ['sources', workspaceId],
    queryFn: () => window.orkestral['source:list']({ workspaceId }),
  });
  const primary = useMemo(() => {
    const sources = sourcesQuery.data ?? [];
    return sources.find((s) => s.isPrimary && s.path) ?? sources.find((s) => s.path) ?? null;
  }, [sourcesQuery.data]);

  // O dev server GERENCIADO (preview:start) é uma URL detectada como outra qualquer:
  // publica no previewStore pro PreviewPanel (o mesmo da IDE de Fontes) renderizar.
  const setDetected = usePreviewStore((s) => s.setDetected);
  useEffect(() => {
    if (running && status?.url && primary) setDetected(primary.id, status.url);
  }, [running, status?.url, primary, setDetected]);

  const startMut = useMutation({
    mutationFn: () => window.orkestral['preview:start']({ workspaceId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['preview:status', workspaceId] }),
  });
  const stopMut = useMutation({
    mutationFn: () => window.orkestral['preview:stop']({ workspaceId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['preview:status', workspaceId] }),
  });

  // Aba Preview some quando o projeto não tem o que mostrar (ex.: backend puro).
  const effectiveTab: WorkspaceTab = tab === 'preview' && !previewAvailable ? 'issues' : tab;

  // Quando o preview LIBERA (scaffold pronto), muda pra aba Preview UMA vez —
  // o momento "Lovable" de ver a tela nascer. Depois o usuário navega livre.
  const autoSwitched = useRef(false);
  useEffect(() => {
    if (!previewAvailable || autoSwitched.current) return;
    autoSwitched.current = true;
    onTabChange('preview');
  }, [previewAvailable, onTabChange]);

  const issueStates = useMemo(
    () =>
      issues.map((issue) => ({
        issue,
        state: progressStateForIssue(
          issue,
          executionByIssue[issue.id] ?? [],
          latestRunsByIssue[issue.id] ?? null,
        ),
      })),
    [issues, executionByIssue, latestRunsByIssue],
  );
  const openIssues = sortChatIssues(
    issueStates.filter(({ state }) => !state.done && !state.cancelled),
  );
  const doneIssues = sortChatIssues(
    issueStates.filter(({ state }) => state.done || state.cancelled),
  );
  const kpiRunning = issueStates.filter(({ state }) => state.running).length;
  const kpiReview = issueStates.filter(({ state }) => state.reviewing).length;
  const kpiDone = doneIssues.length;

  const tabs: { id: WorkspaceTab; label: string; icon: typeof Globe2; badge?: number }[] = [
    ...(previewAvailable
      ? [{ id: 'preview' as const, label: t('chat.workspace.tabPreview'), icon: Globe2 }]
      : []),
    { id: 'code' as const, label: t('chat.workspace.tabCode'), icon: Code2 },
    {
      id: 'issues' as const,
      label: t('chat.workspace.tabIssues'),
      icon: ClipboardList,
      badge: issues.length || undefined,
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* barra do workspace: abas segmentadas + ações */}
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
          {tabs.map(({ id, label, icon: Icon, badge }) => (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                effectiveTab === id
                  ? 'bg-surface-elevated text-text-primary'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
              {badge != null && (
                <span className="rounded-md bg-accent/15 px-1.5 text-[10px] font-semibold text-accent">
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {effectiveTab === 'preview' && running && (
          <button
            type="button"
            onClick={() => stopMut.mutate()}
            title={t('chat.preview.stop')}
            aria-label={t('chat.preview.stop')}
            className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:text-accent-red"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title={t('chat.workspace.close')}
          aria-label={t('chat.workspace.close')}
          className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {/* PREVIEW — webview do dev server gerenciado, via PreviewPanel da IDE */}
        {effectiveTab === 'preview' && (
          <div className="flex h-full min-h-0 flex-col px-2 pb-2">
            {running && primary ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
                <PreviewPanel sourceId={primary.id} sourceRoot={primary.path ?? undefined} />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => startMut.mutate()}
                disabled={startMut.isPending || !status?.runnable}
                className="group relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-border bg-surface"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-accent/10 via-surface to-surface-elevated" />
                <span className="relative grid h-14 w-14 place-items-center rounded-full bg-accent text-white shadow-lg transition-transform group-hover:scale-110">
                  {startMut.isPending ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : (
                    <Play className="ml-0.5 h-6 w-6 fill-current" />
                  )}
                </span>
                <span
                  className={cn(
                    'relative px-6 text-center text-[12.5px] font-medium',
                    startMut.data && !startMut.data.running
                      ? 'text-accent-red'
                      : 'text-text-secondary',
                  )}
                >
                  {startMut.isPending
                    ? t('chat.preview.starting')
                    : startMut.data && !startMut.data.running
                      ? (startMut.data.reason ?? t('chat.preview.start'))
                      : t('chat.preview.start')}
                </span>
              </button>
            )}
          </div>
        )}

        {/* CÓDIGO — árvore + editor da IDE de Fontes, no mesmo card do preview */}
        {effectiveTab === 'code' && (
          <div className="flex h-full min-h-0 flex-col px-2 pb-2">
            <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-surface">
              <aside className="flex w-[230px] shrink-0 flex-col overflow-y-auto border-r border-border">
                <WorkspaceTree workspaceId={workspaceId} />
              </aside>
              {primary?.path ? (
                <SourceCodeInner focusedSourceId={primary.id} focusedSourceRoot={primary.path} />
              ) : (
                <div className="grid flex-1 place-items-center text-[12.5px] text-text-muted">
                  {t('chat.workspace.noLocalSource')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ISSUES — KPIs + issues deste chat, no mesmo card do preview */}
        {effectiveTab === 'issues' && (
          <div className="flex h-full min-h-0 flex-col px-2 pb-2">
            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface p-3">
              <div className="mb-3 grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-border bg-surface-elevated px-3 py-2.5">
                  <div className="text-[19px] font-bold text-accent">{kpiRunning}</div>
                  <div className="text-[11px] text-text-muted">
                    {t('chat.workspace.inExecution')}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-surface-elevated px-3 py-2.5">
                  <div className="text-[19px] font-bold text-text-primary">{kpiReview}</div>
                  <div className="text-[11px] text-text-muted">{t('chat.workspace.inReview')}</div>
                </div>
                <div className="rounded-xl border border-border bg-surface-elevated px-3 py-2.5">
                  <div className="text-[19px] font-bold text-accent-green">{kpiDone}</div>
                  <div className="text-[11px] text-text-muted">{t('chat.workspace.completed')}</div>
                </div>
              </div>

              {openIssues.length > 0 && (
                <>
                  <SectionLabel label={t('chat.workspace.issuesOfChat')} />
                  {openIssues.map(({ issue, state }) => (
                    <IssueRow
                      key={issue.id}
                      issue={issue}
                      state={state}
                      prefix={prefix}
                      agents={agents}
                    />
                  ))}
                </>
              )}

              {doneIssues.length > 0 && (
                <>
                  <SectionLabel label={t('chat.workspace.completedSection')} />
                  {doneIssues.map(({ issue, state }) => (
                    <IssueRow
                      key={issue.id}
                      issue={issue}
                      state={state}
                      prefix={prefix}
                      agents={agents}
                    />
                  ))}
                </>
              )}

              {issues.length === 0 && (
                <div className="px-1 text-[12px] text-text-muted">
                  {t('chat.workspace.noOpenIssues')}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="mb-2.5 mt-1.5 flex items-center gap-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-faint">
      {label}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function IssueRow({
  issue,
  state,
  prefix,
  agents,
}: {
  issue: Issue;
  state: ReturnType<typeof progressStateForIssue>;
  prefix: string;
  agents: Agent[];
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const assignee = agents.find((a) => a.id === issue.assigneeAgentId) ?? null;
  const meta = issue.metadata as {
    kind?: string;
    checkboxes?: ExecutionCheckbox[];
    done?: string;
  } | null;
  const checkboxes = meta?.kind === 'execution-plan' ? (meta.checkboxes ?? []) : [];
  const statusLabel = state.done
    ? t('chat.progressRow.done')
    : state.cancelled
      ? t('chat.progressRow.cancelled')
      : state.reviewing
        ? t('chat.progressRow.review')
        : state.running
          ? t('chat.progressRow.running')
          : state.queued
            ? t('chat.progressRow.queued')
            : issue.status === 'blocked'
              ? t('chat.progressRow.blocked')
              : t('chat.progressRow.pending');

  return (
    <div
      className={cn(
        'mb-1.5 rounded-xl border border-border bg-surface-elevated transition-colors',
        expanded ? 'border-border-strong' : 'hover:border-border-strong',
      )}
    >
      {/* Expande NO LUGAR — o acompanhamento fica todo aqui, sem navegar pra issue. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        {state.done ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-accent-green" />
        ) : state.running ? (
          <span className="relative grid h-4 w-4 shrink-0 place-items-center">
            <span className="absolute h-4 w-4 rounded-full border-[1.7px] border-accent" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          </span>
        ) : (
          <span
            className={cn(
              'h-4 w-4 shrink-0 rounded-full border-[1.7px]',
              state.reviewing ? 'border-accent' : 'border-accent-yellow',
            )}
          />
        )}
        <span className="shrink-0 font-mono text-[11px] text-text-faint">
          {prefix}-{issue.issueKey}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{issue.title}</span>
        {assignee && (
          <span title={assignee.name} className="shrink-0">
            <AgentAvatar seed={assignee.avatarSeed} name={assignee.name} size={20} />
          </span>
        )}
        <span
          className={cn(
            'shrink-0 rounded-full border border-border bg-surface px-2.5 py-0.5 text-[10px]',
            state.done
              ? 'text-accent-green'
              : state.running || state.reviewing
                ? 'border-accent/30 text-accent'
                : 'text-text-muted',
          )}
        >
          {statusLabel}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-text-faint transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-border px-3 pb-3 pt-2.5">
          {issue.description && (
            <p className="mb-2.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-text-secondary">
              {issue.description}
            </p>
          )}
          {checkboxes.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {checkboxes.map((cb) => (
                <div key={cb.id} className="flex items-start gap-2">
                  {cb.status === 'done' ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-green" />
                  ) : (
                    <span
                      className={cn(
                        'mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px]',
                        cb.status === 'blocked' ? 'border-accent-red' : 'border-border-strong',
                      )}
                    />
                  )}
                  <span
                    className={cn(
                      'text-[12px] leading-snug',
                      cb.status === 'done' ? 'text-text-muted line-through' : 'text-text-secondary',
                    )}
                  >
                    {cb.instruction}
                  </span>
                </div>
              ))}
            </div>
          )}
          {!issue.description && checkboxes.length === 0 && (
            <p className="text-[12px] text-text-muted">{t('chat.workspace.noDetails')}</p>
          )}
        </div>
      )}
    </div>
  );
}
