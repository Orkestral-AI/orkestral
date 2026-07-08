import { useState, useEffect, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Target, Plus, Trash2, Loader2, Check, Archive, Sparkles, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { DatePicker } from '@renderer/components/ui/date-picker';
import { ConfirmDialog } from '@renderer/components/ui/confirm-dialog';
import { useT, type TFunction } from '@renderer/i18n';
import type { Agent, Goal } from '@shared/types';

export function GoalsPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'achieved' | 'archived'>(
    'all',
  );

  const goalsQuery = useQuery({
    queryKey: ['goals', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['goal:list']({ workspaceId: activeWorkspace!.id }),
  });
  const agentsQuery = useQuery({
    queryKey: ['agents', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: activeWorkspace!.id }),
  });
  // Issues do workspace → contagem por objetivo (folhas, exclui épicas) pro card
  // mostrar "X de Y" e decidir a ação contextual (planejar só quando não há issues).
  const issuesQuery = useQuery({
    queryKey: ['issues', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['issue:list']({ workspaceId: activeWorkspace!.id }),
  });
  const goals = goalsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const allIssues = issuesQuery.data ?? [];
  const statsFor = (goalId: string): { total: number; done: number } => {
    const gi = allIssues.filter((i) => i.goalId === goalId);
    const epicIds = new Set(gi.map((i) => i.parentIssueId).filter(Boolean));
    const leaves = gi.filter((i) => !epicIds.has(i.id));
    return { total: leaves.length, done: leaves.filter((i) => i.status === 'done').length };
  };

  // Real-time: agente fecha issue via MCP → invalida pra barra subir na hora.
  useEffect(() => {
    if (!activeWorkspace) return;
    return window.orkestralEvents.onIssuesChanged((event) => {
      if (event.workspaceId !== activeWorkspace.id) return;
      queryClient.invalidateQueries({ queryKey: ['goals', activeWorkspace.id] });
      queryClient.invalidateQueries({ queryKey: ['issues', activeWorkspace.id] });
    });
  }, [activeWorkspace, queryClient]);

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Parameters<(typeof window.orkestral)['goal:update']>[0]['patch'];
    }) => window.orkestral['goal:update']({ goalId: id, patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goals'] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => window.orkestral['goal:delete']({ goalId: id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goals'] }),
  });

  // Busca (título/descrição) + filtro de status — toolbar no estilo de Issues.
  const q = query.trim().toLowerCase();
  const matchesQuery = (g: Goal): boolean =>
    !q || g.title.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q);
  const visible = goals.filter(matchesQuery);
  const showStatus = (s: 'active' | 'achieved' | 'archived'): boolean =>
    statusFilter === 'all' || statusFilter === s;
  const active = showStatus('active') ? visible.filter((g) => g.status === 'active') : [];
  const achieved = showStatus('achieved') ? visible.filter((g) => g.status === 'achieved') : [];
  const archived = showStatus('archived') ? visible.filter((g) => g.status === 'archived') : [];

  return (
    <PageShell title={t('pages.goals.title')} description={t('pages.goals.description')}>
      {activeWorkspace && !goalsQuery.isPending && (
        // Toolbar no MESMO padrão de Issues: botão (cinza) + busca + filtro de status.
        <div className="flex items-center gap-2 border-b border-hairline-faint px-6 py-2.5">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 text-[12px] font-medium text-text-primary transition-colors hover:bg-surface-2"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('pages.goals.newGoal')}
          </button>
          <div className="relative ml-1 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('pages.goals.searchPlaceholder')}
              className="h-7 w-full rounded-md border border-transparent bg-transparent pl-7 pr-3 text-[12px] text-text-primary placeholder:text-text-muted hover:bg-surface-subtle focus:border-hairline-strong focus:bg-surface-subtle focus:outline-none"
            />
          </div>
          <DSSelect
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as 'all' | 'active' | 'achieved' | 'archived')}
            options={[
              { value: 'all', label: t('pages.goals.filterAll') },
              { value: 'active', label: t('pages.goals.sectionActive') },
              { value: 'achieved', label: t('pages.goals.sectionAchieved') },
              { value: 'archived', label: t('pages.goals.sectionArchived') },
            ]}
            className="h-7 w-36 text-[11.5px]"
          />
        </div>
      )}

      {!activeWorkspace ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.goals.noActiveWorkspace')}
        </div>
      ) : goalsQuery.isPending ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.goals.loading')}
        </div>
      ) : goals.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <Target className="h-8 w-8 text-text-muted" />
          <div className="mt-3 text-[13px] font-medium text-text-primary">
            {t('pages.goals.noGoals')}
          </div>
          <div className="mt-1 max-w-md text-[12px] text-text-muted">
            {t('pages.goals.noGoalsDesc')}
          </div>
        </div>
      ) : active.length === 0 && achieved.length === 0 && archived.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.goals.noResults')}
        </div>
      ) : (
        <div className="thin-scrollbar flex-1 overflow-y-auto px-8 py-6">
          {active.length > 0 && (
            <Section label={t('pages.goals.sectionActive')}>
              <div className="flex flex-col gap-2">
                {active.map((g) => (
                  <GoalCard
                    key={g.id}
                    goal={g}
                    agents={agents}
                    stats={statsFor(g.id)}
                    onUpdate={(patch) => updateMutation.mutate({ id: g.id, patch })}
                    onDelete={() => deleteMutation.mutate(g.id)}
                    t={t}
                  />
                ))}
              </div>
            </Section>
          )}

          {achieved.length > 0 && (
            <Section label={t('pages.goals.sectionAchieved')}>
              <div className="flex flex-col gap-2">
                {achieved.map((g) => (
                  <GoalCard
                    key={g.id}
                    goal={g}
                    agents={agents}
                    stats={statsFor(g.id)}
                    onUpdate={(patch) => updateMutation.mutate({ id: g.id, patch })}
                    onDelete={() => deleteMutation.mutate(g.id)}
                    t={t}
                  />
                ))}
              </div>
            </Section>
          )}

          {archived.length > 0 && (
            <Section label={t('pages.goals.sectionArchived')}>
              <div className="flex flex-col gap-2">
                {archived.map((g) => (
                  <GoalCard
                    key={g.id}
                    goal={g}
                    agents={agents}
                    stats={statsFor(g.id)}
                    onUpdate={(patch) => updateMutation.mutate({ id: g.id, patch })}
                    onDelete={() => deleteMutation.mutate(g.id)}
                    t={t}
                  />
                ))}
              </div>
            </Section>
          )}
        </div>
      )}

      {creating && activeWorkspace && (
        <CreateGoalModal
          workspaceId={activeWorkspace.id}
          agents={agents}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            queryClient.invalidateQueries({ queryKey: ['goals'] });
          }}
        />
      )}
    </PageShell>
  );
}

function GoalCard({
  goal,
  agents,
  stats,
  onUpdate,
  onDelete,
  t,
}: {
  goal: Goal;
  agents: Agent[];
  stats: { total: number; done: number };
  onUpdate: (patch: Parameters<(typeof window.orkestral)['goal:update']>[0]['patch']) => void;
  onDelete: () => void;
  t: TFunction;
}) {
  const owner = agents.find((a) => a.id === goal.ownerAgentId);
  const navigate = useNavigate();
  const [planning, setPlanning] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const open = (): void => {
    navigate(`/goals/${goal.id}`);
  };

  async function planWithCeo(e: React.MouseEvent) {
    e.stopPropagation();
    setPlanning(true);
    try {
      const res = await window.orkestral['goal:plan']({ goalId: goal.id });
      if (res?.sessionId) navigate(`/session/${res.sessionId}`);
    } catch (err) {
      console.error('[goal:plan] erro:', err);
    } finally {
      setPlanning(false);
    }
  }

  async function verifyWithCeo(e: React.MouseEvent) {
    e.stopPropagation();
    setPlanning(true);
    try {
      const res = await window.orkestral['goal:verify']({ goalId: goal.id });
      if (res?.sessionId) navigate(`/session/${res.sessionId}`);
    } catch (err) {
      console.error('[goal:verify] erro:', err);
    } finally {
      setPlanning(false);
    }
  }

  const progress = Math.max(0, Math.min(100, goal.progress));
  const done = progress >= 100;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    // O CARD INTEIRO é clicável (abre o objetivo). Os botões internos param a
    // propagação pra não disparar a navegação junto.
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open();
      }}
      className={cn(
        'group flex cursor-pointer items-start gap-3 rounded-lg border border-hairline-faint bg-surface-veil p-3.5 transition-colors hover:border-border-strong hover:bg-surface-1',
        goal.status === 'achieved' && 'opacity-70',
        goal.status === 'archived' && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          stop(e);
          onUpdate({ status: goal.status === 'achieved' ? 'active' : 'achieved' });
        }}
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors',
          goal.status === 'achieved'
            ? 'border-accent-green bg-accent-green text-black'
            : 'border-hairline-vivid hover:border-white/[0.25]',
        )}
        title={goal.status === 'achieved' ? t('pages.goals.reopen') : t('pages.goals.markAchieved')}
      >
        {goal.status === 'achieved' && <Check className="h-3.5 w-3.5" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-text-primary transition-colors group-hover:text-accent-purple">
          {goal.title}
        </div>
        {/* Reserva 2 linhas (clamp + min-h) pra todos os cards terem mesma altura. */}
        <div className="mt-0.5 line-clamp-2 min-h-[2.6em] text-[11.5px] leading-snug text-text-muted">
          {goal.description}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          {owner && (
            <span className="inline-flex items-center gap-1 rounded bg-surface-1 py-px pl-px pr-1.5 text-[10.5px] text-text-secondary">
              <AgentAvatar
                seed={owner.avatarSeed}
                name={owner.name}
                size={14}
                rounded="full"
                className="ring-0"
              />
              {owner.name}
            </span>
          )}
          {goal.dueDate && (
            <span className="text-[10.5px] text-text-muted">
              {t('pages.goals.dueOn', { date: new Date(goal.dueDate).toLocaleDateString() })}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-1">
              <div
                className="h-full bg-accent-green transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            {/* Progresso é DERIVADO das issues vinculadas — read-only. */}
            <span className="w-9 text-right text-[10.5px] tabular-nums text-text-secondary">
              {progress}%
            </span>
            {stats.total > 0 && (
              <span className="text-[10.5px] text-text-muted">
                · {t('pages.goals.issuesCount', { done: stats.done, total: stats.total })}
              </span>
            )}
          </div>
        </div>
        {/* Ação contextual (só objetivo ativo): planejar APENAS quando ainda não há
            issues (o objetivo existe mas não foi quebrado); verificar quando 100%.
            Com issues em andamento, nenhuma ação — o card abre o painel. */}
        {goal.status === 'active' && done && stats.total > 0 && (
          <div className="mt-3 flex">
            <button
              type="button"
              onClick={verifyWithCeo}
              disabled={planning}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-accent-green/30 bg-accent-green/10 px-2.5 text-[11.5px] font-medium text-accent-green transition-colors hover:bg-accent-green/20 disabled:opacity-50"
              title={t('pages.goals.verifyHint')}
            >
              {planning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {t('pages.goals.verifyCompletion')}
            </button>
          </div>
        )}
        {goal.status === 'active' && stats.total === 0 && (
          <div className="mt-3 flex">
            <button
              type="button"
              onClick={planWithCeo}
              disabled={planning}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-accent-purple/30 bg-accent-purple/10 px-2.5 text-[11.5px] font-medium text-accent-purple transition-colors hover:bg-accent-purple/20 disabled:opacity-50"
              title={t('pages.goals.planHint')}
            >
              {planning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {t('pages.goals.planWithCeo')}
            </button>
          </div>
        )}
      </div>
      {goal.status === 'active' && (
        <button
          type="button"
          onClick={(e) => {
            stop(e);
            onUpdate({ status: 'archived' });
          }}
          className="grid h-7 w-7 place-items-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary"
          title={t('pages.goals.archive')}
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          stop(e);
          setConfirmingDelete(true);
        }}
        className="grid h-7 w-7 place-items-center rounded-md text-text-muted hover:bg-accent-red/10 hover:text-accent-red"
        title={t('pages.goals.delete')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {confirmingDelete && (
        <ConfirmDialog
          title={t('pages.goals.deleteConfirm', { title: goal.title })}
          body={t('pages.goals.deleteBody')}
          confirmLabel={t('pages.goals.delete')}
          cancelLabel={t('pages.goals.cancel')}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            onDelete();
          }}
        />
      )}
    </div>
  );
}

export function CreateGoalModal({
  workspaceId,
  agents,
  onClose,
  onCreated,
  parentGoalId,
}: {
  workspaceId: string;
  agents: Agent[];
  onClose: () => void;
  onCreated: () => void;
  parentGoalId?: string | null;
}) {
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ownerAgentId, setOwnerAgentId] = useState('');
  const [dueDate, setDueDate] = useState('');

  const createMutation = useMutation({
    mutationFn: () =>
      window.orkestral['goal:create']({
        workspaceId,
        title,
        description: description || null,
        ownerAgentId: ownerAgentId || null,
        dueDate: dueDate || null,
        parentGoalId: parentGoalId ?? null,
      }),
    onSuccess: onCreated,
  });

  const valid = title.trim().length >= 2;
  return (
    <div
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties
      }
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: 0,
          width: '100%',
          maxWidth: 560,
        }}
        className="overflow-hidden bg-dialog"
      >
        <div className="border-b border-hairline px-5 py-3 text-[14px] font-semibold tracking-tight">
          {parentGoalId ? t('pages.goals.newSubGoal') : t('pages.goals.createTitle')}
        </div>
        <div className="flex flex-col gap-4 p-5">
          <Field label={t('pages.goals.fieldTitle')}>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('pages.goals.titlePlaceholder')}
              className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-hairline-strong"
            />
          </Field>
          <Field label={t('pages.goals.fieldDescription')}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={10}
              className="min-h-[240px] w-full resize-y rounded-md border border-hairline-strong bg-surface-subtle p-3 text-[12.5px] text-text-primary focus:outline-none focus:ring-1 focus:ring-hairline-strong"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('pages.goals.fieldOwner')}>
              <DSSelect
                value={ownerAgentId}
                onChange={setOwnerAgentId}
                options={[
                  { value: '', label: t('pages.goals.assignOwner'), muted: true },
                  ...agents.map((a) => ({
                    value: a.id,
                    label: a.name,
                    icon: (
                      <AgentAvatar seed={a.avatarSeed} name={a.name} size={18} rounded="full" />
                    ),
                  })),
                ]}
              />
            </Field>
            <Field label={t('pages.goals.fieldDueDate')}>
              <DatePicker value={dueDate} onChange={setDueDate} />
            </Field>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[12.5px] text-text-secondary hover:bg-surface-2"
          >
            {t('pages.goals.cancel')}
          </button>
          <button
            type="button"
            disabled={!valid || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
          >
            {createMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {t('pages.goals.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-text-faint">
        {label}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium text-text-primary">{label}</label>
      {children}
    </div>
  );
}

function PageShell({
  title,
  description,
  toolbar,
  children,
}: {
  title: string;
  description: string;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <div className="window-drag flex items-start justify-between gap-3 border-b border-hairline-soft px-8 py-5">
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">{title}</h1>
            <p className="mt-0.5 text-[12.5px] text-text-muted">{description}</p>
          </div>
          <div className="window-no-drag">{toolbar}</div>
        </div>
        {children}
      </div>
    </div>
  );
}
