import { useState, useEffect, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Repeat, Plus, Trash2, Play, Loader2, Save } from 'lucide-react';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { useT, type TFunction } from '@renderer/i18n';
import type { Agent, Routine } from '@shared/types';

export function RoutinesPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const routinesQuery = useQuery({
    queryKey: ['routines', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['routine:list']({ workspaceId: activeWorkspace!.id }),
  });
  const agentsQuery = useQuery({
    queryKey: ['agents', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: activeWorkspace!.id }),
  });
  const routines = routinesQuery.data ?? [];
  const agents = agentsQuery.data ?? [];

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      window.orkestral['routine:update']({ routineId: id, patch: { enabled } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routines'] }),
  });
  const runNowMutation = useMutation({
    mutationFn: (id: string) => window.orkestral['routine:run-now']({ routineId: id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routines'] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => window.orkestral['routine:delete']({ routineId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routines'] });
      setSelectedId(null);
    },
  });

  const selected = routines.find((r) => r.id === selectedId);

  return (
    <PageShell
      title={t('pages.routines.title')}
      description={t('pages.routines.description')}
      toolbar={
        <button
          type="button"
          onClick={() => {
            setSelectedId(null);
            setCreating(true);
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-[12px] font-medium text-black hover:bg-white/90"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('pages.routines.newRoutine')}
        </button>
      }
    >
      {!activeWorkspace ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.routines.noActiveWorkspace')}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex w-80 shrink-0 flex-col border-r border-hairline-faint">
            <div className="thin-scrollbar flex-1 overflow-y-auto p-2">
              {routinesQuery.isPending ? (
                <div className="px-3 py-3 text-[12px] text-text-muted">
                  {t('pages.routines.loading')}
                </div>
              ) : routines.length === 0 ? (
                <div className="px-3 py-3 text-[12px] text-text-muted">
                  {t('pages.routines.noRoutines')}
                </div>
              ) : (
                routines.map((r) => (
                  <RoutineRow
                    key={r.id}
                    routine={r}
                    agent={agents.find((a) => a.id === r.agentId)}
                    active={r.id === selectedId}
                    onClick={() => {
                      setCreating(false);
                      setSelectedId(r.id);
                    }}
                    onToggle={(enabled) => toggleMutation.mutate({ id: r.id, enabled })}
                    onRunNow={() => runNowMutation.mutate(r.id)}
                    t={t}
                  />
                ))
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {creating ? (
              <RoutineEditor
                agents={agents}
                workspaceId={activeWorkspace.id}
                onSaved={(r) => {
                  queryClient.invalidateQueries({ queryKey: ['routines'] });
                  setCreating(false);
                  setSelectedId(r.id);
                }}
              />
            ) : selected ? (
              <RoutineEditor
                key={selected.id}
                agents={agents}
                workspaceId={activeWorkspace.id}
                routine={selected}
                onSaved={() => queryClient.invalidateQueries({ queryKey: ['routines'] })}
                onDelete={() => {
                  if (confirm(t('pages.routines.deleteConfirm', { name: selected.name }))) {
                    deleteMutation.mutate(selected.id);
                  }
                }}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
                {t('pages.routines.selectOrCreate')}
              </div>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}

function RoutineRow({
  routine,
  agent,
  active,
  onClick,
  onToggle,
  onRunNow,
  t,
}: {
  routine: Routine;
  agent?: Agent;
  active: boolean;
  onClick: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  t: TFunction;
}) {
  return (
    <div
      className={cn(
        'mb-1.5 rounded-md border border-hairline-faint bg-surface-faint p-2.5 transition-colors',
        active && 'border-hairline-vivid bg-surface-2',
      )}
    >
      <button type="button" onClick={onClick} className="w-full text-left">
        <div className="flex items-start gap-2">
          <Repeat className="mt-0.5 h-3.5 w-3.5 text-text-muted" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium text-text-primary">
              {routine.name}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-text-muted">
              {agent && (
                <>
                  <AgentAvatar seed={agent.avatarSeed} name={agent.name} size={10} />
                  <span>{agent.name}</span>
                  <span>·</span>
                </>
              )}
              <span>{routine.intervalMinutes}min</span>
              {routine.lastRunAt && (
                <>
                  <span>·</span>
                  <span>
                    {t('pages.routines.last', { time: fmtRelative(routine.lastRunAt, t) })}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </button>
      <div className="mt-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => onToggle(!routine.enabled)}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded px-2 text-[10.5px] font-medium transition-colors',
            routine.enabled
              ? 'bg-accent-green/15 text-accent-green'
              : 'bg-surface-2 text-text-muted hover:text-text-primary',
          )}
        >
          {routine.enabled ? t('pages.routines.active') : t('pages.routines.paused')}
        </button>
        <button
          type="button"
          onClick={onRunNow}
          className="inline-flex h-6 items-center gap-1 rounded bg-surface-2 px-2 text-[10.5px] text-text-secondary hover:bg-surface-strong hover:text-text-primary"
          title={t('pages.routines.runNow')}
        >
          <Play className="h-2.5 w-2.5" />
          {t('pages.routines.run')}
        </button>
      </div>
    </div>
  );
}

function RoutineEditor({
  agents,
  workspaceId,
  routine,
  onSaved,
  onDelete,
}: {
  agents: Agent[];
  workspaceId: string;
  routine?: Routine;
  onSaved: (r: Routine) => void;
  onDelete?: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(routine?.name ?? '');
  const [description, setDescription] = useState(routine?.description ?? '');
  const [agentId, setAgentId] = useState(routine?.agentId ?? agents[0]?.id ?? '');
  const [intervalMinutes, setIntervalMinutes] = useState(routine?.intervalMinutes ?? 60);
  const [prompt, setPrompt] = useState(routine?.prompt ?? t('pages.routines.defaultPrompt'));
  const [enabled, setEnabled] = useState(routine?.enabled ?? false);

  useEffect(() => {
    if (!routine && agents[0] && !agentId) {
      const frame = requestAnimationFrame(() => setAgentId(agents[0].id));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [agents, routine, agentId]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (routine) {
        return window.orkestral['routine:update']({
          routineId: routine.id,
          patch: {
            name,
            description: description || null,
            prompt,
            intervalMinutes: Math.max(1, intervalMinutes),
            enabled,
            agentId,
          },
        });
      }
      return window.orkestral['routine:create']({
        workspaceId,
        agentId,
        name,
        description: description || null,
        prompt,
        intervalMinutes: Math.max(1, intervalMinutes),
        enabled,
      });
    },
    onSuccess: (r) => onSaved(r),
  });

  const valid = name.trim().length >= 2 && agentId && prompt.trim().length > 5;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-hairline-faint px-6 py-4">
        <div>
          <h2 className="text-[16px] font-semibold tracking-tight text-text-primary">
            {routine ? routine.name : t('pages.routines.newRoutineTitle')}
          </h2>
          {routine && (
            <div className="mt-0.5 text-[11px] text-text-muted">
              {t('pages.routines.lastRun', {
                time: routine.lastRunAt
                  ? fmtRelative(routine.lastRunAt, t)
                  : t('pages.routines.never'),
              })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!valid || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-[12.5px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t('common.save')}
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="grid h-8 w-8 place-items-center rounded-md text-text-muted hover:bg-accent-red/10 hover:text-accent-red"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="thin-scrollbar flex-1 overflow-y-auto px-6 py-5">
        <Field label={t('pages.routines.fieldName')}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('pages.routines.namePlaceholder')}
            className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-hairline-strong"
          />
        </Field>
        <div className="mt-4">
          <Field label={t('pages.routines.fieldDescription')}>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('pages.routines.descPlaceholder')}
              className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-hairline-strong"
            />
          </Field>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label={t('pages.routines.fieldAgent')}>
            <DSSelect
              value={agentId}
              onChange={setAgentId}
              options={agents.map((a) => ({ value: a.id, label: a.name }))}
            />
          </Field>
          <Field label={t('pages.routines.fieldInterval')}>
            <input
              type="number"
              min={1}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Math.max(1, Number(e.target.value) || 1))}
              className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-hairline-strong"
            />
          </Field>
        </div>
        <div className="mt-4">
          <Field label={t('pages.routines.fieldPrompt')} hint={t('pages.routines.promptHint')}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              spellCheck={false}
              className="thin-scrollbar min-h-[240px] w-full rounded-md border border-hairline-strong bg-surface-faint p-3 font-mono text-[12.5px] leading-relaxed text-text-primary focus:outline-none focus:ring-1 focus:ring-hairline-strong"
            />
          </Field>
        </div>
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className="flex items-center gap-3 text-left"
          >
            <div
              className={cn(
                'relative h-5 w-9 rounded-full transition-colors',
                enabled ? 'bg-accent-green' : 'bg-surface-strong',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
                  enabled ? 'left-[18px]' : 'left-0.5',
                )}
              />
            </div>
            <div>
              <div className="text-[12.5px] font-medium text-text-primary">
                {enabled ? t('pages.routines.active') : t('pages.routines.paused')}
              </div>
              <div className="text-[11px] text-text-muted">
                {enabled ? t('pages.routines.enabledDesc') : t('pages.routines.disabledDesc')}
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium text-text-primary">{label}</label>
      {children}
      {hint && <span className="text-[11px] text-text-muted">{hint}</span>}
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

function fmtRelative(iso: string, t: TFunction): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return t('pages.routines.relNow');
    if (mins < 60) return `${mins}min`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  } catch {
    return iso;
  }
}
