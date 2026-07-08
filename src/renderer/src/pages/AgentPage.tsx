import { useState, useMemo, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Play,
  Pause,
  Heart,
  Plus,
  MoreHorizontal,
  Copy,
  RotateCcw,
  Sparkles,
  Wand2,
  Cog,
  Activity,
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  ShieldOff,
  Loader2,
  Save,
  Trash2,
  AlertCircle,
  ChevronRight,
  MessageSquare,
  GitPullRequest,
  ListTodo,
  CircleDot,
  CircleDashed,
  Circle,
  CircleCheck,
  CircleSlash,
  CircleAlert,
  CircleMinus,
  User,
  Cpu,
  Sliders,
  CalendarClock,
  ShieldHalf,
  KeyRound,
  Search,
  Zap,
  ShieldAlert,
  Terminal,
  Users,
  ClipboardList,
  FileEdit,
  Server,
  Check,
  X,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { ProviderIcon, providerLabel } from '@renderer/components/ProviderIcon';
import type {
  Agent,
  AdapterType,
  AgentInstructionFile,
  AgentApiKey,
  AgentRuntimeConfig,
  AgentActivityItem,
  AgentActivityKind,
  AgentActivityStatus,
  Issue,
  IssueStatus,
  Skill,
  SkillKind,
} from '@shared/types';
import { Link } from 'react-router-dom';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { AvatarPicker } from '@renderer/components/agents/AvatarPicker';
import { AgentActivityTimeline } from '@renderer/components/audit/AgentActivityTimeline';
import { useT, type TFunction } from '@renderer/i18n';

type TabId = 'dashboard' | 'issues' | 'instructions' | 'skills' | 'configuration' | 'runs';

function buildTabs(t: TFunction): Array<{ id: TabId; label: string; icon: typeof Sparkles }> {
  return [
    { id: 'dashboard', label: t('agents.page.tabs.dashboard'), icon: Activity },
    { id: 'issues', label: t('agents.page.tabs.issues'), icon: ListTodo },
    { id: 'instructions', label: t('agents.page.tabs.instructions'), icon: FileText },
    { id: 'skills', label: t('agents.page.tabs.skills'), icon: Wand2 },
    { id: 'configuration', label: t('agents.page.tabs.configuration'), icon: Cog },
    { id: 'runs', label: t('agents.page.tabs.runs'), icon: Sparkles },
  ];
}

export function AgentPage() {
  const { t } = useT();
  const { agentId } = useParams<{ agentId: string }>();
  const [tab, setTab] = useState<TabId>('dashboard');
  const queryClient = useQueryClient();
  const tabs = buildTabs(t);

  const agentQuery = useQuery({
    queryKey: ['agent', agentId],
    enabled: !!agentId,
    queryFn: () => window.orkestral['agent:get']({ agentId: agentId! }),
  });

  const agent = agentQuery.data ?? null;

  const pauseMutation = useMutation({
    mutationFn: (id: string) => window.orkestral['agent:pause']({ agentId: id }),
    onSuccess: (a) => {
      queryClient.setQueryData(['agent', a.id], a);
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  const resumeMutation = useMutation({
    mutationFn: (id: string) => window.orkestral['agent:resume']({ agentId: id }),
    onSuccess: (a) => {
      queryClient.setQueryData(['agent', a.id], a);
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  const heartbeatMutation = useMutation({
    mutationFn: (id: string) => window.orkestral['agent:run-heartbeat']({ agentId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['heartbeat-runs'] });
      queryClient.invalidateQueries({ queryKey: ['heartbeat-stats'] });
    },
  });
  const resetSessionsMutation = useMutation({
    mutationFn: (id: string) => window.orkestral['agent:reset-sessions']({ agentId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => window.orkestral['agent:delete']({ agentId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      window.location.hash = '#/agents';
    },
  });

  if (agentQuery.isPending) {
    return (
      <PageShell>
        <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
          {t('agents.page.loading')}
        </div>
      </PageShell>
    );
  }

  if (!agent) {
    return (
      <PageShell>
        <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
          {t('agents.page.notFound')}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="flex h-full flex-col overflow-hidden">
        <AgentHeader
          agent={agent}
          onPause={() => pauseMutation.mutate(agent.id)}
          onResume={() => resumeMutation.mutate(agent.id)}
          onRunHeartbeat={() => heartbeatMutation.mutate(agent.id)}
          onCopyId={() => {
            navigator.clipboard.writeText(agent.id).catch(() => undefined);
          }}
          onResetSessions={() => {
            if (confirm(t('agents.page.header.resetSessionsConfirm'))) {
              resetSessionsMutation.mutate(agent.id);
            }
          }}
          onDelete={() => {
            if (confirm(t('agents.page.header.deleteConfirm', { name: agent.name }))) {
              deleteMutation.mutate(agent.id);
            }
          }}
          heartbeatBusy={heartbeatMutation.isPending}
          busy={pauseMutation.isPending || resumeMutation.isPending}
        />

        <div className="border-b border-hairline px-8">
          <div className="flex items-center gap-6 overflow-x-auto">
            {tabs.map((tabItem) => {
              const Icon = tabItem.icon;
              const active = tab === tabItem.id;
              return (
                <button
                  key={tabItem.id}
                  type="button"
                  onClick={() => setTab(tabItem.id)}
                  className={cn(
                    'flex h-10 items-center gap-1.5 border-b-2 px-1 text-[13px] transition-colors',
                    active
                      ? 'border-text-primary text-text-primary'
                      : 'border-transparent text-text-muted hover:text-text-primary',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tabItem.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          className={cn(
            'min-h-0 flex-1',
            // A aba Configuração tem scroll PRÓPRIO (nav de âncoras fixa + form rolável),
            // então ela sai do scroll/padding externo; as outras mantêm o padrão.
            tab === 'configuration' ? 'overflow-hidden' : 'overflow-y-auto px-8 py-6',
          )}
        >
          {tab === 'dashboard' && <DashboardTab agent={agent} />}
          {tab === 'issues' && <IssuesAssignedTab agent={agent} />}
          {tab === 'instructions' && <InstructionsTab agent={agent} />}
          {tab === 'skills' && <SkillsTab agent={agent} />}
          {tab === 'configuration' && <ConfigurationTab agent={agent} />}
          {tab === 'runs' && <RunsTab agent={agent} />}
        </div>
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function AgentHeader({
  agent,
  onPause,
  onResume,
  onRunHeartbeat,
  onCopyId,
  onResetSessions,
  onDelete,
  heartbeatBusy,
  busy,
}: {
  agent: Agent;
  onPause: () => void;
  onResume: () => void;
  onRunHeartbeat: () => void;
  onCopyId: () => void;
  onResetSessions: () => void;
  onDelete: () => void;
  heartbeatBusy: boolean;
  busy: boolean;
}) {
  const { t } = useT();
  // Status efetivo: se há atividade `running` (chat/heartbeat/issue exec),
  // mostramos "Trabalhando" mesmo que `agent.status` esteja como 'idle' no
  // DB. Isso reflete o estado real do agente sem precisar sincronizar
  // toda mudança de run com o status persistido.
  const activityQuery = useQuery({
    queryKey: ['agent-activity-summary', agent.id],
    queryFn: () => window.orkestral['agent:get-activity']({ agentId: agent.id, limit: 10 }),
    refetchInterval: 4000,
  });
  const hasActiveRun = (activityQuery.data ?? []).some(
    (a) => a.status === 'running' || a.status === 'queued',
  );
  const isPaused = agent.status === 'paused';
  const effectiveStatusKey: Agent['status'] =
    isPaused || agent.status === 'error' ? agent.status : hasActiveRun ? 'live' : agent.status;
  const statusInfo = STATUS[effectiveStatusKey] ?? STATUS.idle;
  const statusLabel = t(`agents.page.status.${effectiveStatusKey}`);
  const isLive = effectiveStatusKey === 'live';

  return (
    <div className="window-drag flex items-start gap-4 border-b border-hairline-soft px-8 py-6">
      <div className="window-no-drag shrink-0">
        <AgentAvatarEditor agent={agent} />
      </div>
      <div className="window-no-drag min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-[20px] font-semibold tracking-tight text-text-primary">
            {agent.name}
          </h1>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider',
              statusInfo.cls,
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', statusInfo.dot)} />
            {isLive ? t('agents.page.header.working') : statusLabel}
            {isPaused && agent.pauseReason && (
              <span className="ml-1 opacity-70">· {agent.pauseReason}</span>
            )}
          </span>
          {agent.isOrchestrator && (
            <span className="inline-flex items-center rounded-full border border-hairline-strong bg-surface-hover px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-text-secondary">
              {t('agents.page.header.orchestrator')}
            </span>
          )}
        </div>
        <div className="mt-1 text-[12.5px] text-text-muted">
          {agent.title || agent.role}
          {agent.adapterType && (
            <>
              {' · '}
              <span className="inline-flex items-center gap-1 align-middle">
                <ProviderIcon provider={agent.adapterType} className="h-3 w-3" />
                {providerLabel(agent.adapterType)}
              </span>
            </>
          )}
          {agent.model && agent.model !== 'default' && (
            <>
              {' · '}
              <span className="font-mono">{agent.model}</span>
            </>
          )}
        </div>
      </div>
      <div className="window-no-drag flex items-center gap-2">
        <AssignTaskButton agent={agent} />
        {!isPaused && (
          <HeaderAction
            icon={Heart}
            label={t('agents.page.header.runHeartbeat')}
            onClick={onRunHeartbeat}
            busy={heartbeatBusy}
          />
        )}
        {isPaused ? (
          <HeaderAction
            icon={Play}
            label={t('agents.page.header.resume')}
            primary
            onClick={onResume}
            busy={busy}
          />
        ) : (
          <HeaderAction
            icon={Pause}
            label={t('agents.page.header.pause')}
            onClick={onPause}
            busy={busy}
          />
        )}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="grid h-8 w-8 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
              title={t('agents.page.header.more')}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52 p-1">
            <MenuItem icon={Copy} label={t('agents.page.header.copyAgentId')} onClick={onCopyId} />
            <MenuItem
              icon={RotateCcw}
              label={t('agents.page.header.resetSessions')}
              onClick={onResetSessions}
            />
            <div className="my-1 h-px bg-surface-2" />
            <MenuItem
              icon={Trash2}
              label={t('agents.page.header.deleteAgent')}
              destructive
              onClick={onDelete}
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

/**
 * Header do AgentPage usa esse wrapper: avatar clicável que abre o
 * AvatarPicker. Persiste a seed via `agent:update`. Optimistic update
 * pra UI atualizar antes do round-trip.
 */
function AgentAvatarEditor({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const updateMutation = useMutation({
    mutationFn: (seed: string) =>
      window.orkestral['agent:update']({
        agentId: agent.id,
        patch: { avatarSeed: seed },
      }),
    onMutate: async (seed) => {
      // Optimistic — substitui no cache local
      queryClient.setQueryData<Agent | null>(['agent', agent.id], (prev) =>
        prev ? { ...prev, avatarSeed: seed } : prev,
      );
    },
    onSuccess: (next) => {
      queryClient.setQueryData(['agent', agent.id], next);
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  return (
    <AvatarPicker
      seed={agent.avatarSeed}
      name={agent.name}
      size={48}
      onChange={(seed) => updateMutation.mutate(seed)}
    />
  );
}

function AssignTaskButton({ agent }: { agent: Agent }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');

  const createMutation = useMutation({
    mutationFn: () =>
      window.orkestral['issue:create-full']({
        workspaceId: agent.workspaceId,
        title,
        priority,
        assigneeAgentId: agent.id,
        status: 'todo',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      setTitle('');
      setOpen(false);
    },
  });

  return (
    <>
      <HeaderAction
        icon={Plus}
        label={t('agents.page.assignTask.button')}
        onClick={() => setOpen(true)}
      />
      {open &&
        createPortal(
          <div
            style={
              {
                position: 'fixed',
                inset: 0,
                zIndex: 9999,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'center',
                padding: 96,
                background: 'rgba(0,0,0,0.55)',
                backdropFilter: 'blur(4px)',
                WebkitBackdropFilter: 'blur(4px)',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties
            }
            onClick={(e) => e.target === e.currentTarget && setOpen(false)}
          >
            <div
              style={{
                background: 'var(--color-dialog)',
                border: '1px solid var(--color-hairline-strong)',
                borderRadius: 12,
                width: '100%',
                maxWidth: 460,
              }}
              className="overflow-hidden"
            >
              <div className="border-b border-hairline px-5 py-3 text-[14px] font-semibold tracking-tight">
                {t('agents.page.assignTask.dialogTitle', { name: agent.name })}
              </div>
              <div className="flex flex-col gap-3 p-5">
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('agents.page.assignTask.placeholder')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && title.trim()) createMutation.mutate();
                    if (e.key === 'Escape') setOpen(false);
                  }}
                  className="h-10 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-hairline-strong"
                />
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] text-text-muted">
                    {t('agents.page.assignTask.priorityLabel')}
                  </span>
                  {(['low', 'medium', 'high', 'critical'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={cn(
                        'rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider transition-colors',
                        priority === p
                          ? 'bg-white text-black'
                          : 'bg-surface-1 text-text-muted hover:bg-surface-4 hover:text-text-primary',
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-8 items-center rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[12.5px] text-text-secondary hover:bg-surface-2"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={!title.trim() || createMutation.isPending}
                  onClick={() => createMutation.mutate()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-[12.5px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
                >
                  {createMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  {t('agents.page.assignTask.create')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  destructive,
  onClick,
}: {
  icon: typeof Sparkles;
  label: string;
  destructive?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors',
        destructive
          ? 'text-accent-red hover:bg-accent-red/10'
          : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
      )}
    >
      <Icon className="h-3.5 w-3.5 opacity-80" />
      {label}
    </button>
  );
}

function HeaderAction({
  icon: Icon,
  label,
  primary,
  busy,
  onClick,
}: {
  icon: typeof Sparkles;
  label: string;
  primary?: boolean;
  busy?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50',
        primary
          ? 'border-hairline-ultra bg-white text-black hover:bg-white/90'
          : 'border-hairline-strong bg-surface-subtle text-text-secondary hover:bg-surface-2 hover:text-text-primary',
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

const STATUS: Record<Agent['status'], { cls: string; dot: string }> = {
  idle: {
    cls: 'border border-hairline-strong bg-surface-hover text-text-secondary',
    dot: 'bg-text-muted',
  },
  live: {
    cls: 'border border-accent-green/30 bg-accent-green/10 text-accent-green',
    dot: 'bg-accent-green animate-pulse-dot',
  },
  paused: {
    cls: 'border border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow',
    dot: 'bg-accent-yellow',
  },
  error: {
    cls: 'border border-accent-red/30 bg-accent-red/10 text-accent-red',
    dot: 'bg-accent-red',
  },
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function DashboardTab({ agent }: { agent: Agent }) {
  const { t } = useT();
  const statsQuery = useQuery({
    queryKey: ['agent-activity-stats', agent.id],
    queryFn: () => window.orkestral['agent:get-activity-stats']({ agentId: agent.id, days: 14 }),
    refetchInterval: 15_000,
  });
  const stats = statsQuery.data;

  const successRate =
    stats && stats.successRate !== null ? `${Math.round(stats.successRate * 100)}%` : '—';

  // Breakdown helper — "12 (5 chat · 4 review · 3 hb)"
  const breakdown =
    stats && stats.total > 0
      ? [
          stats.byKind.issue ? `${stats.byKind.issue} issue` : null,
          stats.byKind.chat ? `${stats.byKind.chat} chat` : null,
          stats.byKind['code-review'] ? `${stats.byKind['code-review']} review` : null,
          stats.byKind.heartbeat ? `${stats.byKind.heartbeat} hb` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <StatCard
          label={t('agents.dashboard.stats.runs14d')}
          value={String(stats?.total ?? 0)}
          hint={breakdown ?? undefined}
        />
        <StatCard label={t('agents.dashboard.stats.successRate')} value={successRate} />
        <StatCard
          label={t('agents.dashboard.stats.avgTime')}
          value={stats?.avgDurationMs ? fmtDuration(stats.avgDurationMs) : '—'}
        />
        <StatCard
          label={t('agents.dashboard.stats.lastHeartbeat')}
          value={agent.lastHeartbeatAt ? fmtRelative(agent.lastHeartbeatAt, t) : '—'}
        />
      </div>

      <Section title={t('agents.audit.sectionTitle')} hint={t('agents.audit.sectionHint')}>
        <AgentActivityTimeline agent={agent} />
      </Section>

      <Section
        title={t('agents.dashboard.permissions.title')}
        hint={t('agents.dashboard.permissions.hint')}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <PermissionRow
            label={t('agents.dashboard.permissions.createAgents')}
            granted={agent.canCreateAgents}
          />
          <PermissionRow
            label={t('agents.dashboard.permissions.assignTasks')}
            granted={agent.canAssignTasks}
          />
          <PermissionRow
            label={t('agents.dashboard.permissions.editFiles')}
            granted={agent.canEditFiles}
          />
          <PermissionRow
            label={t('agents.dashboard.permissions.runCommands')}
            granted={agent.canRunCommands}
          />
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Instructions — file browser + editor
// ---------------------------------------------------------------------------

function InstructionsTab({ agent }: { agent: Agent }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [initial, setInitial] = useState<string>('');
  const [creatingFile, setCreatingFile] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const filesQuery = useQuery({
    queryKey: ['agent', agent.id, 'instructions'],
    queryFn: () => window.orkestral['agent:list-instructions']({ agentId: agent.id }),
  });
  const files = useMemo(() => filesQuery.data ?? [], [filesQuery.data]);

  useEffect(() => {
    if (!selectedFile && files.length > 0) {
      const entry = files.find((f) => f.isEntry) ?? files[0];
      const frame = requestAnimationFrame(() => setSelectedFile(entry.name));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [files, selectedFile]);

  const contentQuery = useQuery({
    queryKey: ['agent', agent.id, 'instruction', selectedFile],
    enabled: !!selectedFile,
    queryFn: () =>
      window.orkestral['agent:read-instruction']({
        agentId: agent.id,
        fileName: selectedFile!,
      }),
  });

  useEffect(() => {
    if (contentQuery.data) {
      const content = contentQuery.data.content;
      const frame = requestAnimationFrame(() => {
        setDraft(content);
        setInitial(content);
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [contentQuery.data, selectedFile]);

  const saveMutation = useMutation({
    mutationFn: () =>
      window.orkestral['agent:write-instruction']({
        agentId: agent.id,
        fileName: selectedFile!,
        content: draft,
      }),
    onSuccess: () => {
      setInitial(draft);
      queryClient.invalidateQueries({ queryKey: ['agent', agent.id, 'instructions'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (fileName: string) =>
      window.orkestral['agent:delete-instruction']({ agentId: agent.id, fileName }),
    onSuccess: () => {
      setSelectedFile(null);
      setDraft('');
      setInitial('');
      queryClient.invalidateQueries({ queryKey: ['agent', agent.id, 'instructions'] });
    },
  });

  const createMutation = useMutation({
    mutationFn: (fileName: string) =>
      window.orkestral['agent:write-instruction']({
        agentId: agent.id,
        fileName,
        content: `# ${fileName.replace(/\.(md|markdown|txt|yaml|yml|json)$/i, '')}\n\n`,
      }),
    onSuccess: (file) => {
      setSelectedFile(file.name);
      setCreatingFile(false);
      setCreateError(null);
      queryClient.invalidateQueries({ queryKey: ['agent', agent.id, 'instructions'] });
    },
    onError: (err) => {
      setCreateError(err instanceof Error ? err.message : String(err));
    },
  });

  const dirty = draft !== initial;
  const selected = files.find((f) => f.name === selectedFile);

  return (
    <div className="flex h-[calc(100vh-260px)] min-h-[420px] overflow-hidden rounded-lg border border-hairline-faint bg-surface-whisper">
      {/* File browser */}
      <div className="flex w-56 shrink-0 flex-col border-r border-hairline-faint">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-text-faint">
            {t('agents.instructions.files')}
          </span>
          <button
            type="button"
            onClick={() => {
              setCreatingFile(true);
              setCreateError(null);
            }}
            className="grid h-5 w-5 place-items-center rounded text-text-faint transition-colors hover:bg-surface-2 hover:text-text-primary"
            title={t('agents.instructions.createFile')}
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
        <div className="thin-scrollbar flex-1 overflow-y-auto px-1.5 pb-1.5">
          {filesQuery.isPending ? (
            <div className="px-2 py-1 text-[12px] text-text-muted">{t('common.loading')}</div>
          ) : (
            <>
              {files.map((f) => (
                <FileRow
                  key={f.name}
                  file={f}
                  active={f.name === selectedFile}
                  onClick={() => setSelectedFile(f.name)}
                />
              ))}
              {creatingFile && (
                <NewFileInput
                  busy={createMutation.isPending}
                  error={createError}
                  existingNames={files.map((f) => f.name.toLowerCase())}
                  onSubmit={(name) => createMutation.mutate(name)}
                  onCancel={() => {
                    setCreatingFile(false);
                    setCreateError(null);
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-2 border-b border-hairline-faint px-4 py-2.5">
              <FileText className="h-3.5 w-3.5 text-text-muted" />
              <span className="font-mono text-[13px] text-text-primary">{selected.name}</span>
              {selected.isEntry && (
                <span className="rounded-full border border-hairline-strong bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-text-secondary">
                  {t('agents.instructions.entry')}
                </span>
              )}
              <span className="flex-1" />
              {dirty && (
                <span className="text-[11px] text-accent-yellow">
                  {t('agents.instructions.unsaved')}
                </span>
              )}
              <button
                type="button"
                onClick={() => saveMutation.mutate()}
                disabled={!dirty || saveMutation.isPending}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-1 px-2.5 text-[12px] font-medium text-text-primary transition-colors hover:bg-surface-4 disabled:opacity-40"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                {t('common.save')}
              </button>
              {!selected.isEntry && (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      confirm(t('agents.instructions.deleteFileConfirm', { name: selected.name }))
                    ) {
                      deleteMutation.mutate(selected.name);
                    }
                  }}
                  className="grid h-7 w-7 place-items-center rounded-md text-text-muted hover:bg-accent-red/10 hover:text-accent-red"
                  title={t('agents.instructions.deleteFile')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {/* Textarea sem borda — vive dentro do card maior */}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="thin-scrollbar w-full flex-1 resize-none bg-transparent p-4 font-mono text-[12.5px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none"
              placeholder={t('agents.instructions.editorPlaceholder')}
            />
            {saveMutation.error && (
              <div className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {String(saveMutation.error)}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
            {t('agents.instructions.selectFile')}
          </div>
        )}
      </div>
    </div>
  );
}

function NewFileInput({
  busy,
  error,
  existingNames,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  existingNames: string[];
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const hasExtension = /\.(md|markdown|txt|yaml|yml|json)$/i.test(trimmed);
  const finalName = hasExtension ? trimmed : `${trimmed}.md`;
  const duplicate = existingNames.includes(finalName.toLowerCase());
  const valid = trimmed.length > 0 && !duplicate && /^[A-Za-z0-9_.-]+$/.test(trimmed);

  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-hairline bg-surface-faint p-2">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) onSubmit(finalName);
          if (e.key === 'Escape') onCancel();
        }}
        placeholder={t('agents.instructions.newFilePlaceholder')}
        spellCheck={false}
        className="h-7 w-full rounded bg-surface-1 px-2 font-mono text-[12px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-hairline-heavy"
      />
      {duplicate && (
        <div className="text-[10.5px] text-accent-red">
          {t('agents.instructions.duplicateName')}
        </div>
      )}
      {error && <div className="text-[10.5px] text-accent-red">{error}</div>}
      <div className="flex items-center justify-between gap-1.5">
        <span className="font-mono text-[10.5px] text-text-faint">{trimmed ? finalName : ' '}</span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-0.5 text-[11px] text-text-muted hover:bg-surface-2"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => valid && onSubmit(finalName)}
            disabled={!valid || busy}
            className="rounded bg-white px-2 py-0.5 text-[11px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
          >
            {busy ? '…' : t('common.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function FileRow({
  file,
  active,
  onClick,
}: {
  file: AgentInstructionFile;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        active
          ? 'bg-surface-active text-text-primary'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.name}</span>
      {file.isEntry && (
        <span className="text-[9.5px] font-medium uppercase tracking-wider text-text-faint">
          entry
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Skills + MCPs do agente: cards estilo marketplace, atribuição POR AGENTE
// (Usar/Em uso). Skills e MCPs ficam em abas; ambos viram per-agent via attach.
// ---------------------------------------------------------------------------

type SkillTab = 'skills' | 'mcps';

function SkillsTab({ agent }: { agent: Agent }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const [tab, setTab] = useState<SkillTab>('skills');
  const [detail, setDetail] = useState<Skill | null>(null);

  const allSkillsQuery = useQuery({
    queryKey: ['skills', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['skill:list']({ workspaceId: activeWorkspace!.id }),
  });
  const attachedQuery = useQuery({
    queryKey: ['skills-by-agent', agent.id],
    queryFn: () => window.orkestral['skill:list-by-agent']({ agentId: agent.id }),
  });

  const all = useMemo(() => allSkillsQuery.data ?? [], [allSkillsQuery.data]);
  const attachedSet = useMemo(
    () => new Set((attachedQuery.data ?? []).map((s) => s.id)),
    [attachedQuery.data],
  );
  const skillCount = useMemo(() => all.filter((s) => s.kind === 'instruction').length, [all]);
  const mcpCount = useMemo(() => all.filter((s) => s.kind === 'mcp').length, [all]);
  const wantKind: SkillKind = tab === 'skills' ? 'instruction' : 'mcp';
  const items = useMemo(() => all.filter((s) => s.kind === wantKind), [all, wantKind]);

  const attachMutation = useMutation({
    mutationFn: (skillId: string) =>
      window.orkestral['skill:attach']({ agentId: agent.id, skillId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills-by-agent', agent.id] }),
  });
  const detachMutation = useMutation({
    mutationFn: (skillId: string) =>
      window.orkestral['skill:detach']({ agentId: agent.id, skillId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills-by-agent', agent.id] }),
  });
  const toggle = (s: Skill): void => {
    if (attachedSet.has(s.id)) detachMutation.mutate(s.id);
    else attachMutation.mutate(s.id);
  };
  const busy = attachMutation.isPending || detachMutation.isPending;

  if (detail) {
    return (
      <SkillDetailView
        skill={detail}
        inUse={attachedSet.has(detail.id)}
        busy={busy}
        onBack={() => setDetail(null)}
        onToggle={() => toggle(detail)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toggle Skills | MCPs (igual o marketplace). */}
      <div className="flex items-center gap-1 border-b border-hairline-faint">
        <SkillTabButton
          active={tab === 'skills'}
          icon={Wand2}
          count={skillCount}
          onClick={() => setTab('skills')}
        >
          {t('agents.skills.tabSkills')}
        </SkillTabButton>
        <SkillTabButton
          active={tab === 'mcps'}
          icon={Server}
          count={mcpCount}
          onClick={() => setTab('mcps')}
        >
          {t('agents.skills.tabMcps')}
        </SkillTabButton>
      </div>

      {allSkillsQuery.isPending ? (
        <div className="py-12 text-center text-[12.5px] text-text-muted">{t('common.loading')}</div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={tab === 'skills' ? Wand2 : Server}
          title={
            tab === 'skills'
              ? t('agents.skills.emptySkillsTitle')
              : t('agents.skills.emptyMcpsTitle')
          }
          description={
            tab === 'skills' ? t('agents.skills.emptySkillsDesc') : t('agents.skills.emptyMcpsDesc')
          }
        />
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(238px, 1fr))' }}
        >
          {items.map((s) => (
            <AgentSkillCard
              key={s.id}
              skill={s}
              inUse={attachedSet.has(s.id)}
              busy={busy}
              onOpen={() => setDetail(s)}
              onToggle={() => toggle(s)}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillTabButton({
  active,
  icon: Icon,
  count,
  onClick,
  children,
}: {
  active: boolean;
  icon: typeof Wand2;
  count: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 border-b-2 px-3 pb-2.5 pt-1.5 text-[13px] font-medium transition-colors',
        active
          ? 'border-accent-purple text-text-primary'
          : 'border-transparent text-text-muted hover:text-text-secondary',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
      <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] tabular-nums text-text-faint">
        {count}
      </span>
    </button>
  );
}

/** Card de uma skill/MCP do agente — clica no corpo pra ver o detalhe; o botão
 *  Usar/Em uso ataca/destaca SÓ deste agente (per-agent via agentSkills). */
function AgentSkillCard({
  skill,
  inUse,
  busy,
  onOpen,
  onToggle,
  t,
}: {
  skill: Skill;
  inUse: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
  t: TFunction;
}) {
  const Icon = skill.kind === 'mcp' ? Server : Wand2;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group flex h-full flex-col rounded-xl border bg-surface-veil p-4 text-left transition-colors hover:bg-surface-3',
        inUse
          ? 'border-accent-green/30 hover:border-accent-green/45'
          : 'border-hairline-med hover:border-hairline-bright',
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-accent-purple/25 bg-accent-purple/10 text-accent-purple">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-text-primary">
          {skill.name}
        </div>
      </div>
      <p className="mt-2.5 line-clamp-2 flex-1 text-[12px] leading-relaxed text-text-muted">
        {skill.description || t('agents.skills.noDescription')}
      </p>
      <div className="mt-3.5 flex items-center justify-between gap-2">
        <span className="truncate rounded border border-hairline-heavy bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-text-secondary">
          {skill.kind === 'mcp' ? t('agents.skills.kindMcp') : t('agents.skills.kindSkill')}
        </span>
        {inUse ? (
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-green disabled:opacity-50"
          >
            <Check className="h-3 w-3" />
            {t('agents.skills.inUse')}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="inline-flex items-center gap-1 rounded-md border border-hairline-heavy bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent-purple/40 hover:bg-accent-purple/15 hover:text-text-primary disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {t('agents.skills.use')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Detalhe in-place de uma skill/MCP: identidade + Usar/Em uso + conteúdo
 *  (markdown da skill) ou config (JSON do MCP). */
function SkillDetailView({
  skill,
  inUse,
  busy,
  onBack,
  onToggle,
}: {
  skill: Skill;
  inUse: boolean;
  busy: boolean;
  onBack: () => void;
  onToggle: () => void;
}) {
  const { t } = useT();
  const isMcp = skill.kind === 'mcp';
  const body = isMcp ? JSON.stringify(skill.config ?? {}, null, 2) : skill.content;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            title={t('common.back')}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-hairline-strong text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[16px] font-semibold tracking-tight text-text-primary">
                {skill.name}
              </h3>
              <span className="shrink-0 rounded border border-hairline-heavy bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-text-secondary">
                {isMcp ? t('agents.skills.kindMcp') : t('agents.skills.kindSkill')}
              </span>
            </div>
            {skill.description && (
              <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">
                {skill.description}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onToggle}
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium disabled:opacity-50',
            inUse
              ? 'border border-accent-green/30 bg-accent-green/10 text-accent-green'
              : 'bg-accent text-white hover:bg-accent/90',
          )}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : inUse ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {inUse ? t('agents.skills.inUse') : t('agents.skills.use')}
        </button>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
          {isMcp ? t('agents.skills.detailConfig') : t('agents.skills.detailContent')}
        </span>
        <div className="h-px flex-1 bg-surface-active" />
      </div>
      <pre className="thin-scrollbar max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline bg-surface-faint p-4 font-mono text-[12px] leading-relaxed text-text-secondary">
        {body || t('agents.skills.noContent')}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuration — form real (two-pane: anchor nav + scrollable form)
// ---------------------------------------------------------------------------

// Seções âncora da aba. id = alvo do scrollspy; group = título do nav.
type CfgAnchor = { id: string; icon: typeof Sparkles; labelKey: string };
type CfgGroup = { titleKey: string; anchors: CfgAnchor[] };

const CFG_GROUPS: CfgGroup[] = [
  {
    titleKey: 'agents.config.nav.agent',
    anchors: [
      { id: 'identity', icon: User, labelKey: 'agents.config.identity.title' },
      { id: 'adapter', icon: Cpu, labelKey: 'agents.config.adapter.title' },
    ],
  },
  {
    titleKey: 'agents.config.nav.runtime',
    anchors: [
      { id: 'runtime', icon: Sliders, labelKey: 'agents.config.permsConfig.title' },
      { id: 'runpolicy', icon: CalendarClock, labelKey: 'agents.config.runPolicy.title' },
    ],
  },
  {
    titleKey: 'agents.config.nav.access',
    anchors: [
      { id: 'perms', icon: ShieldHalf, labelKey: 'agents.config.perms.title' },
      { id: 'apikeys', icon: KeyRound, labelKey: 'agents.apiKeys.title' },
    ],
  },
];

// Scrollspy: o clicar numa âncora dá smooth-scroll até a seção e marca ela na
// hora; durante a animação o spy fica "travado" pra não acender todas as seções
// do caminho. Fora disso, o realce segue a posição do scroll.
function useScrollSpy(
  ids: string[],
  formRef: React.RefObject<HTMLDivElement | null>,
): { active: string; goTo: (id: string) => void } {
  const [active, setActive] = useState(ids[0] ?? '');
  const lockRef = useRef(false);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goTo = useCallback(
    (id: string) => {
      const form = formRef.current;
      const target = form?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      if (!form || !target) return;
      lockRef.current = true;
      setActive(id);
      form.scrollTo({ top: target.offsetTop - 18, behavior: 'smooth' });
      if (lockTimer.current) clearTimeout(lockTimer.current);
      lockTimer.current = setTimeout(() => {
        lockRef.current = false;
      }, 650);
    },
    [formRef],
  );

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const onScroll = (): void => {
      if (lockRef.current) return;
      const y = form.scrollTop + 60;
      const atBottom = form.scrollTop + form.clientHeight >= form.scrollHeight - 4;
      let current = ids[0] ?? '';
      ids.forEach((id) => {
        const el = form.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
        if (el && el.offsetTop <= y) current = id;
      });
      if (atBottom) current = ids[ids.length - 1] ?? current;
      setActive(current);
    };
    form.addEventListener('scroll', onScroll, { passive: true });
    return () => form.removeEventListener('scroll', onScroll);
  }, [ids, formRef]);

  useEffect(
    () => () => {
      if (lockTimer.current) clearTimeout(lockTimer.current);
    },
    [],
  );

  return { active, goTo };
}

// Card de seção redesenhado (config-local — não toca o <Section> compartilhado).
function CfgCard({
  id,
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  id: string;
  icon: typeof Sparkles;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="mb-[18px] scroll-mt-[18px] rounded-2xl border border-hairline bg-card p-5"
    >
      <header className="mb-[18px] flex items-center gap-3">
        <div className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] border border-accent-purple/25 bg-accent-purple/[0.12]">
          <Icon className="h-[17px] w-[17px] text-accent-purple" strokeWidth={1.8} />
        </div>
        <div className="min-w-0">
          <b className="block text-[15px] font-semibold tracking-tight text-text-primary">
            {title}
          </b>
          {subtitle && <span className="text-[12.5px] text-text-muted">{subtitle}</span>}
        </div>
      </header>
      {children}
    </section>
  );
}

// Campo redesenhado: label (médio, muted) + input + hint.
function CfgField({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label className="mb-[7px] block text-[12.5px] font-medium text-text-secondary">
        {label}
      </label>
      {children}
      {hint && <div className="mt-1.5 text-[11.5px] leading-snug text-text-faint">{hint}</div>}
    </div>
  );
}

const CFG_INPUT_CLS =
  'w-full rounded-[10px] border border-hairline bg-background px-3 py-2.5 text-[13.5px] text-text-primary placeholder:text-text-faint transition focus:border-accent-purple/50 focus:outline-none focus:ring-[3px] focus:ring-accent-purple/[0.12]';

// Trigger do DSSelect igual ao input (mesmo bg/borda/raio) — pra select e input não
// ficarem com cores diferentes. Passado no `className` (cn usa twMerge → sobrescreve o
// trigger padrão `bg-transparent`/`h-8`).
const CFG_SELECT_CLS =
  'h-auto w-full rounded-[10px] border border-hairline bg-background px-3 py-2.5 text-[13.5px] hover:bg-background';

// Toggle row redesenhado (.tog): icon box + título (+ WARN) + descrição + switch.
function CfgToggle({
  icon: Icon,
  label,
  hint,
  value,
  onChange,
  danger,
  warn,
}: {
  icon: typeof Sparkles;
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
  warn?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={cn(
        'flex w-full items-start gap-3.5 rounded-xl border px-[15px] py-[13px] text-left transition',
        danger
          ? 'border-accent-yellow/25 bg-gradient-to-br from-accent-yellow/[0.05] to-transparent'
          : 'border-hairline bg-background',
      )}
    >
      <div
        className={cn(
          'grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[9px] border',
          danger
            ? 'border-accent-yellow/25 bg-accent-yellow/10'
            : 'border-hairline bg-surface-elevated',
        )}
      >
        <Icon
          className={cn('h-[15px] w-[15px]', danger ? 'text-accent-yellow' : 'text-text-muted')}
          strokeWidth={1.7}
        />
      </div>
      <div className="min-w-0 flex-1">
        <b className="flex items-center gap-2 text-[13.5px] font-semibold text-text-primary">
          {label}
          {warn && (
            <span className="rounded-md border border-accent-yellow/30 bg-accent-yellow/[0.13] px-[7px] py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-accent-yellow">
              {warn}
            </span>
          )}
        </b>
        {hint && (
          <span className="mt-1 block text-[12px] leading-snug text-text-muted">{hint}</span>
        )}
      </div>
      <span
        className={cn(
          'relative mt-px h-6 w-[42px] shrink-0 rounded-full border transition',
          value
            ? danger
              ? 'border-transparent bg-gradient-to-br from-accent-yellow to-accent-yellow/70'
              : 'border-transparent bg-gradient-to-br from-accent-purple to-accent'
            : 'border-hairline-vivid bg-surface-elevated',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white transition-all',
            value ? 'left-5' : 'left-0.5',
          )}
        />
      </span>
    </button>
  );
}

function ConfigurationTab({ agent }: { agent: Agent }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const activeWorkspace = useWorkspaceStore((s) => s.active);

  const agentsListQuery = useQuery({
    queryKey: ['agents', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: activeWorkspace!.id }),
  });
  const otherAgents = (agentsListQuery.data ?? []).filter((a) => a.id !== agent.id);

  type Draft = {
    name: string;
    title: string;
    capabilities: string;
    reportsTo: string;
    adapterType: AdapterType;
    model: string;
    canCreateAgents: boolean;
    canAssignTasks: boolean;
    canEditFiles: boolean;
    canRunCommands: boolean;
    heartbeatEnabled: boolean;
    heartbeatIntervalMinutes: number;
    // Runtime config (todos opcionais)
    autonomyLevel: NonNullable<AgentRuntimeConfig['autonomyLevel']>;
    thinkingEffort: NonNullable<AgentRuntimeConfig['thinkingEffort']>;
    bypassSandbox: boolean;
    enableSearch: boolean;
    fastMode: boolean;
    extraArgs: string;
    envVars: Array<{ key: string; value: string; secret: boolean }>;
    timeoutSec: number;
    graceSec: number;
    advancedExpanded: boolean;
    wakeOnDemand: boolean;
    cooldownSec: number;
    maxConcurrent: number;
    continueAfterMaxTurn: boolean;
    continuationAttempts: number;
    continuationDelaySec: number;
  };

  const rc = (agent.runtimeConfig ?? {}) as AgentRuntimeConfig;
  const adv = rc.advanced ?? {};

  // Bloco "source awareness" auto-gerenciado pelo source-team-sync — plumbing
  // interno, NÃO deve aparecer/ser editável no campo. Escondemos no display e
  // re-anexamos no save pra não perder (o próprio sync também o reconstrói).
  const sourceSyncBlock = useMemo(() => {
    const m = (agent.capabilities ?? '').match(
      /\[\[ORK_SOURCE_SYNC_START\]\][\s\S]*?\[\[ORK_SOURCE_SYNC_END\]\]/,
    );
    return m ? m[0] : '';
  }, [agent.capabilities]);

  const initial: Draft = useMemo(
    () => ({
      name: agent.name,
      title: agent.title ?? '',
      capabilities: (agent.capabilities ?? '')
        .replace(/\n*\[\[ORK_SOURCE_SYNC_START\]\][\s\S]*?\[\[ORK_SOURCE_SYNC_END\]\]/g, '')
        .trim(),
      reportsTo: agent.reportsTo ?? '',
      adapterType: agent.adapterType ?? 'claude_local',
      model: agent.model ?? 'default',
      canCreateAgents: agent.canCreateAgents,
      canAssignTasks: agent.canAssignTasks,
      canEditFiles: agent.canEditFiles,
      canRunCommands: agent.canRunCommands,
      heartbeatEnabled: agent.heartbeatEnabled,
      heartbeatIntervalMinutes: agent.heartbeatIntervalMinutes,
      autonomyLevel: rc.autonomyLevel ?? 'medium',
      thinkingEffort: rc.thinkingEffort ?? 'auto',
      bypassSandbox: rc.bypassSandbox ?? false,
      enableSearch: rc.enableSearch ?? false,
      fastMode: rc.fastMode ?? false,
      extraArgs: (rc.extraArgs ?? []).join(', '),
      envVars: (rc.envVars ?? []).map((e) => ({
        key: e.key,
        value: e.value,
        secret: !!e.secret,
      })),
      timeoutSec: rc.timeoutSec ?? 0,
      graceSec: rc.graceSec ?? 15,
      advancedExpanded: false,
      wakeOnDemand: adv.wakeOnDemand ?? true,
      cooldownSec: adv.cooldownSec ?? 10,
      maxConcurrent: adv.maxConcurrent ?? 20,
      continueAfterMaxTurn: adv.continueAfterMaxTurn ?? false,
      continuationAttempts: adv.continuationAttempts ?? 2,
      continuationDelaySec: adv.continuationDelaySec ?? 1,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent],
  );

  const [draft, setDraft] = useState<Draft>(initial);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setDraft(initial));
    return () => cancelAnimationFrame(frame);
  }, [initial]);

  const dirty = useMemo(() => {
    // Excluir advancedExpanded da comparação (UI-only)
    const a = { ...draft, advancedExpanded: 0 };
    const b = { ...initial, advancedExpanded: 0 };
    return JSON.stringify(a) !== JSON.stringify(b);
  }, [draft, initial]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const runtimeConfig: AgentRuntimeConfig = {
        autonomyLevel: draft.autonomyLevel,
        thinkingEffort: draft.thinkingEffort,
        bypassSandbox: draft.bypassSandbox,
        enableSearch: draft.enableSearch,
        fastMode: draft.fastMode,
        extraArgs: draft.extraArgs
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        envVars: draft.envVars.filter((e) => e.key.trim()),
        timeoutSec: Math.max(0, draft.timeoutSec),
        graceSec: Math.max(0, draft.graceSec),
        advanced: {
          wakeOnDemand: draft.wakeOnDemand,
          cooldownSec: Math.max(0, draft.cooldownSec),
          maxConcurrent: Math.max(1, draft.maxConcurrent),
          continueAfterMaxTurn: draft.continueAfterMaxTurn,
          continuationAttempts: Math.max(0, draft.continuationAttempts),
          continuationDelaySec: Math.max(0, draft.continuationDelaySec),
        },
      };
      return window.orkestral['agent:update']({
        agentId: agent.id,
        patch: {
          name: draft.name,
          title: draft.title || null,
          // Re-anexa o bloco auto-gerenciado (escondido no editor) pra não perdê-lo.
          capabilities:
            [draft.capabilities.trim(), sourceSyncBlock].filter(Boolean).join('\n\n') || null,
          reportsTo: draft.reportsTo || null,
          adapterType: draft.adapterType,
          model: draft.model === 'default' ? null : draft.model,
          canCreateAgents: draft.canCreateAgents,
          canAssignTasks: draft.canAssignTasks,
          canEditFiles: draft.canEditFiles,
          canRunCommands: draft.canRunCommands,
          heartbeatEnabled: draft.heartbeatEnabled,
          heartbeatIntervalMinutes: Math.max(1, draft.heartbeatIntervalMinutes),
          runtimeConfig: runtimeConfig as Record<string, unknown>,
        },
      });
    },
    onSuccess: (a) => {
      queryClient.setQueryData(['agent', a.id], a);
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  function patch<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function patchEnvVar(
    idx: number,
    p: Partial<{ key: string; value: string; secret: boolean }>,
  ): void {
    setDraft((d) => ({
      ...d,
      envVars: d.envVars.map((e, i) => (i === idx ? { ...e, ...p } : e)),
    }));
  }

  function addEnvVar(): void {
    setDraft((d) => ({
      ...d,
      envVars: [...d.envVars, { key: '', value: '', secret: false }],
    }));
  }

  function removeEnvVar(idx: number): void {
    setDraft((d) => ({ ...d, envVars: d.envVars.filter((_, i) => i !== idx) }));
  }

  const formRef = useRef<HTMLDivElement>(null);
  const anchorIds = useMemo(() => CFG_GROUPS.flatMap((g) => g.anchors.map((a) => a.id)), []);
  const { active, goTo } = useScrollSpy(anchorIds, formRef);

  return (
    <div className="relative flex h-full min-h-0">
      {/* Anchor nav */}
      <nav className="flex w-[206px] shrink-0 flex-col gap-0.5 border-r border-hairline px-3 py-5">
        {CFG_GROUPS.map((group) => (
          <div key={group.titleKey} className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1.5 pt-3.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-faint first:pt-0">
              {t(group.titleKey)}
            </div>
            {group.anchors.map((anchor) => {
              const Icon = anchor.icon;
              const on = active === anchor.id;
              return (
                <button
                  key={anchor.id}
                  type="button"
                  onClick={() => goTo(anchor.id)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-[11px] rounded-[9px] px-2.5 py-2 text-left text-[13px] font-medium transition-colors',
                    on
                      ? 'bg-accent-purple/10 text-accent-purple'
                      : 'text-text-muted hover:bg-surface-hover hover:text-text-primary',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={1.7} />
                  <span className="truncate">{t(anchor.labelKey)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Scrollable form */}
      <div ref={formRef} className="min-w-0 flex-1 overflow-y-auto px-7 pb-20 pt-6">
        {/* Identity */}
        <CfgCard
          id="identity"
          icon={User}
          title={t('agents.config.identity.title')}
          subtitle={t('agents.config.identity.hint')}
        >
          <div className="grid grid-cols-2 gap-4">
            <CfgField label={t('agents.config.identity.name')}>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => patch('name', e.target.value)}
                className={CFG_INPUT_CLS}
              />
            </CfgField>
            <CfgField
              label={t('agents.config.identity.title2')}
              hint={t('agents.config.identity.title2Hint')}
            >
              <input
                type="text"
                value={draft.title}
                onChange={(e) => patch('title', e.target.value)}
                placeholder={t('agents.config.identity.title2Placeholder')}
                className={CFG_INPUT_CLS}
              />
            </CfgField>
            <CfgField
              className="col-span-2"
              label={t('agents.config.identity.reportsTo')}
              hint={t('agents.config.identity.reportsToHint')}
            >
              <DSSelect
                className={CFG_SELECT_CLS}
                value={draft.reportsTo}
                onChange={(v) => patch('reportsTo', v)}
                options={[
                  { value: '', label: t('agents.config.identity.noManager'), muted: true },
                  ...otherAgents.map((a) => ({ value: a.id, label: a.name })),
                ]}
              />
            </CfgField>
            <CfgField
              className="col-span-2"
              label={t('agents.config.identity.capabilities')}
              hint={t('agents.config.identity.capabilitiesHint')}
            >
              <textarea
                value={draft.capabilities}
                onChange={(e) => patch('capabilities', e.target.value)}
                rows={4}
                spellCheck={false}
                className={cn(
                  CFG_INPUT_CLS,
                  'min-h-[74px] resize-none font-mono text-[12.5px] leading-relaxed',
                )}
                placeholder={t('agents.config.identity.capabilitiesPlaceholder')}
              />
            </CfgField>
          </div>
        </CfgCard>

        {/* Adapter */}
        <CfgCard
          id="adapter"
          icon={Cpu}
          title={t('agents.config.adapter.title')}
          subtitle={t('agents.config.adapter.hint')}
        >
          <div className="grid grid-cols-2 gap-4">
            <CfgField label={t('agents.config.adapter.adapterType')}>
              <DSSelect
                className={CFG_SELECT_CLS}
                value={draft.adapterType}
                onChange={(v) => patch('adapterType', v as AdapterType)}
                options={[
                  {
                    value: 'claude_local',
                    label: t('agents.config.adapter.options.claude'),
                    icon: <ProviderIcon provider="claude_local" className="h-4 w-4" />,
                  },
                  {
                    value: 'codex_local',
                    label: t('agents.config.adapter.options.codex'),
                    icon: <ProviderIcon provider="codex_local" className="h-4 w-4" />,
                  },
                  {
                    value: 'gemini_local',
                    label: t('agents.config.adapter.options.gemini'),
                    icon: <ProviderIcon provider="gemini_local" className="h-4 w-4" />,
                  },
                  {
                    value: 'orkestral_local',
                    label: t('agents.config.adapter.options.orkestral'),
                    icon: <ProviderIcon provider="orkestral_local" className="h-4 w-4" />,
                  },
                ]}
              />
            </CfgField>
            <CfgModelSelectField
              adapterType={draft.adapterType}
              value={draft.model}
              onChange={(v) => patch('model', v)}
            />
          </div>
        </CfgCard>

        {/* Runtime config (permsConfig) */}
        <CfgCard
          id="runtime"
          icon={Sliders}
          title={t('agents.config.permsConfig.title')}
          subtitle={t('agents.config.permsConfig.hint')}
        >
          {/* Autonomia foi movida pra Configurações > Workspace (é config GLOBAL do
              workspace, não de um agente). O valor segue salvo no runtimeConfig do
              orquestrador — só a UI mudou de lugar. */}
          <div className="flex flex-col gap-4">
            <CfgField
              label={t('agents.config.permsConfig.thinkingEffort')}
              hint={t('agents.config.permsConfig.thinkingEffortHint')}
            >
              <DSSelect
                className={CFG_SELECT_CLS}
                value={draft.thinkingEffort}
                onChange={(v) => patch('thinkingEffort', v as Draft['thinkingEffort'])}
                options={[
                  {
                    value: 'auto',
                    label: t('agents.newDialog.advanced.effort.auto'),
                    hint: 'auto',
                  },
                  {
                    value: 'minimal',
                    label: t('agents.newDialog.advanced.effort.minimal'),
                    hint: 'minimal',
                  },
                  { value: 'low', label: t('agents.newDialog.advanced.effort.low'), hint: 'low' },
                  {
                    value: 'medium',
                    label: t('agents.newDialog.advanced.effort.medium'),
                    hint: 'medium',
                  },
                  {
                    value: 'high',
                    label: t('agents.newDialog.advanced.effort.high'),
                    hint: 'high',
                  },
                  {
                    value: 'xhigh',
                    label: t('agents.newDialog.advanced.effort.xhigh'),
                    hint: 'xhigh',
                  },
                ]}
              />
            </CfgField>

            <div className="flex flex-col gap-2.5">
              <CfgToggle
                icon={ShieldAlert}
                label={t('agents.config.permsConfig.bypassSandbox')}
                hint={t('agents.config.permsConfig.bypassSandboxHint')}
                value={draft.bypassSandbox}
                onChange={(v) => patch('bypassSandbox', v)}
                danger
                warn={t('agents.config.nav.warnBadge')}
              />
              <CfgToggle
                icon={Search}
                label={t('agents.config.permsConfig.enableSearch')}
                hint={t('agents.config.permsConfig.enableSearchHint')}
                value={draft.enableSearch}
                onChange={(v) => patch('enableSearch', v)}
              />
              <CfgToggle
                icon={Zap}
                label={t('agents.config.permsConfig.fastMode')}
                hint={t('agents.config.permsConfig.fastModeHint')}
                value={draft.fastMode}
                onChange={(v) => patch('fastMode', v)}
              />
            </div>

            <CfgField
              label={t('agents.config.permsConfig.extraArgs')}
              hint={t('agents.config.permsConfig.extraArgsHint')}
            >
              <input
                type="text"
                value={draft.extraArgs}
                onChange={(e) => patch('extraArgs', e.target.value)}
                placeholder={t('agents.config.permsConfig.extraArgsPlaceholder')}
                className={CFG_INPUT_CLS}
              />
            </CfgField>

            <CfgField
              label={t('agents.config.permsConfig.envVars')}
              hint={t('agents.config.permsConfig.envVarsHint')}
            >
              <div className="flex flex-col gap-2">
                {draft.envVars.map((env, i) => (
                  <EnvVarRow
                    key={i}
                    env={env}
                    onChange={(p) => patchEnvVar(i, p)}
                    onRemove={() => removeEnvVar(i)}
                  />
                ))}
                <button
                  type="button"
                  onClick={addEnvVar}
                  className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[12px] text-text-secondary hover:bg-surface-1 hover:text-text-primary"
                >
                  <Plus className="h-3 w-3" />
                  {t('agents.config.permsConfig.addVar')}
                </button>
              </div>
            </CfgField>

            <div className="grid grid-cols-2 gap-4">
              <CfgField
                label={t('agents.config.permsConfig.timeout')}
                hint={t('agents.config.permsConfig.timeoutHint')}
              >
                <NumberInput
                  value={draft.timeoutSec}
                  onChange={(v) => patch('timeoutSec', v)}
                  min={0}
                />
              </CfgField>
              <CfgField
                label={t('agents.config.permsConfig.grace')}
                hint={t('agents.config.permsConfig.graceHint')}
              >
                <NumberInput
                  value={draft.graceSec}
                  onChange={(v) => patch('graceSec', v)}
                  min={0}
                />
              </CfgField>
            </div>
          </div>
        </CfgCard>

        {/* Run Policy */}
        <CfgCard
          id="runpolicy"
          icon={CalendarClock}
          title={t('agents.config.runPolicy.title')}
          subtitle={t('agents.config.runPolicy.hint')}
        >
          <div className="flex flex-col gap-2.5">
            <CfgToggle
              icon={Clock}
              label={t('agents.config.runPolicy.heartbeatInterval')}
              hint={t('agents.config.runPolicy.heartbeatIntervalHint')}
              value={draft.heartbeatEnabled}
              onChange={(v) => patch('heartbeatEnabled', v)}
            />
            {draft.heartbeatEnabled && (
              <div className="ml-[15px] border-l-2 border-accent-purple/30 pl-[15px]">
                <CfgField
                  label={t('agents.config.runPolicy.interval')}
                  hint={t('agents.config.runPolicy.intervalHint')}
                >
                  <NumberInput
                    value={draft.heartbeatIntervalMinutes}
                    onChange={(v) => patch('heartbeatIntervalMinutes', Math.max(1, v))}
                    min={1}
                    className="w-32"
                  />
                </CfgField>
              </div>
            )}

            {/* Advanced collapsible */}
            <button
              type="button"
              onClick={() => patch('advancedExpanded', !draft.advancedExpanded)}
              className="flex items-center gap-1.5 pt-1 text-[12.5px] text-text-secondary hover:text-text-primary"
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 transition-transform',
                  draft.advancedExpanded && 'rotate-90',
                )}
              />
              {t('agents.config.runPolicy.advanced')}
            </button>

            {draft.advancedExpanded && (
              <div className="flex flex-col gap-3 border-l-2 border-accent-purple/30 pl-[15px]">
                <CfgToggle
                  icon={Zap}
                  label={t('agents.config.runPolicy.wakeOnDemand')}
                  hint={t('agents.config.runPolicy.wakeOnDemandHint')}
                  value={draft.wakeOnDemand}
                  onChange={(v) => patch('wakeOnDemand', v)}
                />
                <CfgField
                  label={t('agents.config.runPolicy.cooldown')}
                  hint={t('agents.config.runPolicy.cooldownHint')}
                >
                  <NumberInput
                    value={draft.cooldownSec}
                    onChange={(v) => patch('cooldownSec', v)}
                    min={0}
                    className="w-32"
                  />
                </CfgField>
                <CfgField
                  label={t('agents.config.runPolicy.maxConcurrent')}
                  hint={t('agents.config.runPolicy.maxConcurrentHint')}
                >
                  <NumberInput
                    value={draft.maxConcurrent}
                    onChange={(v) => patch('maxConcurrent', v)}
                    min={1}
                    className="w-32"
                  />
                </CfgField>
                <CfgToggle
                  icon={RotateCcw}
                  label={t('agents.config.runPolicy.continueAfterMaxTurn')}
                  hint={t('agents.config.runPolicy.continueAfterMaxTurnHint')}
                  value={draft.continueAfterMaxTurn}
                  onChange={(v) => patch('continueAfterMaxTurn', v)}
                />
                {draft.continueAfterMaxTurn && (
                  <div className="grid grid-cols-2 gap-3">
                    <CfgField label={t('agents.config.runPolicy.continuationAttempts')}>
                      <NumberInput
                        value={draft.continuationAttempts}
                        onChange={(v) => patch('continuationAttempts', v)}
                        min={0}
                      />
                    </CfgField>
                    <CfgField label={t('agents.config.runPolicy.continuationDelay')}>
                      <NumberInput
                        value={draft.continuationDelaySec}
                        onChange={(v) => patch('continuationDelaySec', v)}
                        min={0}
                      />
                    </CfgField>
                  </div>
                )}
              </div>
            )}
          </div>
        </CfgCard>

        {/* Permissions */}
        <CfgCard
          id="perms"
          icon={ShieldHalf}
          title={t('agents.config.perms.title')}
          subtitle={t('agents.config.perms.hint')}
        >
          <div className="grid grid-cols-2 gap-2.5">
            <CfgToggle
              icon={Users}
              label={t('agents.config.perms.createAgents')}
              hint={t('agents.config.perms.createAgentsHint')}
              value={draft.canCreateAgents}
              onChange={(v) => patch('canCreateAgents', v)}
            />
            <CfgToggle
              icon={ClipboardList}
              label={t('agents.config.perms.assignTasks')}
              hint={t('agents.config.perms.assignTasksHint')}
              value={draft.canAssignTasks}
              onChange={(v) => patch('canAssignTasks', v)}
            />
            <CfgToggle
              icon={FileEdit}
              label={t('agents.config.perms.editFiles')}
              hint={t('agents.config.perms.editFilesHint')}
              value={draft.canEditFiles}
              onChange={(v) => patch('canEditFiles', v)}
            />
            <CfgToggle
              icon={Terminal}
              label={t('agents.config.perms.runCommands')}
              hint={t('agents.config.perms.runCommandsHint')}
              value={draft.canRunCommands}
              onChange={(v) => patch('canRunCommands', v)}
              danger
              warn={t('agents.config.nav.warnBadge')}
            />
          </div>
        </CfgCard>

        {/* API Keys */}
        <div id="apikeys" className="scroll-mt-[18px]">
          <ApiKeysSection agentId={agent.id} />
        </div>
      </div>

      {/* Save bar (confinada ao painel de conteúdo) */}
      {dirty && (
        <div className="absolute inset-x-0 bottom-0 z-30 flex items-center justify-end gap-3.5 border-t border-hairline-vivid bg-background/90 px-7 py-3.5 backdrop-blur-md">
          <span className="mr-auto flex items-center gap-2 text-[12.5px] text-accent-yellow">
            <span className="h-[7px] w-[7px] rounded-full bg-accent-yellow shadow-[0_0_8px_var(--color-accent-yellow)]" />
            {t('agents.config.saveBar.unsaved')}
          </span>
          <button
            type="button"
            onClick={() => setDraft(initial)}
            className="inline-flex h-8 items-center rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[12.5px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
          >
            {t('agents.config.saveBar.discard')}
          </button>
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-purple px-3 text-[12.5px] font-semibold text-background hover:bg-accent-purple/90 disabled:opacity-50"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t('agents.config.saveBar.save')}
          </button>
        </div>
      )}
    </div>
  );
}

// CfgModelSelectField: igual ao ModelSelectField mas usando o CfgField
// redesenhado (label muted + hint). Mantém o DSSelect e a query de modelos.
function CfgModelSelectField({
  adapterType,
  value,
  onChange,
}: {
  adapterType: AdapterType;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useT();
  const modelsQuery = useQuery({
    queryKey: ['adapter-models', adapterType],
    queryFn: () => window.orkestral['adapter:list-models']({ type: adapterType }),
  });
  const models = modelsQuery.data ?? [];
  const options =
    models.length > 0
      ? models.map((m) => ({ value: m.id, label: m.label }))
      : [{ value: 'default', label: t('agents.config.model.defaultOption') }];
  if (value && value !== 'default' && !options.some((o) => o.value === value)) {
    options.push({ value, label: t('agents.config.model.customSuffix', { value }) });
  }
  return (
    <CfgField
      label={t('agents.config.model.label')}
      hint={
        modelsQuery.isPending
          ? t('agents.config.model.loading')
          : modelsQuery.isError
            ? t('agents.config.model.error')
            : t('agents.config.model.available', { n: models.length, adapter: adapterType })
      }
    >
      <DSSelect
        className={CFG_SELECT_CLS}
        value={value || 'default'}
        onChange={onChange}
        options={options.map((o) => ({
          value: o.value,
          label: o.label,
          hint: o.value !== 'default' ? o.value : undefined,
        }))}
      />
    </CfgField>
  );
}

// ---------------------------------------------------------------------------
// Env var row + Number input + API Keys section
// ---------------------------------------------------------------------------

function EnvVarRow({
  env,
  onChange,
  onRemove,
}: {
  env: { key: string; value: string; secret: boolean };
  onChange: (p: Partial<{ key: string; value: string; secret: boolean }>) => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  return (
    <div className="grid grid-cols-[1fr_120px_2fr_auto_auto] items-center gap-2">
      <input
        value={env.key}
        onChange={(e) => onChange({ key: e.target.value })}
        placeholder="KEY"
        spellCheck={false}
        className="h-9 rounded-md border border-hairline-strong bg-surface-subtle px-3 font-mono text-[12.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-hairline-strong"
      />
      <DSSelect
        value={env.secret ? 'secret' : 'plain'}
        onChange={(v) => onChange({ secret: v === 'secret' })}
        options={[
          { value: 'plain', label: t('agents.newDialog.advanced.envType.plain') },
          { value: 'secret', label: t('agents.newDialog.advanced.envType.secret') },
        ]}
      />
      <input
        type={env.secret ? 'password' : 'text'}
        value={env.value}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder="value"
        spellCheck={false}
        className="h-9 rounded-md border border-hairline-strong bg-surface-subtle px-3 font-mono text-[12.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-hairline-strong"
      />
      <button
        type="button"
        onClick={() => onChange({ secret: !env.secret })}
        className="inline-flex h-9 items-center gap-1 rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
        title={
          env.secret ? t('agents.config.envRow.markPlain') : t('agents.config.envRow.markSecret')
        }
      >
        {env.secret ? (
          <ShieldCheck className="h-3.5 w-3.5" />
        ) : (
          <ShieldOff className="h-3.5 w-3.5" />
        )}
        {t('agents.config.envRow.seal')}
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="grid h-9 w-9 place-items-center rounded-md text-text-muted hover:bg-accent-red/10 hover:text-accent-red"
        title={t('agents.config.envRow.removeVar')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  className?: string;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      step={1}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(Number.isFinite(n) ? n : 0);
      }}
      className={cn(
        'h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-hairline-strong',
        className,
      )}
    />
  );
}

function ApiKeysSection({ agentId }: { agentId: string }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const keysQuery = useQuery({
    queryKey: ['agent', agentId, 'api-keys'],
    queryFn: () => window.orkestral['agent:list-api-keys']({ agentId }),
  });
  const keys = keysQuery.data ?? [];

  const createMutation = useMutation({
    mutationFn: (name: string) => window.orkestral['agent:create-api-key']({ agentId, name }),
    onSuccess: ({ token }) => {
      setRevealedToken(token);
      setNewName('');
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ['agent', agentId, 'api-keys'] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => window.orkestral['agent:revoke-api-key']({ keyId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent', agentId, 'api-keys'] });
    },
  });

  return (
    <Section title={t('agents.apiKeys.title')} hint={t('agents.apiKeys.hint')}>
      {revealedToken && (
        <div className="rounded-md border border-accent-yellow/30 bg-accent-yellow/[0.05] px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-accent-yellow">
            {t('agents.apiKeys.tokenCreated')}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 truncate font-mono text-[12px] text-text-primary">
              {revealedToken}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(revealedToken).catch(() => undefined);
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline-strong bg-surface-2 px-2.5 text-[11px] hover:bg-surface-strong"
            >
              {t('agents.apiKeys.copy')}
            </button>
            <button
              type="button"
              onClick={() => setRevealedToken(null)}
              className="inline-flex h-7 items-center px-2 text-[11px] text-text-muted hover:text-text-primary"
            >
              {t('agents.apiKeys.dismiss')}
            </button>
          </div>
          <div className="mt-1 text-[10.5px] text-text-muted">
            {t('agents.apiKeys.tokenWarning')}
          </div>
        </div>
      )}

      {creating ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('agents.apiKeys.namePlaceholder')}
            className="h-9 flex-1 rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-hairline-strong"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) createMutation.mutate(newName.trim());
              if (e.key === 'Escape') setCreating(false);
            }}
          />
          <button
            type="button"
            disabled={!newName.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate(newName.trim())}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-3 text-[12.5px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
          >
            {createMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {t('common.create')}
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setNewName('');
            }}
            className="text-[12.5px] text-text-muted hover:text-text-primary"
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-9 w-fit items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[12.5px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('agents.apiKeys.create')}
        </button>
      )}

      {keysQuery.isPending ? (
        <div className="text-[12px] text-text-muted">{t('common.loading')}</div>
      ) : keys.length === 0 ? (
        <div className="text-[12px] text-text-muted">{t('agents.apiKeys.noActiveKeys')}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {keys.map((k) => (
            <ApiKeyRow
              key={k.id}
              apiKey={k}
              onRevoke={() => {
                if (confirm(t('agents.apiKeys.revokeConfirm', { name: k.name }))) {
                  revokeMutation.mutate(k.id);
                }
              }}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function ApiKeyRow({ apiKey, onRevoke }: { apiKey: AgentApiKey; onRevoke: () => void }) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2 text-[12.5px]">
      <span className="font-medium text-text-primary">{apiKey.name}</span>
      <code className="font-mono text-[11px] text-text-muted">{apiKey.tokenPreview}…</code>
      <span className="flex-1" />
      <span className="text-[10.5px] text-text-faint">
        {apiKey.lastUsedAt
          ? t('agents.apiKeys.usedRelative', { when: fmtRelative(apiKey.lastUsedAt, t) })
          : t('agents.apiKeys.neverUsed')}
      </span>
      <button
        type="button"
        onClick={onRevoke}
        className="grid h-7 w-7 place-items-center rounded-md text-text-muted hover:bg-accent-red/10 hover:text-accent-red"
        title={t('agents.apiKeys.revoke')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issues atribuídas a esse agente
// ---------------------------------------------------------------------------

const ISSUE_STATUS_META: Record<
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

const ACTIVE_STATUSES: IssueStatus[] = ['todo', 'in_progress', 'in_review', 'blocked'];

function IssuesAssignedTab({ agent }: { agent: Agent }) {
  const { t } = useT();
  const workspace = useWorkspaceStore((s) => s.active);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const issuesQuery = useQuery({
    queryKey: ['agent-issues', agent.id, workspace?.id],
    enabled: !!workspace,
    queryFn: () =>
      window.orkestral['issue:list']({
        workspaceId: workspace!.id,
        assigneeAgentId: agent.id,
      }),
    refetchInterval: 8000,
  });
  const all: Issue[] = issuesQuery.data ?? [];
  const visible = filter === 'active' ? all.filter((i) => ACTIVE_STATUSES.includes(i.status)) : all;

  // Grouping by status pra dar sensação de "kanban resumido"
  const byStatus = useMemo(() => {
    const map = new Map<IssueStatus, Issue[]>();
    for (const i of visible) {
      if (!map.has(i.status)) map.set(i.status, []);
      map.get(i.status)!.push(i);
    }
    return map;
  }, [visible]);

  const prefix = issuePrefix(workspace?.name ?? '');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-medium text-text-primary">{t('agents.issues.assigned')}</h3>
        <span className="text-[11.5px] text-text-muted">
          {t('agents.issues.summary', {
            open: all.filter((i) => ACTIVE_STATUSES.includes(i.status)).length,
            total: all.length,
          })}
        </span>
        <span className="flex-1" />
        <div className="flex items-center gap-0.5 rounded-md border border-hairline bg-surface-faint p-0.5">
          <button
            type="button"
            onClick={() => setFilter('active')}
            className={cn(
              'rounded px-2 py-0.5 text-[11px] transition-colors',
              filter === 'active'
                ? 'bg-surface-strong text-text-primary'
                : 'text-text-muted hover:text-text-primary',
            )}
          >
            {t('agents.issues.filterOpen')}
          </button>
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={cn(
              'rounded px-2 py-0.5 text-[11px] transition-colors',
              filter === 'all'
                ? 'bg-surface-strong text-text-primary'
                : 'text-text-muted hover:text-text-primary',
            )}
          >
            {t('agents.issues.filterAll')}
          </button>
        </div>
      </div>

      {issuesQuery.isPending ? (
        <div className="flex items-center justify-center py-12 text-[12px] text-text-muted">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          {t('common.loading')}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-hairline px-4 py-10 text-center">
          <ListTodo className="mx-auto h-6 w-6 text-text-faint" />
          <p className="mt-2 text-[12.5px] text-text-muted">
            {filter === 'active'
              ? t('agents.issues.emptyActive', { name: agent.name })
              : t('agents.issues.emptyAll', { name: agent.name })}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {(Object.keys(ISSUE_STATUS_META) as IssueStatus[]).map((st) => {
            const items = byStatus.get(st) ?? [];
            if (items.length === 0) return null;
            const meta = ISSUE_STATUS_META[st];
            const Icon = meta.Icon;
            return (
              <section key={st} className="flex flex-col gap-1.5">
                <h4 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-text-faint">
                  <Icon className={cn('h-3 w-3', meta.color)} />
                  {t(`agents.issues.status.${st}`)}
                  <span className="text-text-faint normal-case tracking-normal">
                    · {items.length}
                  </span>
                </h4>
                <div className="flex flex-col gap-1">
                  {items.map((i) => (
                    <Link
                      key={i.id}
                      to={`/issues/${prefix}-${i.issueKey}`}
                      className="group flex items-center gap-2 rounded-md border border-hairline-soft bg-surface-veil px-3 py-1.5 hover:border-hairline-vivid hover:bg-surface-1"
                    >
                      <Icon className={cn('h-3 w-3 shrink-0', meta.color)} />
                      <span className="font-mono text-[10.5px] text-text-faint">
                        {prefix}-{i.issueKey}
                      </span>
                      <span className="flex-1 truncate text-[12.5px] text-text-primary">
                        {i.title}
                      </span>
                      {i.labels.length > 0 && (
                        <span className="text-[10px] text-text-faint">
                          {i.labels.slice(0, 2).join(', ')}
                          {i.labels.length > 2 && ` +${i.labels.length - 2}`}
                        </span>
                      )}
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function issuePrefix(workspaceName: string): string {
  const letters = workspaceName.match(/[A-Z]/g);
  if (letters && letters.length >= 2) return letters.slice(0, 3).join('');
  return workspaceName.slice(0, 3).toUpperCase();
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function RunsTab({ agent }: { agent: Agent }) {
  const { t } = useT();
  const [filter, setFilter] = useState<'all' | AgentActivityKind>('all');

  const activityQuery = useQuery({
    queryKey: ['agent-activity', agent.id, 100],
    queryFn: () => window.orkestral['agent:get-activity']({ agentId: agent.id, limit: 100 }),
    refetchInterval: 10_000,
  });

  const all = activityQuery.data ?? [];
  const filtered = filter === 'all' ? all : all.filter((a) => a.kind === filter);

  const counts = {
    all: all.length,
    issue: all.filter((a) => a.kind === 'issue').length,
    chat: all.filter((a) => a.kind === 'chat').length,
    'code-review': all.filter((a) => a.kind === 'code-review').length,
    heartbeat: all.filter((a) => a.kind === 'heartbeat').length,
  };

  if (all.length === 0) {
    return (
      <Section title={t('agents.runs.title')} hint={t('agents.runs.hint')}>
        <EmptyState
          icon={Clock}
          title={t('agents.runs.emptyTitle')}
          description={t('agents.runs.emptyDescription')}
        />
      </Section>
    );
  }

  return (
    <Section
      title={t('agents.runs.title')}
      hint={
        all.length === 1
          ? t('agents.runs.histHintOne', { n: all.length })
          : t('agents.runs.histHintOther', { n: all.length })
      }
    >
      <div className="mb-3 flex items-center gap-1">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
          {t('agents.runs.filterAll')}
        </FilterChip>
        <FilterChip
          active={filter === 'issue'}
          onClick={() => setFilter('issue')}
          count={counts.issue}
        >
          {t('agents.runs.filterIssues')}
        </FilterChip>
        <FilterChip
          active={filter === 'chat'}
          onClick={() => setFilter('chat')}
          count={counts.chat}
        >
          {t('agents.runs.filterChat')}
        </FilterChip>
        <FilterChip
          active={filter === 'code-review'}
          onClick={() => setFilter('code-review')}
          count={counts['code-review']}
        >
          {t('agents.runs.filterCodeReviews')}
        </FilterChip>
        <FilterChip
          active={filter === 'heartbeat'}
          onClick={() => setFilter('heartbeat')}
          count={counts.heartbeat}
        >
          {t('agents.runs.filterHeartbeat')}
        </FilterChip>
      </div>
      <div className="flex flex-col gap-1.5">
        {filtered.map((a) => (
          <ActivityRow key={`${a.kind}:${a.id}`} item={a} />
        ))}
        {filtered.length === 0 && (
          <div className="rounded-md border border-hairline-faint bg-surface-veil px-4 py-6 text-center text-[12.5px] text-text-muted">
            {t('agents.runs.noneOfType')}
          </div>
        )}
      </div>
    </Section>
  );
}

function FilterChip({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors',
        active
          ? 'bg-surface-4 text-text-primary'
          : 'text-text-muted hover:bg-surface-1 hover:text-text-secondary',
      )}
    >
      <span>{children}</span>
      <span className={cn('text-[10.5px]', active ? 'text-text-secondary' : 'text-text-faint')}>
        {count}
      </span>
    </button>
  );
}

/**
 * Linha de atividade unificada. Renderiza icone + título + subtítulo + status
 * + duração + when, polimórfico por `kind`. Clica e navega pro link interno.
 */
function ActivityRow({ item }: { item: AgentActivityItem }) {
  const { t } = useT();
  const status = ACTIVITY_STATUS[item.status];
  const kindIcon = ACTIVITY_KIND_META[item.kind];
  const navigate = useNavigate();

  const clickable = !!item.link;

  function onClick() {
    if (!item.link) return;
    if (item.link.startsWith('#/')) {
      navigate(item.link.slice(1));
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={cn(
        'group flex items-center gap-3 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2 text-left text-[12.5px] transition-colors',
        clickable ? 'cursor-pointer hover:bg-surface-1' : 'cursor-default',
      )}
    >
      <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-md', kindIcon.bg)}>
        <kindIcon.Icon className={cn('h-3.5 w-3.5', kindIcon.fg)} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 truncate">
          <span className="truncate font-medium text-text-primary">{item.title}</span>
          {item.subtitle && (
            <span className="truncate text-[11.5px] text-text-muted">· {item.subtitle}</span>
          )}
        </div>
        {item.errorMessage && (
          <span className="truncate text-[11px] text-accent-red/80">{item.errorMessage}</span>
        )}
      </div>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', status.dot)} />
      <span className={cn('text-[10.5px] font-medium uppercase tracking-wider', status.text)}>
        {t(`agents.runs.status.${item.status}`)}
      </span>
      {item.durationMs != null && (
        <span className="text-[10.5px] text-text-muted">{fmtDuration(item.durationMs)}</span>
      )}
      <span className="text-[10.5px] text-text-muted">{fmtRelative(item.startedAt, t)}</span>
      {clickable && (
        <ChevronRight className="h-3 w-3 text-text-faint transition-transform group-hover:translate-x-0.5" />
      )}
    </button>
  );
}

const ACTIVITY_STATUS: Record<AgentActivityStatus, { dot: string; text: string }> = {
  queued: { dot: 'bg-text-muted', text: 'text-text-secondary' },
  running: { dot: 'bg-accent-blue animate-pulse-dot', text: 'text-accent-blue' },
  done: { dot: 'bg-accent-green', text: 'text-accent-green' },
  error: { dot: 'bg-accent-red', text: 'text-accent-red' },
  cancelled: { dot: 'bg-text-muted', text: 'text-text-muted' },
};

const ACTIVITY_KIND_META: Record<
  AgentActivityKind,
  { Icon: typeof MessageSquare; bg: string; fg: string }
> = {
  chat: {
    Icon: MessageSquare,
    bg: 'bg-accent-blue/12',
    fg: 'text-accent-blue',
  },
  heartbeat: {
    Icon: Heart,
    bg: 'bg-accent-pink/12',
    fg: 'text-accent-pink',
  },
  'code-review': {
    Icon: GitPullRequest,
    bg: 'bg-accent-purple/12',
    fg: 'text-accent-purple',
  },
  issue: {
    Icon: CircleDot,
    bg: 'bg-accent-green/12',
    fg: 'text-accent-green',
  },
};

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-[14px] font-semibold tracking-tight text-text-primary">{title}</h2>
        {hint && <p className="mt-0.5 text-[12px] text-text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface-faint px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-text-faint">{label}</div>
      <div className="mt-1.5 text-[20px] font-semibold tracking-tight text-text-primary">
        {value}
      </div>
      {hint && <div className="mt-1 text-[10.5px] text-text-muted">{hint}</div>}
    </div>
  );
}

function PermissionRow({ label, granted }: { label: string; granted: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2 text-[12.5px]">
      {granted ? (
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-accent-green" />
      ) : (
        <ShieldOff className="h-3.5 w-3.5 shrink-0 text-text-muted" />
      )}
      <span className="flex-1 text-text-secondary">{label}</span>
      {granted ? (
        <CheckCircle2 className="h-3 w-3 text-accent-green" />
      ) : (
        <XCircle className="h-3 w-3 text-text-faint" />
      )}
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Sparkles;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-hairline bg-surface-ghost px-6 py-12 text-center">
      <Icon className="h-6 w-6 text-text-muted" />
      <div className="mt-3 text-[13px] font-medium text-text-primary">{title}</div>
      <div className="mt-1 max-w-sm text-[12px] text-text-muted">{description}</div>
    </div>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {children}
      </div>
    </div>
  );
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function fmtRelative(iso: string, t: TFunction): string {
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return t('agents.time.now');
    if (mins < 60) return t('agents.time.minutesAgo', { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t('agents.time.hoursAgo', { n: hrs });
    const days = Math.floor(hrs / 24);
    return t('agents.time.daysAgo', { n: days });
  } catch {
    return iso;
  }
}
