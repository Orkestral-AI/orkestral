import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Inbox,
  Loader2,
  Pencil,
  Plus,
  Signal,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { Switch } from '@renderer/components/ui/switch';
import { ConfirmDialog } from '@renderer/components/ui/confirm-dialog';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { toast } from '@renderer/stores/toastStore';
import { useT, type TFunction } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';
import type { Agent } from '@shared/types';

type Provider = 'new_relic' | 'better_stack';
type RuleKind = 'all' | 'error' | 'incident' | 'log';
type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  kind: RuleKind;
  severity: string | null;
  serviceQuery: string | null;
  agentId: string | null;
  mode: 'propose' | 'auto';
  refreshIntervalMin: number;
};

const META: Record<Provider, { icon: typeof Activity }> = {
  new_relic: { icon: Activity },
  better_stack: { icon: Signal },
};

function kindOptions(t: TFunction) {
  return [
    { value: 'all', label: t('observability.automations.kindAll') },
    { value: 'error', label: t('observability.automations.kindError') },
    { value: 'incident', label: t('observability.automations.kindIncident') },
    { value: 'log', label: t('observability.automations.kindLog') },
  ];
}

const INTERVALS = [0, 1, 5, 15, 30, 60] as const;

export function ObservabilityAutomationsPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { provider: rawProvider = 'new_relic' } = useParams();
  const provider: Provider = rawProvider === 'better_stack' ? 'better_stack' : 'new_relic';
  const providerName = t(`observability.providers.${provider}`);
  const Icon = META[provider].icon;
  const workspaceId = useWorkspaceStore((s) => s.active?.id);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [deletingRule, setDeletingRule] = useState<Rule | null>(null);

  const accountQuery = useQuery({
    queryKey: ['observability', 'account', provider, workspaceId],
    queryFn: () =>
      window.orkestral['observability:get-account']({ workspaceId: workspaceId!, provider }),
    enabled: !!workspaceId,
  });
  const rulesQuery = useQuery({
    queryKey: ['observability', 'rules', provider, workspaceId],
    queryFn: () =>
      window.orkestral['observability:list-rules']({ workspaceId: workspaceId!, provider }),
    enabled: !!workspaceId && !!accountQuery.data,
  });
  const runsQuery = useQuery({
    queryKey: ['observability', 'runs', provider, workspaceId],
    queryFn: () =>
      window.orkestral['observability:list-runs']({
        workspaceId: workspaceId!,
        provider,
        limit: 50,
      }),
    enabled: !!workspaceId && !!accountQuery.data,
    refetchInterval: 15_000,
  });
  const agentsQuery = useQuery({
    queryKey: ['agents', workspaceId],
    queryFn: () => window.orkestral['agent:list']({ workspaceId: workspaceId! }),
    enabled: !!workspaceId,
  });

  const rules = rulesQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const activeRules = rules.filter((r) => r.enabled).length;
  const ruleNameById = new Map(rules.map((r) => [r.id, r.name]));

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['observability', 'rules'] });
    void qc.invalidateQueries({ queryKey: ['observability', 'runs'] });
  };

  const toggleMut = useMutation({
    mutationFn: (rule: Rule) =>
      window.orkestral['observability:save-rule']({
        ...rule,
        workspaceId: workspaceId!,
        provider,
        enabled: !rule.enabled,
      }),
    onSuccess: invalidate,
    onError: (e) => toast.error(t('observability.automations.saveError'), errorMessage(e)),
  });
  const deleteMut = useMutation({
    mutationFn: (ruleId: string) => window.orkestral['observability:delete-rule']({ ruleId }),
    onSuccess: () => {
      invalidate();
      toast.success(t('observability.automations.ruleRemoved'));
    },
    onError: (e) => toast.error(t('observability.automations.deleteError'), errorMessage(e)),
  });

  return (
    <PageShell>
      <div className="window-drag border-b border-hairline-soft px-8 pt-5">
        <button
          type="button"
          onClick={() => navigate(`/observability/${provider}`)}
          className="window-no-drag mb-2 inline-flex items-center gap-1 text-[11.5px] text-text-muted transition-colors hover:text-text-secondary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {providerName}
        </button>
        <div className="flex items-end justify-between gap-4 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-text-secondary" />
              <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">
                {t('observability.automations.title', { name: providerName })}
              </h1>
            </div>
            <p className="mt-0.5 text-[12.5px] text-text-muted">
              {t('observability.automations.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditing(emptyRule())}
            disabled={!accountQuery.data}
            className="window-no-drag inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-heavy bg-surface-hover px-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-white/20 hover:bg-surface-4 hover:text-text-primary disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('observability.automations.newRule')}
          </button>
        </div>
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-8 py-5">
        {!accountQuery.data ? (
          <Centered>{t('observability.automations.connectFirst', { name: providerName })}</Centered>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-2.5">
                <StatCard
                  label={t('observability.automations.activeRules')}
                  value={`${activeRules}/${rules.length}`}
                />
                <StatCard label={t('observability.automations.runs')} value={String(runs.length)} />
                <StatCard
                  label={t('observability.automations.lastRun')}
                  value={runs[0] ? relativeTime(runs[0].createdAt) : '-'}
                />
              </div>

              <section>
                <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                  {t('observability.automations.rules')}
                </div>
                {rulesQuery.isPending ? (
                  <Loading />
                ) : rules.length === 0 ? (
                  <EmptyState label={t('observability.automations.rulesEmpty')} />
                ) : (
                  <div className="overflow-hidden rounded-xl border border-hairline bg-surface-whisper">
                    {rules.map((rule) => (
                      <div
                        key={rule.id}
                        className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
                      >
                        <Switch
                          checked={rule.enabled}
                          onCheckedChange={() => toggleMut.mutate(rule)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-text-primary">
                            {rule.name}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-[10.5px] text-text-faint">
                            <span>{rule.kind}</span>
                            <span>
                              {rule.severity || t('observability.automations.anySeverity')}
                            </span>
                            <span>
                              {rule.serviceQuery || t('observability.automations.anyService')}
                            </span>
                            <span>{agentName(t, agents, rule.agentId)}</span>
                            <span>
                              {rule.refreshIntervalMin === 0
                                ? t('observability.automations.off')
                                : `${rule.refreshIntervalMin}m`}
                            </span>
                          </div>
                        </div>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium',
                            rule.mode === 'auto'
                              ? 'bg-accent-green/10 text-accent-green'
                              : 'bg-accent-blue/10 text-accent-blue',
                          )}
                        >
                          {rule.mode === 'auto' ? (
                            <Zap className="h-3 w-3" />
                          ) : (
                            <Inbox className="h-3 w-3" />
                          )}
                          {rule.mode}
                        </span>
                        <IconButton
                          label={t('observability.automations.editRule')}
                          onClick={() => setEditing(rule)}
                          icon={<Pencil className="h-3.5 w-3.5" />}
                        />
                        <IconButton
                          label={t('observability.automations.delete')}
                          onClick={() => setDeletingRule(rule)}
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                  {t('observability.automations.runs')}
                </div>
                {runsQuery.isPending ? (
                  <Loading />
                ) : runs.length === 0 ? (
                  <div className="rounded-xl border border-hairline bg-surface-whisper p-4 text-[12px] text-text-muted">
                    {t('observability.automations.runsEmpty')}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-hairline bg-surface-whisper">
                    {runs.map((run) => (
                      <div
                        key={run.id}
                        className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
                      >
                        {run.status === 'ok' ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-accent-green" />
                        ) : (
                          <XCircle className="h-4 w-4 shrink-0 text-accent-red" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] text-text-primary">
                            {run.title ?? run.signalId}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[10px] text-text-faint">
                            {ruleNameById.get(run.ruleId) ?? t('observability.automations.rule')} ·{' '}
                            {run.action} · {relativeTime(run.createdAt)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <RuleEditor
              key={editing?.id ?? 'new'}
              providerName={providerName}
              rule={editing}
              agents={agents}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                invalidate();
              }}
            />
          </div>
        )}
      </div>

      {deletingRule && (
        <ConfirmDialog
          title={t('observability.automations.deleteConfirmTitle', { name: deletingRule.name })}
          body={t('observability.automations.deleteConfirmBody')}
          confirmLabel={t('observability.automations.delete')}
          cancelLabel={t('observability.automations.cancel')}
          busy={deleteMut.isPending}
          onCancel={() => setDeletingRule(null)}
          onConfirm={() => {
            deleteMut.mutate(deletingRule.id);
            setDeletingRule(null);
          }}
        />
      )}
    </PageShell>
  );
}

function RuleEditor({
  providerName,
  rule,
  agents,
  onClose,
  onSaved,
}: {
  providerName: string;
  rule: Rule | null;
  agents: Agent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const { provider: rawProvider = 'new_relic' } = useParams();
  const provider: Provider = rawProvider === 'better_stack' ? 'better_stack' : 'new_relic';
  const workspaceId = useWorkspaceStore((s) => s.active?.id);
  const [draft, setDraft] = useState<Rule>(rule ?? emptyRule());

  const saveMut = useMutation({
    mutationFn: () =>
      window.orkestral['observability:save-rule']({
        ...draft,
        id: draft.id || null,
        workspaceId: workspaceId!,
        provider,
      }),
    onSuccess: () => {
      toast.success(t('observability.automations.ruleSaved'));
      onSaved();
    },
    onError: (e) => toast.error(t('observability.automations.saveError'), errorMessage(e)),
  });

  if (!rule) {
    return (
      <aside className="rounded-xl border border-hairline bg-surface-whisper p-5">
        <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center">
          <Sparkles className="h-5 w-5 text-text-faint" />
          <div className="mt-3 text-[13px] font-medium text-text-secondary">
            {t('observability.automations.selectOrCreate')}
          </div>
          <p className="mt-1 max-w-xs text-[12px] leading-relaxed text-text-muted">
            {t('observability.automations.editorHint', { name: providerName })}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="rounded-xl border border-hairline bg-surface-whisper p-5">
      <div className="mb-4 text-[12px] font-semibold uppercase tracking-wider text-text-muted">
        {draft.id
          ? t('observability.automations.editRule')
          : t('observability.automations.newRule')}
      </div>
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-text-secondary">
            {t('observability.automations.name')}
          </span>
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            className="h-9 w-full rounded-md border border-hairline-strong bg-surface-hover px-3 text-[13px] text-text-primary outline-none focus:border-white/20"
            placeholder={t('observability.automations.namePlaceholder')}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('observability.automations.kind')}>
            <DSSelect
              value={draft.kind}
              onChange={(v) => setDraft((d) => ({ ...d, kind: v as RuleKind }))}
              options={kindOptions(t)}
            />
          </Field>
          <Field label={t('observability.automations.mode')}>
            <DSSelect
              value={draft.mode}
              onChange={(v) => setDraft((d) => ({ ...d, mode: v === 'auto' ? 'auto' : 'propose' }))}
              options={[
                { value: 'propose', label: t('observability.automations.inboxProposal') },
                { value: 'auto', label: t('observability.automations.autoAnalyze') },
              ]}
            />
          </Field>
        </div>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-text-secondary">
            {t('observability.automations.severityContains')}
          </span>
          <input
            value={draft.severity ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, severity: e.target.value || null }))}
            className="h-9 w-full rounded-md border border-hairline-strong bg-surface-hover px-3 text-[13px] text-text-primary outline-none focus:border-white/20"
            placeholder={t('observability.automations.severityPlaceholder')}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-text-secondary">
            {t('observability.automations.serviceContains')}
          </span>
          <input
            value={draft.serviceQuery ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, serviceQuery: e.target.value || null }))}
            className="h-9 w-full rounded-md border border-hairline-strong bg-surface-hover px-3 text-[13px] text-text-primary outline-none focus:border-white/20"
            placeholder={t('observability.automations.servicePlaceholder')}
          />
        </label>
        <Field label={t('observability.automations.agent')}>
          <DSSelect
            value={draft.agentId ?? ''}
            onChange={(v) => setDraft((d) => ({ ...d, agentId: v || null }))}
            options={[
              { value: '', label: t('observability.automations.ceoOrchestrator') },
              ...agents.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        </Field>
        <Field label={t('observability.automations.refresh')}>
          <DSSelect
            value={String(draft.refreshIntervalMin)}
            onChange={(v) => setDraft((d) => ({ ...d, refreshIntervalMin: Number(v) }))}
            options={INTERVALS.map((n) => ({
              value: String(n),
              label:
                n === 0
                  ? t('observability.automations.off')
                  : t('observability.automations.everyM', { n }),
            }))}
          />
        </Field>
        <label className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2">
          <span className="text-[12px] text-text-secondary">
            {t('observability.automations.enabled')}
          </span>
          <Switch
            checked={draft.enabled}
            onCheckedChange={(checked) => setDraft((d) => ({ ...d, enabled: checked }))}
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-hairline-strong px-3 text-[12px] text-text-secondary hover:bg-surface-2"
          >
            {t('observability.automations.cancel')}
          </button>
          <button
            type="button"
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {saveMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('observability.automations.save')}
          </button>
        </div>
      </div>
    </aside>
  );
}

function emptyRule(): Rule {
  return {
    id: '',
    name: '',
    enabled: true,
    kind: 'all',
    severity: null,
    serviceQuery: null,
    agentId: null,
    mode: 'propose',
    refreshIntervalMin: 5,
  };
}

function agentName(t: TFunction, agents: Agent[], id: string | null): string {
  if (!id) return 'CEO';
  return agents.find((a) => a.id === id)?.name ?? t('observability.automations.agent');
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!then) return '-';
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (abs < hour) return rtf.format(Math.round(diff / min), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  return rtf.format(Math.round(diff / day), 'day');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-veil px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-text-faint">{label}</div>
      <div className="mt-1 text-[17px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
    >
      {icon}
    </button>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center rounded-xl border border-hairline py-10 text-text-muted">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-whisper p-4 text-[12px] text-text-muted">
      {label}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
      {children}
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
