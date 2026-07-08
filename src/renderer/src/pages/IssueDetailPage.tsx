import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Play,
  X,
  Loader2,
  Send,
  MessageSquare,
  Activity as ActivityIcon,
  Link2,
  Plus,
  Trash2,
  MoreHorizontal,
  CircleDot,
  CircleDashed,
  Target,
  Circle,
  CircleCheck,
  CircleSlash,
  CircleAlert,
  CircleMinus,
  Brain,
  AlertTriangle,
  RotateCw,
  ListChecks,
  Check,
  PencilLine,
  SignalLow,
  SignalMedium,
  SignalHigh,
  ChevronRight,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  PiggyBank,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT, type TFunction } from '@renderer/i18n';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useIssueReadStore } from '@renderer/stores/issueReadStore';
import { useExecutionStore, type LiveExecEvent } from '@renderer/stores/executionStore';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { ComboSelect } from '@renderer/components/ui/combo-select';
import { IssueTasks } from '@renderer/components/issues/IssueTasks';
import { EscalationCard, parseEscalation } from '@renderer/components/issues/EscalationCard';
import type {
  Issue,
  IssueComment,
  IssuePriority,
  IssueRun,
  IssueStatus,
  IssueVerificationState,
  QaValidation,
  Agent,
  AgentTraceEvent,
} from '@shared/types';
import { BRANDING } from '@shared/branding';
import { ProviderIcon, providerLabel } from '@renderer/components/ProviderIcon';
import { readPlanState } from '@shared/plan';
import { deriveIssueExecutionUiState } from '@shared/issue-execution-ui';
import { useIssueWorking } from '@renderer/stores/agentStatusStore';
import { Markdown } from '@renderer/components/ui/markdown';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { toast } from '@renderer/stores/toastStore';
import { formatDateTime, formatTimeWithSeconds } from '@renderer/lib/time';
import {
  useStagedAttachments,
  AttachButton,
  StagedChips,
  AttachmentChips,
} from '@renderer/components/ui/attachments';

type Tab = 'chat' | 'activity' | 'related';

const STATUS_META: Record<
  IssueStatus,
  { Icon: typeof CircleDot; color: string; chipClass: string }
> = {
  backlog: {
    Icon: CircleDashed,
    color: 'text-text-muted',
    chipClass: 'border-hairline-strong text-text-secondary',
  },
  todo: {
    Icon: Circle,
    color: 'text-text-secondary',
    chipClass: 'border-hairline-heavy text-text-primary',
  },
  in_progress: {
    Icon: CircleDot,
    color: 'text-accent-blue',
    chipClass: 'border-accent-blue/30 text-accent-blue',
  },
  in_review: {
    Icon: CircleAlert,
    color: 'text-accent-yellow',
    chipClass: 'border-accent-yellow/30 text-accent-yellow',
  },
  blocked: {
    Icon: CircleSlash,
    color: 'text-accent-red',
    chipClass: 'border-accent-red/30 text-accent-red',
  },
  done: {
    Icon: CircleCheck,
    color: 'text-accent-green',
    chipClass: 'border-accent-green/30 text-accent-green',
  },
  cancelled: {
    Icon: CircleMinus,
    color: 'text-text-faint',
    chipClass: 'border-hairline text-text-faint',
  },
};
const PRIORITY_META: Record<IssuePriority, { color: string; Icon: typeof CircleDot }> = {
  low: { color: 'text-text-faint', Icon: SignalLow },
  medium: { color: 'text-text-secondary', Icon: SignalMedium },
  high: { color: 'text-accent-yellow', Icon: SignalHigh },
  critical: { color: 'text-accent-red', Icon: CircleAlert },
};

/** Label de status (variante "detalhe") traduzida. */
const statusLabel = (t: TFunction, s: IssueStatus): string => t(`issues.statusDetail.${s}`);
/** Label de prioridade traduzida. */
const priorityLabel = (t: TFunction, p: IssuePriority): string => t(`issues.priority.${p}`);

/**
 * Card de aprovação do plano. Renderizado no topo da épica (qualquer issue com
 * sub-issues). Estados:
 *   - pendente → lista as etapas + Aprovar/Pedir ajustes
 *   - aprovado → selo verde compacto
 *   - changes_requested → faixa âmbar com a observação + reabrir
 * "Aprovar" libera as sub-issues e dispara execução (backend issue:decide-plan).
 */
function PlanApprovalCard({
  epic,
  childIssues,
  agents,
  prefix,
}: {
  epic: Issue;
  childIssues: Issue[];
  agents: Agent[];
  prefix: string;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [askMode, setAskMode] = useState<'changes' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const att = useStagedAttachments();
  const plan = readPlanState(epic);
  const status = plan?.status ?? 'pending';
  // Ref de display da épica (top-level) — base p/ numerar as etapas (EZC-6.1…).
  const epicRef = `${prefix}-${epic.displayKey ?? epic.issueKey}`;

  const decideMut = useMutation({
    mutationFn: (input: { decision: 'approve' | 'request_changes' | 'reject'; note?: string }) =>
      window.orkestral['issue:decide-plan']({
        epicIssueId: epic.id,
        decision: input.decision,
        note: input.note,
        attachments: att.items,
      }),
    onSuccess: (res, vars) => {
      setAskMode(null);
      setNote('');
      att.clear();
      queryClient.invalidateQueries({ queryKey: ['issue-by-key'] });
      queryClient.invalidateQueries({ queryKey: ['issue-children'] });
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      queryClient.invalidateQueries({ queryKey: ['issue-comments'] });
      if (vars.decision === 'approve') {
        toast.success(
          t('issues.plan.toastApprovedTitle'),
          res.executed > 0
            ? t('issues.plan.toastApprovedExecuted', { n: res.executed })
            : t('issues.plan.toastApprovedReleased'),
        );
      } else if (vars.decision === 'reject') {
        toast.success(
          t('issues.plan.toastRejectedTitle'),
          t('issues.plan.toastRejectedBody', { n: res.cancelled }),
        );
      } else {
        toast.info(t('issues.plan.toastChangesTitle'), t('issues.plan.toastChangesBody'));
      }
    },
    onError: (e) =>
      toast.error(t('issues.plan.toastDecideFailed'), e instanceof Error ? e.message : undefined),
  });
  const busy = decideMut.isPending;

  const total = childIssues.length;
  const doneCount = childIssues.filter(
    (c) => c.status === 'done' || c.status === 'in_review',
  ).length;

  // ---- Estado: aprovado ----
  if (status === 'approved') {
    return (
      <div className="mt-6 flex items-center gap-3 rounded-xl border border-accent-green/25 bg-accent-green/[0.06] px-4 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-green/15">
          <Check className="h-4 w-4 text-accent-green" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-primary">
            {t('issues.plan.approvedTitle')}
          </div>
          <div className="mt-0.5 text-[11.5px] text-text-muted">
            {t('issues.plan.approvedMeta', {
              steps: `${total} ${total !== 1 ? t('issues.plan.stepPlural') : t('issues.plan.stepSingular')}`,
              done: `${doneCount} ${doneCount !== 1 ? t('issues.plan.donePlural') : t('issues.plan.doneSingular')}`,
            })}
            {plan?.decidedAt ? ` · ${formatDateTime(plan.decidedAt)}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={() => decideMut.mutate({ decision: 'request_changes' })}
          disabled={busy}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary disabled:opacity-50"
        >
          {t('issues.plan.reopen')}
        </button>
      </div>
    );
  }

  // ---- Estado: recusado ----
  if (status === 'rejected') {
    return (
      <div className="mt-6 flex items-center gap-3 rounded-xl border border-accent-red/25 bg-accent-red/[0.06] px-4 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-red/15">
          <X className="h-4 w-4 text-accent-red" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-primary">
            {t('issues.plan.rejectedTitle')}
          </div>
          <div className="mt-0.5 text-[11.5px] text-text-muted">
            {t('issues.plan.rejectedMeta')}
            {plan?.decidedAt ? ` · ${formatDateTime(plan.decidedAt)}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={() => decideMut.mutate({ decision: 'request_changes' })}
          disabled={busy}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary disabled:opacity-50"
        >
          {t('issues.plan.reopen')}
        </button>
      </div>
    );
  }

  // ---- Estado: pendente ou changes_requested ----
  const isChanges = status === 'changes_requested';
  return (
    <div
      className={cn(
        'mt-6 overflow-hidden rounded-xl border bg-surface-veil',
        isChanges ? 'border-accent-yellow/25' : 'border-accent-purple/25',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-hairline-faint px-4 py-3">
        <span
          className={cn(
            'grid h-8 w-8 shrink-0 place-items-center rounded-full',
            isChanges ? 'bg-accent-yellow/12' : 'bg-accent-purple/12',
          )}
        >
          <ListChecks
            className={cn('h-4 w-4', isChanges ? 'text-accent-yellow' : 'text-accent-purple')}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-primary">
            {t('issues.plan.executionTitle')}
          </div>
          <div className="mt-0.5 text-[11.5px] text-text-muted">
            {isChanges
              ? t('issues.plan.changesRequestedHint')
              : t('issues.plan.pendingHint', {
                  steps: `${total} ${total !== 1 ? t('issues.plan.stepPlural') : t('issues.plan.stepSingular')}`,
                })}
          </div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            isChanges
              ? 'bg-accent-yellow/12 text-accent-yellow'
              : 'bg-accent-purple/12 text-accent-purple',
          )}
        >
          {isChanges ? t('issues.plan.badgeChanges') : t('issues.plan.badgePending')}
        </span>
      </div>

      {/* Observação anterior (changes_requested) */}
      {isChanges && plan?.note && (
        <div className="border-b border-hairline-faint bg-accent-yellow/[0.04] px-4 py-2.5 text-[12px] text-text-secondary">
          {plan.note}
        </div>
      )}

      {/* Etapas (sub-issues) */}
      <div className="flex flex-col">
        {childIssues.map((c, i) => {
          const ag = agents.find((a) => a.id === c.assigneeAgentId);
          return (
            <Link
              key={c.id}
              to={`/issues/${prefix}-${c.issueKey}`}
              className="group flex items-center gap-2.5 border-b border-hairline-ghost px-4 py-2 last:border-b-0 hover:bg-surface-subtle"
            >
              <span className="w-5 shrink-0 text-right font-mono text-[10px] text-text-faint">
                {i + 1}
              </span>
              <CompactStatusDot status={c.status} />
              <span className="font-mono text-[10px] text-text-faint">
                {epicRef}.{c.childOrdinal ?? c.issueKey}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary group-hover:text-text-primary">
                {c.title}
              </span>
              {ag && (
                <span className="shrink-0 rounded bg-surface-active px-1.5 py-0.5 text-[9.5px] text-text-muted">
                  {ag.name}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Ações */}
      {askMode ? (
        <div className="flex flex-col gap-2 border-t border-hairline-faint px-4 py-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
            rows={3}
            placeholder={
              askMode === 'reject'
                ? t('issues.plan.rejectReasonPlaceholder')
                : t('issues.plan.changesPlaceholder')
            }
            className="thin-scrollbar w-full resize-none rounded-md border border-hairline-strong bg-surface-faint px-3 py-2 text-[12px] text-text-primary placeholder:text-text-faint focus:border-hairline-mega focus:outline-none"
          />
          <StagedChips items={att.items} onRemove={att.remove} />
          <div className="flex items-center justify-between gap-2">
            <AttachButton onClick={att.pick} picking={att.picking} />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setAskMode(null);
                  att.clear();
                }}
                disabled={busy}
                className="rounded-md px-2.5 py-1.5 text-[12px] text-text-muted hover:text-text-primary disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              {askMode === 'reject' ? (
                <button
                  type="button"
                  onClick={() => decideMut.mutate({ decision: 'reject', note })}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent-red/15 px-3 py-1.5 text-[12px] font-medium text-accent-red hover:bg-accent-red/25 disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                  {t('issues.plan.confirmReject')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => decideMut.mutate({ decision: 'request_changes', note })}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent-yellow/15 px-3 py-1.5 text-[12px] font-medium text-accent-yellow hover:bg-accent-yellow/25 disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PencilLine className="h-3.5 w-3.5" />
                  )}
                  {t('issues.plan.sendChanges')}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline-faint px-4 py-3">
          <button
            type="button"
            onClick={() => decideMut.mutate({ decision: 'approve' })}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-green px-3 py-1.5 text-[12px] font-semibold text-black hover:bg-accent-green/90 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {t('issues.plan.approveAndExecute')}
          </button>
          <button
            type="button"
            onClick={() => setAskMode('changes')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-hairline-heavy px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-1 hover:text-text-primary disabled:opacity-50"
          >
            <PencilLine className="h-3.5 w-3.5" />
            {t('issues.plan.requestChanges')}
          </button>
          <button
            type="button"
            onClick={() => setAskMode('reject')}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-accent-red/25 px-3 py-1.5 text-[12px] text-accent-red hover:bg-accent-red/10 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            {t('issues.plan.reject')}
          </button>
        </div>
      )}
    </div>
  );
}

export function IssueDetailPage() {
  const { t } = useT();
  const { issueKey } = useParams<{ issueKey: string }>();
  const navigate = useNavigate();
  const workspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const markRead = useIssueReadStore((s) => s.markRead);
  const [tab, setTab] = useState<Tab>('chat');
  // Eventos de execução vêm do store de sessão (alimentado por um listener
  // global no App). Assim o trace PERSISTE ao sair e voltar pra página.
  const execByIssue = useExecutionStore((s) => s.byIssue);
  const ingestExecutionEvent = useExecutionStore((s) => s.ingest);
  // Cancelamento OTIMISTA: ao clicar em "Cancelar execução" escondemos a UI de
  // "rodando" na hora; resetado quando um run começa/termina de fato.
  const [cancelling, setCancelling] = useState(false);

  // Parse "BOR-12" → 12. Aceita também só o número.
  const parsedKey = parseIssueKey(issueKey ?? '');

  const issueQuery = useQuery({
    queryKey: ['issue-by-key', workspace?.id, parsedKey],
    enabled: !!workspace && parsedKey !== null,
    queryFn: () =>
      window.orkestral['issue:get-by-key']({
        workspaceId: workspace!.id,
        issueKey: parsedKey!,
      }),
    refetchInterval: 5000,
  });

  const issue = issueQuery.data;

  const commentsQuery = useQuery({
    queryKey: ['issue-comments', issue?.id],
    enabled: !!issue,
    queryFn: () => window.orkestral['issue:list-comments']({ issueId: issue!.id }),
    refetchInterval: 4000,
  });

  const runsQuery = useQuery({
    queryKey: ['issue-runs', issue?.id],
    enabled: !!issue,
    queryFn: () => window.orkestral['issue:list-runs']({ issueId: issue!.id }),
    refetchInterval: 4000,
  });
  const executionEventsQuery = useQuery({
    queryKey: ['issue-execution-events', issue?.id],
    enabled: !!issue,
    queryFn: () =>
      window.orkestral['issue:list-execution-events']({
        issueIds: [issue!.id],
        limitPerIssue: 300,
      }),
  });

  useEffect(() => {
    if (!issue || !executionEventsQuery.data) return;
    for (const event of executionEventsQuery.data[issue.id] ?? []) {
      ingestExecutionEvent(event);
    }
  }, [issue, executionEventsQuery.data, ingestExecutionEvent]);

  const qaValidationQuery = useQuery({
    queryKey: ['qa-validation', issue?.id],
    enabled: !!issue,
    queryFn: () => window.orkestral['qa:get-latest-validation']({ issueId: issue!.id }),
    refetchInterval: 4000,
  });

  const agentsQuery = useQuery({
    queryKey: ['agents', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: workspace!.id }),
  });

  // Hidratação do linked work (parent + sub-issues) — DEVE ficar no topo do
  // componente, junto com os outros useQuery. Mover pra depois de early
  // returns viola as Rules of Hooks (Rendered more hooks than previous render).
  const issueData = issueQuery.data;
  const parentQuery = useQuery({
    queryKey: ['issue-parent', issueData?.parentIssueId],
    enabled: !!issueData?.parentIssueId,
    queryFn: () => window.orkestral['issue:get']({ issueId: issueData!.parentIssueId! }),
  });
  const childrenQuery = useQuery({
    queryKey: ['issue-children', issueData?.id],
    enabled: !!issueData?.id,
    queryFn: () => window.orkestral['issue:children']({ parentIssueId: issueData!.id }),
    refetchInterval: 8000,
  });
  const agentTraceQuery = useQuery({
    queryKey: ['agent-trace-events', workspace?.id, issueData?.id],
    enabled: !!workspace?.id && !!issueData?.id,
    queryFn: () =>
      window.orkestral['logs:list-agent-trace-events']({
        workspaceId: workspace!.id,
        issueId: issueData!.id,
        limit: 300,
      }),
    refetchInterval: 5000,
  });

  // Marca como lida cada vez que a issue (ou updatedAt) é atualizada.
  // Como a query refetch a cada 5s e os events também invalidam, isso
  // mantém a issue "lida" enquanto o usuário está na página.
  useEffect(() => {
    if (issueQuery.data) markRead(issueQuery.data.id);
  }, [issueQuery.data, markRead]);

  // Listener pra invalidar quando o agente roda
  useEffect(() => {
    const api = (
      window as Window & {
        orkestralEvents?: { onIssueExecutionEvent?: unknown };
      }
    ).orkestralEvents;
    if (
      !api ||
      typeof (api as { onIssueExecutionEvent?: unknown }).onIssueExecutionEvent !== 'function'
    ) {
      return;
    }
    const unsub = window.orkestralEvents.onIssueExecutionEvent((event) => {
      // As FILHAS de um épico também disparam eventos (event.issueId = filha).
      // Invalida a lista de filhas em QUALQUER evento pra o status agregado do
      // épico refletir ao vivo, sem esperar o refetch de 8s (P0-10).
      queryClient.invalidateQueries({ queryKey: ['issue-children'] });
      if (!issue || event.issueId !== issue.id) return;
      // A acumulação do trace é global (App → executionStore). Aqui só
      // invalidamos as queries pra refletir o estado novo na tela.
      queryClient.invalidateQueries({ queryKey: ['issue-comments', issue.id] });
      queryClient.invalidateQueries({ queryKey: ['issue-runs', issue.id] });
      queryClient.invalidateQueries({ queryKey: ['qa-validation', issue.id] });
      queryClient.invalidateQueries({ queryKey: ['issue-by-key', workspace?.id, parsedKey] });
      // Reseta o estado otimista de cancelamento quando um run começa ou termina.
      if (event.type === 'started' || event.type === 'finished' || event.type === 'error') {
        setCancelling(false);
      }
    });
    return unsub;
  }, [issue, queryClient, workspace?.id, parsedKey]);

  useEffect(() => {
    const api = (
      window as Window & {
        orkestralEvents?: { onIssuesChanged?: unknown };
      }
    ).orkestralEvents;
    if (!api || typeof (api as { onIssuesChanged?: unknown }).onIssuesChanged !== 'function') {
      return;
    }
    const unsub = window.orkestralEvents.onIssuesChanged((event) => {
      if (!issue || event.workspaceId !== issue.workspaceId) return;
      queryClient.invalidateQueries({ queryKey: ['issue-comments', issue.id] });
      queryClient.invalidateQueries({ queryKey: ['qa-validation', issue.id] });
      queryClient.invalidateQueries({ queryKey: ['issue-by-key', workspace?.id, parsedKey] });
      queryClient.invalidateQueries({ queryKey: ['issue-children'] });
    });
    return unsub;
  }, [issue, queryClient, workspace?.id, parsedKey]);

  useEffect(() => {
    const api = (
      window as Window & {
        orkestralEvents?: { onAgentTraceEvent?: unknown };
      }
    ).orkestralEvents;
    if (!api || typeof (api as { onAgentTraceEvent?: unknown }).onAgentTraceEvent !== 'function') {
      return;
    }
    const unsub = window.orkestralEvents.onAgentTraceEvent((event) => {
      if (!issue || event.issueId !== issue.id) return;
      queryClient.invalidateQueries({ queryKey: ['agent-trace-events', workspace?.id, issue.id] });
    });
    return unsub;
  }, [issue, queryClient, workspace?.id]);

  if (parsedKey === null) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('issues.detail.invalidKey')} <code className="ml-1">{issueKey}</code>
        </div>
      </Shell>
    );
  }

  if (issueQuery.isPending) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('issues.detail.loading')}
        </div>
      </Shell>
    );
  }

  if (!issue || !workspace) {
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <span className="text-[13px] text-text-muted">{t('issues.detail.notFound')}</span>
          <button
            type="button"
            onClick={() => navigate('/issues')}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-faint px-2.5 text-[11.5px] text-text-secondary hover:bg-surface-active hover:text-text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('issues.detail.backToIssues')}
          </button>
        </div>
      </Shell>
    );
  }

  const comments = commentsQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const qaValidation = qaValidationQuery.data ?? null;
  const liveEvents = execByIssue[issue.id] ?? [];
  const agentTraceEvents = agentTraceQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const prefix = issuePrefix(workspace.name);
  const executionUi = deriveIssueExecutionUiState({
    issueStatus: issue.status,
    runs,
    cancelling,
  });
  const effectiveRunning = executionUi.effectiveRunning;
  const displayStatus = executionUi.displayStatus;
  const stuckInfo = detectStuck(issue, runs);
  const parent = parentQuery.data ?? null;
  const childIssues = childrenQuery.data ?? [];
  // Numeração HUMANA (display), igual à lista de Issues. Top-level = PREFIX-N
  // (displayKey); sub-issue = {display do pai}.{childOrdinal}. Fallback p/
  // issueKey interno em dados pré-migração.
  const issueRef =
    issue.childOrdinal != null && parent
      ? `${prefix}-${parent.displayKey ?? parent.issueKey}.${issue.childOrdinal}`
      : `${prefix}-${issue.displayKey ?? issue.issueKey}`;

  return (
    <Shell>
      {/* Breadcrumb header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <button
          type="button"
          onClick={() => navigate('/issues')}
          className="grid h-7 w-7 place-items-center rounded-md text-text-secondary hover:bg-surface-active hover:text-text-primary"
          title={t('issues.detail.back')}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <Link to="/issues" className="text-[12px] text-text-muted hover:text-text-primary">
          {t('issues.detail.breadcrumbIssues')}
        </Link>
        <span className="text-text-faint">/</span>
        <span className="font-mono text-[11.5px] text-text-faint">{issueRef}</span>
        <span className="text-text-faint">/</span>
        <span className="flex-1 truncate text-[12.5px] font-medium text-text-primary">
          {issue.title}
        </span>
        <IssueHeaderMenu issue={issue} />
      </header>

      {/* Body: split content + properties */}
      <div className="flex min-h-0 flex-1">
        {/* Main */}
        <main className="thin-scrollbar flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-8 py-8">
            {/* Status pill + title */}
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={displayStatus} />
              <VerificationBadge issue={issue} />
              <LocalEconomicsChip issue={issue} />
              <span className="font-mono text-[11px] text-text-faint">{issueRef}</span>
            </div>
            <h1 className="mt-3 text-[28px] font-bold leading-tight tracking-tight text-text-primary">
              {issue.title}
            </h1>

            {/* Action bar — run / cancel. Concluída/cancelada não mostra o CTA
                verde de "Executar"; oferece só um "Executar novamente" discreto. */}
            <div className="mt-5 flex items-center gap-2">
              {effectiveRunning ? (
                <CancelExecutionButton issueId={issue.id} onCancel={() => setCancelling(true)} />
              ) : displayStatus === 'done' || displayStatus === 'cancelled' ? (
                <RunExecutionButton issue={issue} subtle />
              ) : (
                <RunExecutionButton issue={issue} />
              )}
              {issue.metadata &&
                (issue.metadata as Record<string, unknown>).kind === 'kb-analysis' && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-purple-400/20 bg-purple-400/[0.05] px-2 py-1 text-[10.5px] text-purple-200">
                    <Brain className="h-3 w-3" />
                    {t('issues.detail.kbAnalysis')}
                  </span>
                )}
            </div>

            {/* Plano de execução — épica com sub-issues ganha um card claro de
                aprovação. Aparece sempre que há filhos; muda de forma conforme
                o estado (pendente → aprovado/ajustes). */}
            {childIssues.length > 0 && (
              <PlanApprovalCard
                epic={issue}
                childIssues={childIssues}
                agents={agents}
                prefix={prefix}
              />
            )}

            {/* Live execution banner — visível enquanto há run rodando */}
            {effectiveRunning && <LiveExecutionBanner liveEvents={liveEvents} />}

            {qaValidation && <QaValidationCard validation={qaValidation} agents={agents} />}

            {/* Recovery banner — issue travou (in_progress sem run ativa há horas) */}
            {!executionUi.hasActiveRun && stuckInfo && (
              <StuckRecoveryBanner issue={issue} stuckInfo={stuckInfo} />
            )}

            {/* Objetivo final do épico (P0-08): expectativa que o CEO valida no fim. */}
            {(() => {
              const fo = (issue.metadata as { finalObjective?: string } | null)?.finalObjective;
              return fo ? (
                <div className="mt-8 flex gap-2.5 rounded-lg border border-accent-purple/20 bg-accent-purple/[0.06] px-3.5 py-2.5">
                  <Target className="mt-0.5 h-4 w-4 shrink-0 text-accent-purple" />
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-accent-purple">
                      {t('issues.finalObjective')}
                    </div>
                    <div className="mt-0.5 text-[13px] text-text-secondary">{fo}</div>
                  </div>
                </div>
              ) : null;
            })()}

            {/* Description */}
            {issue.description && (
              <Markdown className="mt-8" mentionAgents={agents}>
                {issue.description}
              </Markdown>
            )}

            {/* Tasks: checklist de uma issue de construção, marca ao vivo + toggle manual. */}
            <div className="mt-6">
              <IssueTasks issue={issue} agents={agents} />
            </div>

            {/* Critério de PRONTO (contrato de execução): o teste verificável que o
                Forge persegue e o reviewer confere. Visível pra você acompanhar. */}
            {(() => {
              const done = (issue.metadata as { done?: string } | null)?.done?.trim();
              if (!done) return null;
              return (
                <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3">
                  <Target className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                      {t('issues.detail.doneCriterion')}
                    </p>
                    <p className="mt-0.5 text-[13px] text-text-secondary">{done}</p>
                  </div>
                </div>
              );
            })()}

            {/* Tabs */}
            <div className="mt-10 border-b border-hairline-faint">
              <div className="flex items-center gap-1">
                <TabBtn active={tab === 'chat'} onClick={() => setTab('chat')}>
                  <MessageSquare className="h-3.5 w-3.5" />
                  {t('issues.tabs.chat')}
                  {comments.length > 0 && (
                    <span className="ml-1 font-mono text-[10px] text-text-faint">
                      {comments.length}
                    </span>
                  )}
                </TabBtn>
                <TabBtn active={tab === 'activity'} onClick={() => setTab('activity')}>
                  <ActivityIcon className="h-3.5 w-3.5" />
                  {t('issues.tabs.activity')}
                  {runs.length > 0 && (
                    <span className="ml-1 font-mono text-[10px] text-text-faint">
                      {runs.length}
                    </span>
                  )}
                </TabBtn>
                <TabBtn active={tab === 'related'} onClick={() => setTab('related')}>
                  <Link2 className="h-3.5 w-3.5" />
                  {t('issues.tabs.related')}
                </TabBtn>
              </div>
            </div>

            <div className="mt-5 min-h-[200px]">
              {tab === 'chat' && (
                <ChatTab
                  issue={issue}
                  comments={comments}
                  agents={agents}
                  liveEvents={effectiveRunning ? liveEvents : []}
                  traceEvents={agentTraceEvents}
                />
              )}
              {tab === 'activity' && <ActivityTab runs={runs} />}
              {tab === 'related' && (
                <RelatedTab
                  issue={issue}
                  parent={parent}
                  childIssues={childIssues}
                  prefix={prefix}
                />
              )}
            </div>
          </div>
        </main>

        {/* Properties panel */}
        <aside className="hidden w-[280px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-background-card/40 px-4 py-5 lg:flex">
          <PropertiesPanel
            issue={issue}
            agents={agents}
            parent={parent}
            childIssues={childIssues}
            prefix={prefix}
          />
        </aside>
      </div>
    </Shell>
  );
}

/**
 * Menu "..." no header — opções de página completa. Por enquanto: deletar.
 * Confirm inline com texto vermelho (sem modal extra).
 */
function IssueHeaderMenu({ issue }: { issue: Issue }) {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const deleteMut = useMutation({
    mutationFn: () => window.orkestral['issue:delete']({ issueId: issue.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      navigate('/issues');
    },
  });

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest('[data-issue-header-menu]')) return;
      setOpen(false);
      setConfirming(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setConfirming(false);
      }
    }
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', onClick);
      document.addEventListener('keydown', onKey);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" data-issue-header-menu>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'grid h-7 w-7 place-items-center rounded-md text-text-secondary hover:bg-surface-active hover:text-text-primary',
          open && 'bg-surface-active text-text-primary',
        )}
        title={t('issues.detail.moreOptions')}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-9 z-50 flex w-52 flex-col gap-0.5 rounded-lg border border-hairline-strong p-1 shadow-2xl"
          style={{ backgroundColor: '#15161b' }}
        >
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-accent-red hover:bg-accent-red/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{t('issues.detail.deleteIssue')}</span>
            </button>
          ) : (
            <div className="flex flex-col gap-1.5 px-2 py-2">
              <p className="text-[11.5px] text-text-secondary">
                {t('issues.detail.deleteConfirm')}
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => deleteMut.mutate()}
                  disabled={deleteMut.isPending}
                  className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border border-accent-red/40 bg-accent-red/15 px-2 text-[11.5px] font-medium text-accent-red hover:bg-accent-red/25 disabled:opacity-50"
                >
                  {deleteMut.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                  {t('issues.detail.delete')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setOpen(false);
                  }}
                  className="inline-flex h-7 items-center justify-center rounded-md border border-hairline-strong bg-surface-faint px-2 text-[11.5px] text-text-secondary hover:bg-surface-active hover:text-text-primary"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
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

function StatusChip({ status }: { status: IssueStatus }) {
  const { t } = useT();
  const meta = STATUS_META[status];
  const Icon = meta.Icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide',
        meta.chipClass,
      )}
    >
      <Icon className={cn('h-3 w-3', meta.color)} />
      {statusLabel(t, status)}
    </span>
  );
}

const VERIFICATION_META: Record<
  IssueVerificationState,
  {
    Icon: typeof ShieldCheck;
    chipClass: string;
    iconColor: string;
    labelKey: string;
    hintKey: string;
  }
> = {
  verified: {
    Icon: ShieldCheck,
    chipClass: 'border-accent-green/30 text-accent-green',
    iconColor: 'text-accent-green',
    labelKey: 'issues.verification.verified',
    hintKey: 'issues.verification.verifiedHint',
  },
  unverified: {
    Icon: ShieldAlert,
    chipClass: 'border-accent-yellow/30 text-accent-yellow',
    iconColor: 'text-accent-yellow',
    labelKey: 'issues.verification.unverified',
    hintKey: 'issues.verification.unverifiedHint',
  },
  not_applicable: {
    Icon: ShieldQuestion,
    chipClass: 'border-hairline-strong text-text-muted',
    iconColor: 'text-text-faint',
    labelKey: 'issues.verification.notApplicable',
    hintKey: 'issues.verification.notApplicableHint',
  },
};

/**
 * Selo de verificação de uma issue concluída — surface do veredito
 * `issue.metadata.verification` ('verified'/'unverified'/'not_applicable').
 * Só aparece quando a issue está `done` (verificação só faz sentido no fim).
 * Usa tokens de status/accent + ícone (sem emoji).
 */
function VerificationBadge({ issue }: { issue: Issue }) {
  const { t } = useT();
  if (issue.status !== 'done') return null;
  const state =
    (issue.metadata as { verification?: IssueVerificationState } | null)?.verification ??
    'not_applicable';
  const meta = VERIFICATION_META[state];
  const Icon = meta.Icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide',
        meta.chipClass,
      )}
      title={t(meta.hintKey)}
    >
      <Icon className={cn('h-3 w-3', meta.iconColor)} />
      {t(meta.labelKey)}
    </span>
  );
}

/** USD pequeno legível pro chip (sub-cent vira "<$0.01"). */
function formatChipUsd(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return usd.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

/**
 * Chip de economia: quando o Forge resolveu a issue local, mostra o quanto o
 * premium TERIA gastado (counterfactual estimado em metadata.localEconomics). É o
 * pilar do produto — a economia — tornado visível DIRETO na issue, não escondido.
 */
function LocalEconomicsChip({ issue }: { issue: Issue }) {
  const { t } = useT();
  const econ = (issue.metadata as { localEconomics?: { savedUsd?: number } } | null)
    ?.localEconomics;
  if (!econ || typeof econ.savedUsd !== 'number' || econ.savedUsd <= 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-accent"
      title={t('issues.detail.economyHint')}
    >
      <PiggyBank className="h-3 w-3" />
      {t('issues.detail.economySaved', { amount: formatChipUsd(econ.savedUsd) })}
    </span>
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
        'inline-flex items-center gap-1.5 border-b-2 px-3 pb-2.5 pt-1.5 text-[12px] transition-colors',
        active
          ? 'border-text-primary text-text-primary'
          : 'border-transparent text-text-muted hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}

// ============================================================================
// Run/Cancel buttons
// ============================================================================

function RunExecutionButton({ issue, subtle }: { issue: Issue; subtle?: boolean }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await window.orkestral['issue:execute']({ issueId: issue.id });
      queryClient.invalidateQueries({ queryKey: ['issue-runs', issue.id] });
      queryClient.invalidateQueries({ queryKey: ['issue-by-key'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={busy || !issue.assigneeAgentId}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors disabled:opacity-50',
          subtle
            ? 'border border-hairline-heavy text-text-secondary hover:bg-surface-2 hover:text-text-primary'
            : 'border border-accent-green/30 bg-accent-green/10 text-accent-green hover:bg-accent-green/15',
        )}
        title={
          !issue.assigneeAgentId
            ? t('issues.run.noAssigneeTooltip')
            : subtle
              ? t('issues.run.runAgainTooltip')
              : t('issues.run.runTooltip')
        }
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        {subtle ? t('issues.run.runAgain') : t('issues.run.run')}
      </button>
      {error && <span className="text-[11px] text-accent-red">{error}</span>}
    </div>
  );
}

function CancelExecutionButton({ issueId, onCancel }: { issueId: string; onCancel?: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  function cancel() {
    // OTIMISTA: reflete na UI imediatamente (esconde o banner "rodando" via
    // onCancel) e dispara o kill em background — não bloqueia o clique.
    setBusy(true);
    onCancel?.();
    void window.orkestral['issue:cancel-execution']({ issueId })
      .catch(() => {})
      .finally(() => {
        queryClient.invalidateQueries({ queryKey: ['issue-runs', issueId] });
      });
  }

  return (
    <button
      type="button"
      onClick={cancel}
      disabled={busy}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 text-[12px] font-medium text-accent-red transition-colors hover:bg-accent-red/15 disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
      {busy ? t('issues.run.cancelling') : t('issues.run.cancel')}
    </button>
  );
}

// ============================================================================
// Tabs
// ============================================================================

function ChatTab({
  issue,
  comments,
  agents,
  liveEvents,
  traceEvents,
}: {
  issue: Issue;
  comments: IssueComment[];
  agents: Agent[];
  liveEvents: LiveExecEvent[];
  traceEvents: AgentTraceEvent[];
}) {
  const { t } = useT();
  const issueId = issue.id;
  const [body, setBody] = useState('');
  const att = useStagedAttachments();
  const queryClient = useQueryClient();

  const addCommentMut = useMutation({
    mutationFn: () =>
      window.orkestral['issue:add-comment']({
        issueId,
        body: body.trim(),
        authorKind: 'user',
        attachments: att.items,
      }),
    onSuccess: () => {
      setBody('');
      att.clear();
      queryClient.invalidateQueries({ queryKey: ['issue-comments', issueId] });
    },
    onError: (e) =>
      toast.error(t('issues.chat.commentFailed'), e instanceof Error ? e.message : undefined),
  });

  const deleteCommentMut = useMutation({
    mutationFn: (commentId: string) => window.orkestral['issue:delete-comment']({ commentId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue-comments', issueId] });
    },
  });

  const canSend = (body.trim().length > 0 || att.items.length > 0) && !addCommentMut.isPending;
  function send() {
    if (!canSend) return;
    addCommentMut.mutate();
  }

  // Resolve o agente de um comentário pelo AUTOR explícito (carimbado na origem
  // via authorAgentId). NÃO cai pro responsável ATUAL da issue: num review
  // reprovado o assignee já virou o executor, e esse fallback atribuía o
  // comentário do revisor ao agente errado (ex.: review do Code Reviewer
  // aparecendo como Backend). Sem autor explícito → rótulo genérico (authorLabel).
  function resolveAgent(c: IssueComment): Agent | null {
    if (c.authorKind !== 'agent') return null;
    return agents.find((a) => a.id === c.authorAgentId) ?? null;
  }
  function authorLabel(c: IssueComment): string {
    if (c.authorKind === 'system') return t('issues.chat.system');
    if (c.authorKind === 'agent') return resolveAgent(c)?.name ?? t('issues.chat.agent');
    return t('issues.chat.you');
  }

  return (
    <div className="flex flex-col gap-4">
      {traceEvents.length > 0 ? (
        <AgentTimeline events={traceEvents} />
      ) : (
        liveEvents.length > 0 && <LiveTimeline events={liveEvents} />
      )}
      {comments.length === 0 && liveEvents.length === 0 && traceEvents.length === 0 ? (
        <div className="rounded-md border border-dashed border-hairline px-4 py-6 text-center text-[12px] text-text-muted">
          {t('issues.chat.empty')}
        </div>
      ) : comments.length === 0 ? null : (
        <div className="flex flex-col gap-3">
          {comments.map((c) => {
            // Comentário de escalonamento (Forge → premium) ganha card próprio, distinto.
            const esc = c.authorKind === 'system' ? parseEscalation(c.body) : null;
            if (esc) {
              return (
                <EscalationCard
                  key={c.id}
                  adapter={esc.adapter}
                  reason={esc.reason}
                  time={formatDateTime(c.createdAt)}
                />
              );
            }
            const ag = resolveAgent(c);
            return (
              <div
                key={c.id}
                className="group rounded-md border border-hairline-faint bg-surface-veil px-3 py-2.5"
              >
                <div className="flex items-center gap-2 text-[11px] text-text-muted">
                  {ag ? (
                    <AgentAvatar seed={ag.avatarSeed} name={ag.name} size={18} rounded="full" />
                  ) : (
                    <span
                      className={cn(
                        'grid h-[18px] w-[18px] place-items-center rounded-full text-[8px] font-semibold',
                        c.authorKind === 'system'
                          ? 'bg-surface-active text-text-muted'
                          : 'bg-accent-blue/20 text-accent-blue',
                      )}
                    >
                      {c.authorKind === 'system' ? 'S' : 'V'}
                    </span>
                  )}
                  <span className="font-medium text-text-secondary">{authorLabel(c)}</span>
                  <span className="text-text-faint">· {formatDateTime(c.createdAt)}</span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => deleteCommentMut.mutate(c.id)}
                    className="opacity-0 transition-opacity hover:text-accent-red group-hover:opacity-100"
                    title={t('issues.chat.deleteComment')}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                <Markdown className="mt-2" mentionAgents={agents}>
                  {c.body}
                </Markdown>
                {c.attachments?.length ? (
                  <AttachmentChips items={c.attachments} className="mt-2" />
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-md border border-hairline bg-surface-faint focus-within:border-hairline-vivid">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t('issues.chat.placeholder')}
          rows={3}
          className="block w-full resize-none bg-transparent px-3 py-2.5 text-[12.5px] text-text-primary placeholder:text-text-faint focus:outline-none"
        />
        {att.items.length > 0 && (
          <div className="border-t border-hairline-soft px-3 py-2">
            <StagedChips items={att.items} onRemove={att.remove} />
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-hairline-soft px-2 py-1.5">
          <AttachButton onClick={att.pick} picking={att.picking} />
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-1 px-2.5 text-[11.5px] text-text-secondary transition-colors hover:bg-surface-strong hover:text-text-primary disabled:opacity-50"
          >
            {addCommentMut.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            {t('issues.chat.send')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActivityTab({ runs }: { runs: IssueRun[] }) {
  const { t } = useT();
  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-hairline px-4 py-6 text-center text-[12px] text-text-muted">
        {t('issues.activity.empty')}
      </div>
    );
  }
  const totals = runs.reduce(
    (acc, r) => ({
      runs: acc.runs + 1,
      runtimeMs:
        acc.runtimeMs +
        (r.finishedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : 0),
      toolCalls: acc.toolCalls + (r.toolCallCount ?? 0),
      costUsd: acc.costUsd + (r.costUsd ?? 0),
      tokensIn: acc.tokensIn + (r.tokensIn ?? 0),
      tokensOut: acc.tokensOut + (r.tokensOut ?? 0),
    }),
    { runs: 0, runtimeMs: 0, toolCalls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 },
  );
  return (
    <div className="flex flex-col gap-3">
      <SessionUsageSummaryCard totals={totals} />
      <div className="flex flex-col gap-2">
        {runs.map((r) => {
          const dur = r.finishedAt
            ? humanDuration(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime())
            : t('issues.activity.inProgress');
          return (
            <div
              key={r.id}
              className="rounded-md border border-hairline-faint bg-surface-veil px-3 py-2.5"
            >
              <div className="flex items-center gap-2 text-[12px]">
                <RunStatusChip status={r.status} />
                <span className="text-text-muted">·</span>
                <span className="text-text-muted">{dur}</span>
                <RunExecutorChip run={r} />
                <span className="flex-1" />
                <span className="font-mono text-[10.5px] text-text-faint">
                  {formatDateTime(r.startedAt)}
                </span>
              </div>
              {/* Custo ($0 = Forge), tokens — dados já persistidos por run. */}
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px] text-text-muted">
                <span>
                  {t('issues.activity.cost')}{' '}
                  <span className="font-medium text-text-secondary">{runCostLabel(t, r)}</span>
                </span>
                {(r.tokensIn != null || r.tokensOut != null) && (
                  <span>
                    {t('issues.activity.tokens')}{' '}
                    <span className="font-medium text-text-secondary">
                      {(r.tokensIn ?? 0) + (r.tokensOut ?? 0)}
                    </span>{' '}
                    <span className="text-text-faint">
                      {t('issues.activity.tokensInOut', {
                        in: r.tokensIn ?? 0,
                        out: r.tokensOut ?? 0,
                      })}
                    </span>
                  </span>
                )}
                {r.toolCallCount != null && (
                  <span>
                    {t('issues.activity.toolCalls')}{' '}
                    <span className="font-medium text-text-secondary">{r.toolCallCount}</span>
                  </span>
                )}
              </div>
              {r.outputSummary && (
                <div className="mt-1.5 text-[11.5px] text-text-secondary">{r.outputSummary}</div>
              )}
              {r.errorMessage && (
                <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded bg-accent-red/[0.06] px-2 py-1.5 text-[11px] text-accent-red">
                  {r.errorMessage}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** true se o run foi resolvido localmente pelo Forge (executor $0). */
function isForgeRun(run: Pick<IssueRun, 'adapterType' | 'exitReason'>): boolean {
  return (
    run.adapterType === 'orkestral_local' || (run.exitReason?.startsWith('local_resolved') ?? false)
  );
}

/** Formata o custo de um run em USD. Forge / custo zero → rótulo "$0 (Forge)". */
function runCostLabel(t: TFunction, run: IssueRun): string {
  if (isForgeRun(run) || (run.costUsd ?? 0) === 0) return t('issues.activity.costFree');
  return (run.costUsd as number).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
  });
}

/**
 * Selo do executor de um run: Forge (local, $0) vs Premium (CLI premium). O
 * diferencial central do app — mostra de forma honesta quem rodou cada run.
 */
function RunExecutorChip({ run }: { run: IssueRun }) {
  const { t } = useT();
  const forge = isForgeRun(run);
  const label = forge ? BRANDING.forgeName : providerLabel(run.adapterType);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        forge ? 'bg-accent-green/10 text-accent-green' : 'bg-surface-active text-text-muted',
      )}
      title={
        forge
          ? t('issues.activity.executorForgeTooltip', { forge: BRANDING.forgeName })
          : t('issues.activity.executorPremiumTooltip')
      }
    >
      <ProviderIcon provider={run.adapterType} className="h-3 w-3" />
      {label}
    </span>
  );
}

function QaValidationCard({ validation, agents }: { validation: QaValidation; agents: Agent[] }) {
  const passed = validation.checks.filter((check) => check.status === 'passed').length;
  const failed = validation.checks.filter((check) => check.status === 'failed').length;
  const done = validation.checks.filter(
    (check) => check.status === 'passed' || check.status === 'failed' || check.status === 'skipped',
  ).length;
  const statusMeta = {
    planned: { label: 'Planned', cls: 'text-text-muted border-white/[0.08]' },
    running: { label: 'Running', cls: 'text-accent-blue border-accent-blue/30' },
    passed: { label: 'Passed', cls: 'text-accent-green border-accent-green/30' },
    failed: { label: 'Failed', cls: 'text-accent-red border-accent-red/30' },
    needs_human: { label: 'Needs human', cls: 'text-accent-yellow border-accent-yellow/30' },
  }[validation.status];
  const executorName =
    agents.find((agent) => agent.id === validation.executorAgentId)?.name ?? 'executor original';
  const qaName = agents.find((agent) => agent.id === validation.qaAgentId)?.name ?? 'QA';
  const nextAction =
    validation.status === 'failed'
      ? `Reprovado pelo ${qaName}; voltou para ${executorName} corrigir com o contexto do QA.`
      : validation.status === 'needs_human'
        ? `${qaName} pausou o gate; precisa de decisão humana antes de continuar.`
        : validation.status === 'passed'
          ? `${qaName} aprovou; a entrega pode seguir para próxima revisão ou conclusão.`
          : `${qaName} está validando a entrega de ${executorName} check por check.`;

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.015]">
      <div className="flex items-center gap-3 border-b border-white/[0.05] px-4 py-3">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-purple/[0.12] text-accent-purple">
          <ListChecks className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-primary">QA Validation</div>
          <div className="mt-0.5 text-[11px] text-text-faint">
            {done}/{validation.checks.length} checks · {passed} passed · {failed} failed
          </div>
        </div>
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
            statusMeta.cls,
          )}
        >
          {statusMeta.label}
        </span>
      </div>
      <div className="border-b border-white/[0.05] bg-white/[0.02] px-4 py-2.5 text-[11.5px] leading-relaxed text-text-secondary">
        {nextAction}
      </div>
      <div className="divide-y divide-white/[0.04]">
        {validation.checks.map((check) => (
          <div key={check.id} className="flex gap-3 px-4 py-3">
            <QaCheckIcon status={check.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-text-faint">{check.ordinal}</span>
                <span className="text-[12.5px] font-medium text-text-primary">{check.title}</span>
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
                {check.description}
              </p>
              {check.evidence && (
                <div className="mt-2 rounded-md border border-white/[0.05] bg-black/20 px-2.5 py-1.5 text-[11px] leading-relaxed text-text-secondary">
                  {check.evidence}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {validation.summary && (
        <div className="border-t border-white/[0.05] px-4 py-3 text-[12px] leading-relaxed text-text-secondary">
          {validation.summary}
        </div>
      )}
    </section>
  );
}

function QaCheckIcon({ status }: { status: QaValidation['checks'][number]['status'] }) {
  if (status === 'passed') return <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-green" />;
  if (status === 'failed') return <X className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />;
  if (status === 'running')
    return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent-blue" />;
  if (status === 'skipped')
    return <CircleMinus className="mt-0.5 h-4 w-4 shrink-0 text-text-faint" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-text-faint" />;
}

function SessionUsageSummaryCard({
  totals,
}: {
  totals: {
    runs: number;
    runtimeMs: number;
    toolCalls: number;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
  };
}) {
  const { t } = useT();
  const totalCost =
    totals.costUsd > 0
      ? totals.costUsd.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
      : t('issues.activity.costFree');
  const totalTokens = totals.tokensIn + totals.tokensOut;
  return (
    <div className="rounded-md border border-hairline-faint bg-surface-veil px-3 py-2">
      <div className="flex items-baseline gap-2 text-[11px] font-medium uppercase tracking-wider text-text-faint">
        {t('issues.activity.sessionUsage')}
        <span className="text-text-muted normal-case tracking-normal">
          ·{' '}
          {t('issues.activity.runtime', {
            duration: humanDuration(totals.runtimeMs),
            n: totals.runs,
            label:
              totals.runs === 1 ? t('issues.activity.runSingular') : t('issues.activity.runPlural'),
          })}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] text-text-secondary">
        <span>
          {t('issues.activity.totalCost')}{' '}
          <span className="font-medium text-text-primary">{totalCost}</span>
        </span>
        {totalTokens > 0 && (
          <span>
            {t('issues.activity.tokens')}{' '}
            <span className="font-medium text-text-primary">{totalTokens}</span>
          </span>
        )}
        <span>
          {t('issues.activity.toolCalls')}{' '}
          <span className="font-medium text-text-primary">{totals.toolCalls}</span>
        </span>
        <span className="text-text-faint">{t('issues.activity.detailsHint')}</span>
      </div>
    </div>
  );
}

function RunStatusChip({ status }: { status: IssueRun['status'] }) {
  const { t } = useT();
  const meta = {
    queued: { cls: 'text-text-muted' },
    running: { cls: 'text-accent-blue' },
    done: { cls: 'text-accent-green' },
    failed: { cls: 'text-accent-red' },
    cancelled: { cls: 'text-text-muted' },
  }[status];
  return (
    <span className={cn('text-[11px] font-medium uppercase tracking-wider', meta.cls)}>
      {t(`issues.runStatus.${status}`)}
    </span>
  );
}

// ============================================================================
// Properties panel
// ============================================================================

type IssueUpdatePatch = {
  title?: string;
  description?: string | null;
  status?: IssueStatus;
  priority?: IssuePriority;
  labels?: string[];
  assigneeAgentId?: string | null;
  parentIssueId?: string | null;
  goalId?: string | null;
  dueDate?: string | null;
};

const monitorOptions = (t: TFunction): Array<{ value: string; label: string }> => [
  { value: '', label: t('issues.monitor.unscheduled') },
  { value: 'hourly', label: t('issues.monitor.hourly') },
  { value: 'daily', label: t('issues.monitor.daily') },
  { value: 'weekly', label: t('issues.monitor.weekly') },
];

/**
 * Painel de relações estilo Paperclip: blocked-by / blocking / sub-issues /
 * reviewers / approvers / monitor. Persiste via canais `issue:*` de relação.
 */
function IssueRelationsPanel({
  issue,
  agents,
  prefix,
}: {
  issue: Issue;
  agents: Agent[];
  prefix: string;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const relQuery = useQuery({
    queryKey: ['issue-relations', issue.id],
    queryFn: () => window.orkestral['issue:get-relations']({ issueId: issue.id }),
  });
  const issuesQuery = useQuery({
    queryKey: ['issues', issue.workspaceId],
    queryFn: () => window.orkestral['issue:list']({ workspaceId: issue.workspaceId }),
  });
  const rel = relQuery.data;
  const refresh = (): void => {
    queryClient.invalidateQueries({ queryKey: ['issue-relations', issue.id] });
  };
  const agentName = (id: string): string =>
    agents.find((a) => a.id === id)?.name ?? t('issues.relations.agent');
  const candidateIssues = (issuesQuery.data ?? []).filter((i) => i.id !== issue.id);

  async function addBlocker(blockerId: string): Promise<void> {
    if (!blockerId) return;
    await window.orkestral['issue:add-dependency']({
      workspaceId: issue.workspaceId,
      blockerIssueId: blockerId,
      blockedIssueId: issue.id,
    });
    refresh();
  }
  async function addBlocking(blockedId: string): Promise<void> {
    if (!blockedId) return;
    await window.orkestral['issue:add-dependency']({
      workspaceId: issue.workspaceId,
      blockerIssueId: issue.id,
      blockedIssueId: blockedId,
    });
    refresh();
  }
  async function removeDep(linkId: string): Promise<void> {
    await window.orkestral['issue:remove-dependency']({ linkId });
    refresh();
  }
  async function addReviewer(agentId: string, role: 'reviewer' | 'approver'): Promise<void> {
    if (!agentId) return;
    await window.orkestral['issue:add-reviewer']({ issueId: issue.id, agentId, role });
    refresh();
  }
  async function removeReviewer(id: string): Promise<void> {
    await window.orkestral['issue:remove-reviewer']({ id });
    refresh();
  }
  async function cycleDecision(id: string, current: 'approved' | 'rejected' | null): Promise<void> {
    const next = current === null ? 'approved' : current === 'approved' ? 'rejected' : null;
    await window.orkestral['issue:set-reviewer-decision']({ id, decision: next });
    refresh();
  }
  async function setMonitor(schedule: string): Promise<void> {
    await window.orkestral['issue:set-monitor']({ issueId: issue.id, schedule: schedule || null });
    refresh();
    queryClient.invalidateQueries({ queryKey: ['issue-by-key'] });
  }

  return (
    <>
      <Field label={t('issues.relations.blockedBy')}>
        <RelationRefs refs={rel?.blockedBy ?? []} prefix={prefix} onRemove={removeDep} />
        <IssuePicker
          placeholder={t('issues.relations.addBlocker')}
          issues={candidateIssues}
          exclude={(rel?.blockedBy ?? []).map((r) => r.id)}
          prefix={prefix}
          onPick={addBlocker}
        />
      </Field>

      <Field label={t('issues.relations.blocking')}>
        <RelationRefs refs={rel?.blocking ?? []} prefix={prefix} onRemove={removeDep} />
        <IssuePicker
          placeholder={t('issues.relations.addBlocking')}
          issues={candidateIssues}
          exclude={(rel?.blocking ?? []).map((r) => r.id)}
          prefix={prefix}
          onPick={addBlocking}
        />
      </Field>

      <Field label={t('issues.relations.reviewers')}>
        <ReviewerRows
          reviewers={rel?.reviewers ?? []}
          agentName={agentName}
          onRemove={removeReviewer}
        />
        <RelAgentPicker
          placeholder={t('issues.relations.addReviewer')}
          agents={agents}
          exclude={(rel?.reviewers ?? []).map((r) => r.agentId)}
          onPick={(id) => addReviewer(id, 'reviewer')}
        />
      </Field>

      <Field label={t('issues.relations.approvers')}>
        <div className="flex flex-col gap-1">
          {(rel?.approvers ?? []).length === 0 && (
            <span className="text-[12px] text-text-muted">{t('issues.relations.none')}</span>
          )}
          {(rel?.approvers ?? []).map((a) => (
            <div key={a.id} className="group flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => cycleDecision(a.id, a.decision)}
                className="flex flex-1 items-center gap-1.5 truncate rounded-md px-1.5 py-1 text-left hover:bg-surface-1"
                title={t('issues.relations.cycleTooltip')}
              >
                <AgentAvatar
                  name={agentName(a.agentId)}
                  size={16}
                  rounded="full"
                  className="ring-0"
                />
                <span className="truncate text-[12px] text-text-secondary">
                  {agentName(a.agentId)}
                </span>
                <DecisionBadge decision={a.decision} />
              </button>
              <button
                type="button"
                onClick={() => removeReviewer(a.id)}
                className="opacity-0 group-hover:opacity-100"
                title={t('issues.relations.remove')}
              >
                <X className="h-3 w-3 text-text-muted hover:text-accent-red" />
              </button>
            </div>
          ))}
        </div>
        <RelAgentPicker
          placeholder={t('issues.relations.addApprover')}
          agents={agents}
          exclude={(rel?.approvers ?? []).map((r) => r.agentId)}
          onPick={(id) => addReviewer(id, 'approver')}
        />
      </Field>

      <Field label={t('issues.relations.monitor')}>
        <ComboSelect
          inline
          value={rel?.monitorSchedule ?? ''}
          placeholder={t('issues.monitor.unscheduled')}
          options={monitorOptions(t)}
          onChange={(v) => setMonitor(v)}
        />
      </Field>
    </>
  );
}

function DecisionBadge({ decision }: { decision: 'approved' | 'rejected' | null }) {
  const { t } = useT();
  if (decision === 'approved') {
    return (
      <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent-green">
        <Check className="h-3 w-3" /> {t('issues.decision.approved')}
      </span>
    );
  }
  if (decision === 'rejected') {
    return (
      <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent-red">
        <X className="h-3 w-3" /> {t('issues.decision.rejected')}
      </span>
    );
  }
  return (
    <span className="ml-auto text-[11px] text-text-faint">{t('issues.decision.pending')}</span>
  );
}

function RelationRefs({
  refs,
  prefix,
  onRemove,
}: {
  refs: Array<{ id: string; issueKey: number; title: string; linkId?: string }>;
  prefix: string;
  onRemove: (linkId: string) => void;
}) {
  const { t } = useT();
  if (refs.length === 0)
    return (
      <span className="text-[12px] text-text-muted">{t('issues.relations.noneFeminine')}</span>
    );
  return (
    <div className="flex flex-col gap-1">
      {refs.map((r) => (
        <div key={r.id} className="group flex items-center gap-1.5">
          <Link
            to={`/issues/${prefix}-${r.issueKey}`}
            className="flex flex-1 items-center gap-1.5 truncate rounded-md px-1.5 py-1 text-[12px] text-text-secondary hover:bg-surface-1 hover:text-text-primary"
            title={r.title}
          >
            <span className="font-mono text-[10.5px] text-text-faint">
              {prefix}-{r.issueKey}
            </span>
            <span className="truncate">{r.title}</span>
          </Link>
          {r.linkId && (
            <button
              type="button"
              onClick={() => onRemove(r.linkId!)}
              className="opacity-0 group-hover:opacity-100"
              title={t('issues.relations.remove')}
            >
              <X className="h-3 w-3 text-text-muted hover:text-accent-red" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function ReviewerRows({
  reviewers,
  agentName,
  onRemove,
}: {
  reviewers: Array<{ id: string; agentId: string }>;
  agentName: (id: string) => string;
  onRemove: (id: string) => void;
}) {
  const { t } = useT();
  if (reviewers.length === 0)
    return <span className="text-[12px] text-text-muted">{t('issues.relations.none')}</span>;
  return (
    <div className="flex flex-col gap-1">
      {reviewers.map((r) => (
        <div key={r.id} className="group flex items-center gap-1.5">
          <AgentAvatar name={agentName(r.agentId)} size={16} rounded="full" className="ring-0" />
          <span className="flex-1 truncate text-[12px] text-text-secondary">
            {agentName(r.agentId)}
          </span>
          <button
            type="button"
            onClick={() => onRemove(r.id)}
            className="opacity-0 group-hover:opacity-100"
            title={t('issues.relations.remove')}
          >
            <X className="h-3 w-3 text-text-muted hover:text-accent-red" />
          </button>
        </div>
      ))}
    </div>
  );
}

function RelAgentPicker({
  placeholder,
  agents,
  exclude,
  onPick,
}: {
  placeholder: string;
  agents: Agent[];
  exclude: string[];
  onPick: (agentId: string) => void;
}) {
  const { t } = useT();
  const available = agents.filter((a) => !exclude.includes(a.id));
  if (available.length === 0) return null;
  return (
    <ComboSelect
      inline
      value=""
      showSelected={false}
      placeholder={placeholder}
      searchPlaceholder={t('issues.relations.searchAgent')}
      options={available.map((a) => ({
        value: a.id,
        label: a.name,
        icon: <AgentAvatar seed={a.avatarSeed} name={a.name} size={16} rounded="full" />,
      }))}
      onChange={(v) => v && onPick(v)}
    />
  );
}

function IssuePicker({
  placeholder,
  issues,
  exclude,
  prefix,
  onPick,
}: {
  placeholder: string;
  issues: Issue[];
  exclude: string[];
  prefix: string;
  onPick: (issueId: string) => void;
}) {
  const { t } = useT();
  const available = issues.filter((i) => !exclude.includes(i.id));
  if (available.length === 0) return null;
  return (
    <ComboSelect
      inline
      value=""
      showSelected={false}
      placeholder={placeholder}
      searchPlaceholder={t('issues.relations.searchIssue')}
      options={available.map((i) => ({
        value: i.id,
        label: `${prefix}-${i.issueKey} · ${i.title.slice(0, 40)}`,
        keywords: i.title,
      }))}
      onChange={(v) => v && onPick(v)}
    />
  );
}

function PropertiesPanel({
  issue,
  agents,
  parent,
  childIssues,
  prefix,
}: {
  issue: Issue;
  agents: Agent[];
  parent: Issue | null;
  childIssues: Issue[];
  prefix: string;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const updateMut = useMutation({
    mutationFn: (patch: IssueUpdatePatch) =>
      window.orkestral['issue:update']({ issueId: issue.id, patch }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue-by-key'] });
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      // Progresso do objetivo é derivado das issues — atualiza a lista de goals.
      queryClient.invalidateQueries({ queryKey: ['goals'] });
    },
  });

  // Objetivos ativos do workspace — pra vincular a issue a um objetivo.
  const goalsQuery = useQuery({
    queryKey: ['goals', issue.workspaceId],
    queryFn: () => window.orkestral['goal:list']({ workspaceId: issue.workspaceId }),
  });
  const goalOptions = [
    {
      value: '',
      label: 'Sem objetivo',
      muted: true,
      icon: <CircleDashed className="h-3.5 w-3.5 text-text-faint" />,
    },
    ...(goalsQuery.data ?? [])
      .filter((g) => g.status === 'active' || g.id === issue.goalId)
      .map((g) => ({
        value: g.id,
        label: g.title,
        icon: <Target className="h-3.5 w-3.5 text-accent-purple" />,
      })),
  ];

  const statusOptions = (Object.keys(STATUS_META) as IssueStatus[]).map((s) => {
    const m = STATUS_META[s];
    return {
      value: s,
      label: statusLabel(t, s),
      icon: <m.Icon className={cn('h-3.5 w-3.5', m.color)} />,
    };
  });
  const priorityOptions = (Object.keys(PRIORITY_META) as IssuePriority[]).map((p) => {
    const m = PRIORITY_META[p];
    return {
      value: p,
      label: priorityLabel(t, p),
      icon: <m.Icon className={cn('h-3.5 w-3.5', m.color)} />,
    };
  });
  const assigneeOptions = [
    {
      value: '',
      label: t('issues.properties.assignPlaceholder'),
      muted: true,
      icon: <CircleDashed className="h-3.5 w-3.5 text-text-faint" />,
    },
    ...agents.map((a) => ({
      value: a.id,
      label: a.name,
      icon: <AgentAvatar seed={a.avatarSeed} name={a.name} size={18} rounded="full" />,
    })),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h2 className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
        {t('issues.properties.title')}
      </h2>

      <Field label={t('issues.properties.status')}>
        <DSSelect
          inline
          value={issue.status}
          options={statusOptions}
          onChange={(v) => updateMut.mutate({ status: v as IssueStatus })}
        />
      </Field>

      <Field label={t('issues.properties.priority')}>
        <DSSelect
          inline
          value={issue.priority}
          options={priorityOptions}
          onChange={(v) => updateMut.mutate({ priority: v as IssuePriority })}
        />
      </Field>

      <Field label={t('issues.properties.assignee')}>
        <DSSelect
          inline
          value={issue.assigneeAgentId ?? ''}
          options={assigneeOptions}
          onChange={(v) => updateMut.mutate({ assigneeAgentId: v === '' ? null : v })}
        />
      </Field>

      <Field label={t('issues.properties.goal')}>
        <DSSelect
          inline
          value={issue.goalId ?? ''}
          options={goalOptions}
          onChange={(v) => updateMut.mutate({ goalId: v === '' ? null : v })}
        />
      </Field>

      {(parent || childIssues.length > 0) && (
        <Field label={t('issues.properties.linkedWork')}>
          <LinkedWorkList
            parent={parent}
            childIssues={childIssues}
            prefix={prefix}
            selfRef={
              issue.childOrdinal != null && parent
                ? `${prefix}-${parent.displayKey ?? parent.issueKey}.${issue.childOrdinal}`
                : `${prefix}-${issue.displayKey ?? issue.issueKey}`
            }
          />
        </Field>
      )}

      {/* Relações estilo Paperclip: blocked-by/blocking/sub-issues/reviewers/approvers/monitor */}
      <IssueRelationsPanel issue={issue} agents={agents} prefix={prefix} />

      <Field label={t('issues.properties.labels')}>
        {issue.labels.length === 0 ? (
          <span className="text-[11.5px] text-text-faint">{t('issues.properties.noLabels')}</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {issue.labels.map((l) => (
              <span
                key={l}
                className="inline-flex rounded border border-hairline-strong bg-surface-hover px-1.5 py-0.5 text-[10px] text-text-secondary"
              >
                {l}
              </span>
            ))}
          </div>
        )}
      </Field>

      <Field label={t('issues.properties.created')}>
        <span className="text-[11.5px] text-text-muted">{formatDateTime(issue.createdAt)}</span>
      </Field>

      <Field label={t('issues.properties.updated')}>
        <span className="text-[11.5px] text-text-muted">{formatDateTime(issue.updatedAt)}</span>
      </Field>

      {issue.completedAt && (
        <Field label={t('issues.properties.completed')}>
          <span className="text-[11.5px] text-text-muted">{formatDateTime(issue.completedAt)}</span>
        </Field>
      )}
    </div>
  );
}

/**
 * Tab "Related work" — listagem completa de parent/sub-issues + criação de
 * nova sub-issue inline. Espelha o painel direito mas com layout vertical
 * e ação clara.
 */
function RelatedTab({
  issue,
  parent,
  childIssues,
  prefix,
}: {
  issue: Issue;
  parent: Issue | null;
  childIssues: Issue[];
  prefix: string;
}) {
  const { t } = useT();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const queryClient = useQueryClient();

  const createSubIssue = useMutation({
    mutationFn: () =>
      window.orkestral['issue:create-full']({
        workspaceId: issue.workspaceId,
        title: title.trim(),
        parentIssueId: issue.id,
        status: 'backlog',
        priority: issue.priority,
        assigneeAgentId: issue.assigneeAgentId,
      }),
    onSuccess: () => {
      setTitle('');
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ['issue-children', issue.id] });
      queryClient.invalidateQueries({ queryKey: ['issues'] });
    },
  });

  return (
    <div className="flex flex-col gap-5">
      {/* Parent */}
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
          {t('issues.related.parentTitle')}
        </h3>
        {parent ? (
          <Link
            to={`/issues/${prefix}-${parent.issueKey}`}
            className="flex items-center gap-2 rounded-md border border-hairline bg-surface-faint px-3 py-2 hover:border-hairline-vivid hover:bg-surface-1"
          >
            <StatusChip status={parent.status} />
            <span className="font-mono text-[11px] text-text-faint">
              {prefix}-{parent.issueKey}
            </span>
            <span className="flex-1 truncate text-[12.5px] text-text-primary">{parent.title}</span>
          </Link>
        ) : (
          <p className="text-[12px] text-text-faint">{t('issues.related.noParent')}</p>
        )}
      </section>

      {/* Sub-issues */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
            {t('issues.related.subIssues')} {childIssues.length > 0 && `(${childIssues.length})`}
          </h3>
          {!creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1 rounded-md border border-hairline-strong bg-surface-hover px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-strong hover:text-text-primary"
            >
              <Plus className="h-3 w-3" />
              {t('issues.related.newSubIssue')}
            </button>
          )}
        </div>

        {creating && (
          <div className="flex items-center gap-2 rounded-md border border-accent-blue/30 bg-accent-blue/[0.04] px-2 py-1.5">
            <input
              autoFocus
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && title.trim()) createSubIssue.mutate();
                if (e.key === 'Escape') {
                  setCreating(false);
                  setTitle('');
                }
              }}
              placeholder={t('issues.related.subIssuePlaceholder')}
              className="flex-1 bg-transparent text-[12px] text-text-primary placeholder:text-text-faint focus:outline-none"
            />
            <button
              type="button"
              onClick={() => createSubIssue.mutate()}
              disabled={!title.trim() || createSubIssue.isPending}
              className="inline-flex h-6 items-center gap-1 rounded border border-accent-blue/40 bg-accent-blue/15 px-2 text-[11px] text-accent-blue disabled:opacity-50"
            >
              {createSubIssue.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                t('issues.related.create')
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setTitle('');
              }}
              className="text-[11px] text-text-muted hover:text-text-primary"
            >
              {t('common.cancel')}
            </button>
          </div>
        )}

        {childIssues.length === 0 && !creating ? (
          <p className="rounded-md border border-dashed border-hairline px-3 py-4 text-center text-[12px] text-text-muted">
            {t('issues.related.noSubIssues')}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {childIssues.map((c) => (
              <EpicChildRow key={c.id} child={c} prefix={prefix} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** Linha de sub-issue no épico com indicador LIVE de execução (P0-10): agrega o
 *  progresso das subissues pro usuário não precisar abrir cada uma. */
function EpicChildRow({ child: c, prefix }: { child: Issue; prefix: string }) {
  const { t } = useT();
  const working = useIssueWorking(c.id);
  return (
    <Link
      to={`/issues/${prefix}-${c.issueKey}`}
      className="group flex items-center gap-2 rounded-md border border-hairline-soft bg-surface-veil px-3 py-1.5 hover:border-hairline-vivid hover:bg-surface-1"
    >
      <CompactStatusDot status={c.status} />
      <span className="font-mono text-[10.5px] text-text-faint">
        {prefix}-{c.issueKey}
      </span>
      <span className="flex-1 truncate text-[12.5px] text-text-primary">{c.title}</span>
      {working && (
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-accent-green">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-green" />
          {t('issues.related.working')}
        </span>
      )}
      <span className={cn('text-[10px]', PRIORITY_META[c.priority].color)}>
        {priorityLabel(t, c.priority)}
      </span>
    </Link>
  );
}

/**
 * Detecta se uma issue está "travada": em `in_progress` mas sem run ativa há
 * mais de STUCK_THRESHOLD_MS. Indica falha silenciosa — o agente não terminou
 * de mover pra `done`/`blocked`, ou o run morreu sem reportar.
 *
 * Inspirado no padrão "RECOVERY NEEDED" do Paperclip (v1).
 */
function detectStuck(
  issue: Issue,
  runs: IssueRun[],
): { lastActivityAt: string; ageMinutes: number } | null {
  if (issue.status !== 'in_progress') return null;
  if (runs.some((r) => r.status === 'running')) return null;
  // Threshold: 2h sem atividade
  const STUCK_THRESHOLD_MS = 2 * 60 * 60_000;
  const lastFinish = runs[0]?.finishedAt ?? issue.updatedAt;
  const ageMs = Date.now() - new Date(lastFinish).getTime();
  if (ageMs < STUCK_THRESHOLD_MS) return null;
  return {
    lastActivityAt: lastFinish,
    ageMinutes: Math.round(ageMs / 60_000),
  };
}

function StuckRecoveryBanner({
  issue,
  stuckInfo,
}: {
  issue: Issue;
  stuckInfo: { lastActivityAt: string; ageMinutes: number };
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    try {
      await window.orkestral['issue:execute']({ issueId: issue.id });
      queryClient.invalidateQueries({ queryKey: ['issue-runs', issue.id] });
      queryClient.invalidateQueries({ queryKey: ['issue-by-key'] });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-accent-yellow/30 bg-accent-yellow/[0.06] px-3 py-2.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-yellow/15">
        <AlertTriangle className="h-3.5 w-3.5 text-accent-yellow" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-accent-yellow">
          {t('issues.stuck.title', { age: humanizeMinutes(stuckInfo.ageMinutes, t) })}
        </div>
        <div className="text-[11.5px] text-text-muted">{t('issues.stuck.body')}</div>
      </div>
      <button
        type="button"
        onClick={retry}
        disabled={busy || !issue.assigneeAgentId}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-accent-yellow/40 bg-accent-yellow/15 px-2.5 text-[11.5px] font-medium text-accent-yellow hover:bg-accent-yellow/25 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
        {t('issues.stuck.resume')}
      </button>
    </div>
  );
}

function humanizeMinutes(minutes: number, t: TFunction): string {
  if (minutes < 60) return t('issues.duration.minutes', { n: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24)
    return m > 0 ? t('issues.duration.hoursMinutes', { h, m }) : t('issues.duration.hours', { h });
  const d = Math.floor(h / 24);
  return t('issues.duration.days', { n: d });
}

/** Status dot compacto pra listagens densas (sub-issues, etc.) */
function CompactStatusDot({ status }: { status: IssueStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.Icon;
  return <Icon className={cn('h-3 w-3 shrink-0', meta.color)} />;
}

/**
 * Linked work compacto: linhas limpas (sem card), uma por relação. Mostra no
 * máximo 3 e, se houver mais, um "ver mais N". Cada linha: bolinha de status +
 * relação + chave + título (truncado, com title no hover).
 */
function LinkedWorkList({
  parent,
  childIssues,
  prefix,
  selfRef,
}: {
  parent: Issue | null;
  childIssues: Issue[];
  prefix: string;
  /** Ref de display da issue atual (ex: EZC-6) — base p/ numerar os filhos. */
  selfRef: string;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const items = [
    ...(parent
      ? [
          {
            rel: t('issues.linkedWork.parent'),
            issue: parent,
            ref: `${prefix}-${parent.displayKey ?? parent.issueKey}`,
          },
        ]
      : []),
    ...childIssues.map((c) => ({
      rel: t('issues.linkedWork.sub'),
      issue: c,
      ref: `${selfRef}.${c.childOrdinal ?? c.issueKey}`,
    })),
  ];
  const visible = expanded ? items : items.slice(0, 3);
  const hidden = items.length - visible.length;

  return (
    <div className="-mx-1.5 flex flex-col gap-0.5">
      {visible.map(({ rel, issue, ref }) => (
        <Link
          key={issue.id}
          to={`/issues/${prefix}-${issue.issueKey}`}
          className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] transition-colors hover:bg-surface-2"
          title={issue.title}
        >
          <CompactStatusDot status={issue.status} />
          <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-text-faint">
            {rel}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-text-faint">{ref}</span>
          <span className="truncate text-text-secondary group-hover:text-text-primary">
            {issue.title}
          </span>
          <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-text-faint opacity-0 transition-opacity group-hover:opacity-100" />
        </Link>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-0.5 w-fit text-[11px] text-text-muted hover:text-text-primary"
        >
          {t('issues.linkedWork.seeMore', { n: hidden })}
        </button>
      )}
      {expanded && items.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-0.5 w-fit text-[11px] text-text-muted hover:text-text-primary"
        >
          {t('issues.linkedWork.seeLess')}
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  // Separator sutil entre seções: borda topo + padding. O primeiro Field
  // (logo após o header "Propriedades") zera a borda via `first:`.
  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-t border-hairline-faint pt-3 first:border-t-0 first:pt-0">
      <span className="text-[10.5px] font-medium uppercase tracking-wider text-text-faint">
        {label}
      </span>
      {children}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Banner que aparece no topo da página enquanto o agente está executando.
 * Mostra última ação + contador de tool calls + animação de loading.
 */
function LiveExecutionBanner({ liveEvents }: { liveEvents: LiveExecEvent[] }) {
  const { t } = useT();
  const toolCalls = liveEvents.filter((e) => e.kind === 'tool-use').length;
  const lastEvent = liveEvents[liveEvents.length - 1];
  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-accent-blue/25 bg-accent-blue/[0.06] px-3 py-2.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-blue/15">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-blue" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-accent-blue">
          {t('issues.live.agentWorking')}
          {toolCalls > 0 && (
            <span className="ml-2 text-text-secondary">
              · {toolCalls}{' '}
              {toolCalls === 1 ? t('issues.live.actionSingular') : t('issues.live.actionPlural')}
            </span>
          )}
        </div>
        {lastEvent && (
          <div className="truncate text-[11.5px] text-text-muted">{lastEvent.label}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Timeline persistida da IA. Mostra passos estruturados da run local, incluindo
 * retrieval, tool calls, fallback e aprendizado.
 */
function AgentTimeline({ events }: { events: AgentTraceEvent[] }) {
  const { t } = useT();
  const recent = events.slice(-40);
  return (
    <div className="rounded-md border border-hairline-faint bg-surface-veil">
      <div className="flex items-center gap-2 border-b border-hairline-soft px-3 py-1.5">
        <span
          className={cn(
            'grid h-1.5 w-1.5 place-items-center rounded-full',
            events.some((e) => e.status === 'started')
              ? 'animate-pulse bg-accent-blue'
              : 'bg-accent-green',
          )}
        />
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-text-faint">
          {t('issues.live.timelineHeader', { n: events.length })}
        </span>
      </div>
      <div className="max-h-[320px] thin-scrollbar overflow-y-auto px-3 py-2">
        {recent.map((event) => (
          <div
            key={event.id}
            className={cn(
              'flex items-start gap-2 py-1.5 text-[11.5px]',
              event.status === 'failed' && 'text-accent-red',
              event.status === 'completed' && 'text-text-secondary',
              event.status === 'started' && 'text-accent-blue',
              event.status === 'skipped' && 'text-text-muted',
            )}
          >
            <span className="mt-0.5 w-[54px] shrink-0 font-mono text-[10px] text-text-faint">
              {formatTimeWithSeconds(new Date(event.startedAt).getTime())}
            </span>
            <span
              className={cn(
                'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                event.status === 'failed' && 'bg-accent-red',
                event.status === 'completed' && 'bg-accent-green',
                event.status === 'started' && 'bg-accent-blue',
                event.status === 'skipped' && 'bg-text-faint',
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-text-secondary">{event.title}</span>
              {event.summary && (
                <span className="mt-0.5 block truncate text-[10.5px] text-text-faint">
                  {event.summary}
                </span>
              )}
            </span>
            {event.durationMs != null && (
              <span className="shrink-0 font-mono text-[10px] text-text-faint">
                {humanDuration(event.durationMs)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Timeline em tempo real das ações do agente — renderiza dentro da tab Chat
 * quando há run rodando. Não persistida (some ao recarregar).
 */
function LiveTimeline({ events }: { events: LiveExecEvent[] }) {
  const { t } = useT();
  // Mostra os últimos 30 eventos pra não estourar a tela
  const recent = events.slice(-30);
  return (
    <div className="rounded-md border border-hairline-faint bg-surface-veil">
      <div className="flex items-center gap-2 border-b border-hairline-soft px-3 py-1.5">
        <span className="grid h-1.5 w-1.5 place-items-center rounded-full bg-accent-blue animate-pulse" />
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-text-faint">
          {t('issues.live.timelineHeader', { n: events.length })}
        </span>
      </div>
      <div className="max-h-[260px] thin-scrollbar overflow-y-auto px-3 py-2">
        {recent.map((e, i) => (
          <div
            key={`${e.at}-${i}`}
            className={cn(
              'flex items-center gap-2 py-1 text-[11.5px]',
              e.kind === 'error' && 'text-accent-red',
              e.kind === 'finished' && 'text-accent-green',
              e.kind === 'queued' && 'text-text-muted',
              e.kind === 'started' && 'text-accent-blue',
              e.kind === 'tool-use' && 'text-text-secondary',
              e.kind === 'file-change' && 'text-accent-green',
              e.kind === 'model-route' && 'text-accent-purple',
              e.kind === 'phase' && 'text-text-muted',
            )}
          >
            <span className="font-mono text-[10px] text-text-faint">
              {formatTimeWithSeconds(e.at)}
            </span>
            <span className="truncate">{e.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function parseIssueKey(input: string): number | null {
  const match = input.match(/(\d+)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

function issuePrefix(workspaceName: string): string {
  return (
    (workspaceName || 'ORK')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'ORK'
  );
}

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs}s`;
}
