import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Loader2,
  ArrowLeft,
  Plus,
  Zap,
  Pencil,
  Trash2,
  Inbox,
  Sparkles,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@renderer/components/ui/dialog';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { Switch } from '@renderer/components/ui/switch';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { toast } from '@renderer/stores/toastStore';
import { cn } from '@renderer/lib/utils';
import { useT, type Language } from '@renderer/i18n';
import type { Agent } from '@shared/types';

const LEVELS = ['fatal', 'error', 'warning', 'info'] as const;
const INTERVALS = [0, 1, 5, 15, 30, 60] as const;

type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  minLevel: string;
  projectSlug: string | null;
  agentId: string | null;
  mode: 'propose' | 'auto';
};

function relativeTime(iso: string, lang: Language): string {
  const then = new Date(iso).getTime();
  if (!then) return '';
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (abs < hour) return rtf.format(Math.round(diff / min), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  return rtf.format(Math.round(diff / day), 'day');
}

export function SentryAutomationsPage() {
  const { t, lang } = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const workspaceId = useWorkspaceStore((s) => s.active?.id);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const rulesQuery = useQuery({
    queryKey: ['sentry', 'rules', workspaceId],
    queryFn: () => window.orkestral['sentry:list-rules']({ workspaceId: workspaceId! }),
    enabled: !!workspaceId,
  });
  const runsQuery = useQuery({
    queryKey: ['sentry', 'runs', workspaceId],
    queryFn: () => window.orkestral['sentry:list-runs']({ workspaceId: workspaceId!, limit: 50 }),
    enabled: !!workspaceId,
  });
  const agentsQuery = useQuery({
    queryKey: ['agents', workspaceId],
    queryFn: () => window.orkestral['agent:list']({ workspaceId: workspaceId! }),
    enabled: !!workspaceId,
  });
  const issuesQuery = useQuery({
    queryKey: ['sentry', 'issues', workspaceId],
    queryFn: () => window.orkestral['sentry:list-issues']({ workspaceId: workspaceId!, limit: 50 }),
    enabled: !!workspaceId,
  });
  const automationQuery = useQuery({
    queryKey: ['sentry', 'automation', workspaceId],
    queryFn: () => window.orkestral['sentry:get-automation']({ workspaceId: workspaceId! }),
    enabled: !!workspaceId,
  });

  const rules = rulesQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const projects = Array.from(
    new Set((issuesQuery.data ?? []).map((i) => i.project).filter(Boolean)),
  ).sort();
  const refreshMin = automationQuery.data?.refreshIntervalMin ?? 5;
  const activeRules = rules.filter((r) => r.enabled).length;
  const monitored = issuesQuery.data?.length ?? 0;
  const lastRunAt = runs[0]?.createdAt;
  const ruleNameById = new Map(rules.map((r) => [r.id, r.name]));

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['sentry', 'rules'] });
    void qc.invalidateQueries({ queryKey: ['sentry', 'runs'] });
  };

  const toggleMut = useMutation({
    mutationFn: (rule: Rule) =>
      window.orkestral['sentry:save-rule']({
        ...rule,
        workspaceId: workspaceId!,
        enabled: !rule.enabled,
      }),
    onSuccess: invalidate,
    onError: (e) =>
      toast.error(
        t('pages.sentryAutomations.saveFailed'),
        e instanceof Error ? e.message : undefined,
      ),
  });
  const deleteMut = useMutation({
    mutationFn: (ruleId: string) => window.orkestral['sentry:delete-rule']({ ruleId }),
    onSuccess: () => {
      invalidate();
      toast.success(t('pages.sentryAutomations.deleted'));
    },
    onError: (e) =>
      toast.error(
        t('pages.sentryAutomations.deleteFailed'),
        e instanceof Error ? e.message : undefined,
      ),
  });
  const refreshMut = useMutation({
    mutationFn: (min: number) =>
      window.orkestral['sentry:set-automation']({
        workspaceId: workspaceId!,
        refreshIntervalMin: min,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sentry', 'automation'] }),
  });

  const agentName = (id: string | null) =>
    id
      ? (agents.find((a) => a.id === id)?.name ?? t('pages.sentryAutomations.ceo'))
      : t('pages.sentryAutomations.ceo');

  const openNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (rule: Rule) => {
    setEditing(rule);
    setEditorOpen(true);
  };

  return (
    <PageShell>
      <div className="window-drag border-b border-hairline-soft px-8 pt-5">
        <button
          type="button"
          onClick={() => navigate('/sentry')}
          className="window-no-drag mb-2 inline-flex items-center gap-1 text-[11.5px] text-text-muted transition-colors hover:text-text-secondary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('pages.sentryAutomations.back')}
        </button>
        <div className="flex items-end justify-between gap-4 pb-3">
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">
              {t('pages.sentryAutomations.title')}
            </h1>
            <p className="mt-0.5 text-[12.5px] text-text-muted">
              {t('pages.sentryAutomations.subtitle')}
            </p>
          </div>
          <div className="window-no-drag flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-[11px] text-text-faint">
              <span>{t('pages.sentryAutomations.autoRefresh')}</span>
              <DSSelect
                value={String(refreshMin)}
                onChange={(v) => refreshMut.mutate(Number(v))}
                options={INTERVALS.map((n) => ({
                  value: String(n),
                  label:
                    n === 0
                      ? t('pages.sentryAutomations.refreshOff')
                      : t('pages.sentryAutomations.refreshEveryMin', { n }),
                }))}
                className="h-8 w-28"
              />
            </div>
            <button
              type="button"
              onClick={openNew}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-heavy bg-surface-hover px-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-white/20 hover:bg-surface-4 hover:text-text-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('pages.sentryAutomations.newRule')}
            </button>
          </div>
        </div>
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-8 py-5">
        <div className="flex flex-col gap-7">
          {/* Faixa de stats */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <StatCard
              label={t('pages.sentryAutomations.statActive')}
              value={`${activeRules}/${rules.length}`}
            />
            <StatCard
              label={t('pages.sentryAutomations.statMonitored')}
              value={String(monitored)}
            />
            <StatCard label={t('pages.sentryAutomations.statRuns')} value={String(runs.length)} />
            <StatCard
              label={t('pages.sentryAutomations.statLastRun')}
              value={lastRunAt ? relativeTime(lastRunAt, lang) : t('pages.sentryAutomations.never')}
            />
          </div>

          {/* Regras */}
          <section>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
              {t('pages.sentryAutomations.rulesTitle')}
            </h2>
            {rulesQuery.isPending ? (
              <div className="flex justify-center py-10 text-text-muted">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : rules.length === 0 ? (
              <div className="rounded-xl border border-dashed border-hairline-strong py-10 text-center">
                <Zap className="mx-auto h-5 w-5 text-text-faint" />
                <div className="mt-2 text-[13px] font-medium text-text-secondary">
                  {t('pages.sentryAutomations.noRules')}
                </div>
                <div className="mx-auto mt-1 max-w-sm text-[12px] text-text-muted">
                  {t('pages.sentryAutomations.noRulesHint')}
                </div>
                <button
                  type="button"
                  onClick={openNew}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-[12.5px] font-medium text-black hover:bg-white/90"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('pages.sentryAutomations.newRule')}
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center gap-3 rounded-xl border border-hairline-med bg-surface-veil px-4 py-3"
                  >
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={() => toggleMut.mutate(rule)}
                      disabled={toggleMut.isPending}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13.5px] font-medium text-text-primary">
                          {rule.name}
                        </span>
                        <span
                          className={cn(
                            'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                            rule.mode === 'auto'
                              ? 'bg-accent-purple/10 text-accent-purple'
                              : 'bg-accent-blue/10 text-accent-blue',
                          )}
                        >
                          {rule.mode === 'auto' ? (
                            <Sparkles className="h-2.5 w-2.5" />
                          ) : (
                            <Inbox className="h-2.5 w-2.5" />
                          )}
                          {rule.mode === 'auto'
                            ? t('pages.sentryAutomations.modeAutoShort')
                            : t('pages.sentryAutomations.modeProposeShort')}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[11.5px] text-text-muted">
                        {t(`pages.sentryErrors.level.${rule.minLevel}`)}+ ·{' '}
                        {rule.projectSlug ?? t('pages.sentryAutomations.anyProject')} ·{' '}
                        {agentName(rule.agentId)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => openEdit(rule)}
                      className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
                      title={t('pages.sentryAutomations.edit')}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(t('pages.sentryAutomations.deleteConfirm')))
                          deleteMut.mutate(rule.id);
                      }}
                      className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-red/15 hover:text-accent-red"
                      title={t('pages.sentryAutomations.delete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Execuções */}
          <section>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
              {t('pages.sentryAutomations.runsTitle')}
            </h2>
            {runs.length === 0 ? (
              <div className="rounded-xl border border-hairline bg-surface-ghost py-8 text-center text-[12px] text-text-muted">
                {t('pages.sentryAutomations.noRuns')}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-hairline">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() =>
                      run.action === 'analyzed' && run.detail
                        ? navigate(`/session/${run.detail}`)
                        : navigate(`/sentry/${run.issueId}`)
                    }
                    className="flex w-full items-center gap-3 border-b border-hairline-ghost px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-faint"
                  >
                    {run.status === 'error' ? (
                      <XCircle className="h-3.5 w-3.5 shrink-0 text-accent-red" />
                    ) : run.action === 'analyzed' ? (
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-purple" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent-green" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-[12.5px] text-text-primary">
                          {run.title ?? run.shortId ?? run.issueId}
                        </span>
                        {ruleNameById.has(run.ruleId) && (
                          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">
                            {ruleNameById.get(run.ruleId)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[11px] text-text-faint">
                        {run.status === 'error'
                          ? t('pages.sentryAutomations.runErrorLabel')
                          : run.action === 'analyzed'
                            ? t('pages.sentryAutomations.runAnalyzed')
                            : t('pages.sentryAutomations.runProposed')}
                        {run.shortId ? ` · ${run.shortId}` : ''}
                      </div>
                    </div>
                    <span className="shrink-0 text-[10.5px] text-text-faint">
                      {relativeTime(run.createdAt, lang)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {workspaceId && (
        <RuleEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          workspaceId={workspaceId}
          rule={editing}
          agents={agents}
          projects={projects}
          onSaved={() => {
            setEditorOpen(false);
            invalidate();
          }}
        />
      )}
    </PageShell>
  );
}

function RuleEditorDialog({
  open,
  onOpenChange,
  workspaceId,
  rule,
  agents,
  projects,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
  rule: Rule | null;
  agents: Agent[];
  projects: string[];
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open && (
          <RuleEditorForm
            workspaceId={workspaceId}
            rule={rule}
            agents={agents}
            projects={projects}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RuleEditorForm({
  workspaceId,
  rule,
  agents,
  projects,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  rule: Rule | null;
  agents: Agent[];
  projects: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(rule?.name ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [minLevel, setMinLevel] = useState(rule?.minLevel ?? 'error');
  const [projectSlug, setProjectSlug] = useState(rule?.projectSlug ?? '');
  const [agentId, setAgentId] = useState(rule?.agentId ?? '');
  const [mode, setMode] = useState<'propose' | 'auto'>(rule?.mode ?? 'propose');

  const saveMut = useMutation({
    mutationFn: () =>
      window.orkestral['sentry:save-rule']({
        id: rule?.id ?? null,
        workspaceId,
        name: name.trim(),
        enabled,
        minLevel,
        projectSlug: projectSlug || null,
        agentId: agentId || null,
        mode,
      }),
    onSuccess: () => {
      toast.success(t('pages.sentryAutomations.saved'));
      onSaved();
    },
    onError: (e) =>
      toast.error(
        t('pages.sentryAutomations.saveFailed'),
        e instanceof Error ? e.message : undefined,
      ),
  });

  const agentOptions = [
    { value: '', label: t('pages.sentryAutomations.ceoDefault') },
    ...agents.map((a) => ({
      value: a.id,
      label: a.name,
      icon: <AgentAvatar seed={a.avatarSeed} name={a.name} size={16} />,
    })),
  ];

  const submit = () => {
    if (!name.trim()) {
      toast.error(t('pages.sentryAutomations.nameRequired'));
      return;
    }
    saveMut.mutate();
  };

  return (
    <div className="p-6">
      <DialogTitle className="pr-8 text-[15px]">
        {rule ? t('pages.sentryAutomations.editorEdit') : t('pages.sentryAutomations.editorNew')}
      </DialogTitle>
      <DialogDescription className="mt-1 text-[12px] text-text-muted">
        {t('pages.sentryAutomations.subtitle')}
      </DialogDescription>

      <div className="mt-4 flex flex-col gap-3.5">
        <Field label={t('pages.sentryAutomations.name')}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('pages.sentryAutomations.namePlaceholder')}
            className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </Field>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline-med bg-surface-veil px-3.5 py-2.5">
          <span className="text-[12.5px] font-medium text-text-primary">
            {t('pages.sentryAutomations.enable')}
          </span>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <Field label={t('pages.sentryAutomations.minLevel')}>
          <DSSelect
            value={minLevel}
            onChange={setMinLevel}
            options={LEVELS.map((l) => ({ value: l, label: t(`pages.sentryErrors.level.${l}`) }))}
          />
        </Field>

        <Field label={t('pages.sentryAutomations.project')}>
          <DSSelect
            value={projectSlug}
            onChange={setProjectSlug}
            options={[
              { value: '', label: t('pages.sentryAutomations.anyProject'), muted: true },
              ...projects.map((p) => ({ value: p, label: p })),
            ]}
          />
        </Field>

        <Field label={t('pages.sentryAutomations.agent')}>
          <DSSelect value={agentId} onChange={setAgentId} options={agentOptions} />
        </Field>

        <Field
          label={t('pages.sentryAutomations.mode')}
          hint={t('pages.sentryAutomations.modeHint')}
        >
          <DSSelect
            value={mode}
            onChange={(v) => setMode(v as 'propose' | 'auto')}
            options={[
              { value: 'propose', label: t('pages.sentryAutomations.modePropose') },
              { value: 'auto', label: t('pages.sentryAutomations.modeAuto') },
            ]}
          />
        </Field>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={saveMut.isPending}
          className="rounded-md border border-hairline-heavy px-3 py-1.5 text-[12.5px] text-text-secondary hover:bg-surface-1 disabled:opacity-50"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saveMut.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
        >
          {saveMut.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5" />
          )}
          {t('pages.sentryAutomations.save')}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
        {label}
      </span>
      {children}
      {hint && <span className="text-[11px] leading-relaxed text-text-muted">{hint}</span>}
    </label>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-ghost px-3.5 py-3">
      <div className="truncate text-[19px] font-semibold tracking-tight text-text-primary">
        {value}
      </div>
      <div className="mt-0.5 truncate text-[10.5px] uppercase tracking-wide text-text-faint">
        {label}
      </div>
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {children}
      </div>
    </div>
  );
}
