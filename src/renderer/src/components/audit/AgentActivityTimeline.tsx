import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileEdit,
  FileText,
  Filter,
  Loader2,
  Play,
  Search,
  Shuffle,
  Sparkles,
  Terminal,
} from 'lucide-react';
import type {
  Agent,
  AgentTraceEvent,
  AgentTraceEventKind,
  AgentTraceEventStatus,
} from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { useT, type TFunction } from '@renderer/i18n';

/**
 * Timeline de atividade por-agente, embutida no Dashboard. Mostra TUDO que o
 * agente fez (nível-ação, via agent_trace_events), agrupado por issue, e — o
 * ponto-chave — O QUE ELE EDITOU: cada arquivo alterado com +adições/−remoções
 * (via issue:list-execution-events) e o diff real expansível (via git:diff do
 * working tree). Tudo com IPCs que já existem — sem schema/IPC novo.
 */

type KindFilter = 'all' | 'patch' | 'tool' | 'read' | 'generate' | 'validate' | 'error';

const FILTERS: KindFilter[] = ['all', 'patch', 'tool', 'read', 'generate', 'validate', 'error'];

const KIND_ICON: Record<AgentTraceEventKind, typeof Sparkles> = {
  run: Play,
  plan: ClipboardList,
  retrieve: Search,
  read: FileText,
  generate: Sparkles,
  tool: Terminal,
  patch: FileEdit,
  validate: CheckCircle2,
  learn: BookOpen,
  fallback: Shuffle,
  error: AlertCircle,
};

interface ChangedFile {
  filePath: string;
  additions: number;
  deletions: number;
  sourceId: string | null;
}

interface IssueGroup {
  issueId: string;
  label: string;
  events: AgentTraceEvent[];
  latest: string;
}

function statusColor(status: AgentTraceEventStatus): string {
  if (status === 'completed') return 'text-accent-green';
  if (status === 'failed') return 'text-accent-red';
  if (status === 'skipped') return 'text-text-faint';
  return 'text-accent-blue';
}

// Passos (trace) que aparecem por filtro. 'patch'/Mudanças não lista passos —
// mostra o bloco de arquivos alterados (que é o que o usuário quer ver).
function stepMatches(ev: AgentTraceEvent, f: KindFilter): boolean {
  if (f === 'all') return true;
  if (f === 'patch') return false;
  if (f === 'error') return ev.kind === 'error' || ev.status === 'failed';
  return ev.kind === f;
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short' });
}

function humanMs(ms: number | null | undefined): string | null {
  if (ms == null || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function AgentActivityTimeline({ agent }: { agent: Agent }) {
  const { t } = useT();
  const [filter, setFilter] = useState<KindFilter>('all');

  const traceQuery = useQuery({
    queryKey: ['agent-activity-trace', agent.workspaceId, agent.id],
    queryFn: () =>
      window.orkestral['logs:list-agent-trace-events']({
        workspaceId: agent.workspaceId,
        limit: 500,
      }),
    refetchInterval: 15_000,
  });

  const events = useMemo(
    () => (traceQuery.data ?? []).filter((e) => e.agentId === agent.id),
    [traceQuery.data, agent.id],
  );

  // Issues presentes na trilha → busca os arquivos alterados de cada uma.
  const issueIds = useMemo(
    () => [...new Set(events.map((e) => e.issueId).filter((x): x is string => !!x))],
    [events],
  );

  const execQuery = useQuery({
    queryKey: ['agent-file-changes', agent.id, issueIds.join(',')],
    enabled: issueIds.length > 0,
    queryFn: () =>
      window.orkestral['issue:list-execution-events']({ issueIds, limitPerIssue: 200 }),
  });

  const changesByIssue = useMemo(() => {
    const map: Record<string, ChangedFile[]> = {};
    const data = execQuery.data ?? {};
    for (const [issueId, evs] of Object.entries(data)) {
      const byPath = new Map<string, ChangedFile>();
      for (const ev of evs) {
        if (ev.type !== 'file-change' || !ev.filePath) continue;
        byPath.set(ev.filePath, {
          filePath: ev.filePath,
          additions: ev.additions ?? 0,
          deletions: ev.deletions ?? 0,
          sourceId: ev.sourceId ?? null,
        });
      }
      if (byPath.size > 0) map[issueId] = [...byPath.values()];
    }
    return map;
  }, [execQuery.data]);

  const summary = useMemo(() => {
    let tools = 0;
    for (const e of events) if (e.kind === 'tool') tools++;
    const filesChanged = Object.values(changesByIssue).reduce((n, f) => n + f.length, 0);
    return { actions: events.length, filesChanged, tools };
  }, [events, changesByIssue]);

  // Grupos por issue (apenas os passos que casam o filtro). Ordena grupos pela
  // atividade mais recente; passos dentro do grupo em ordem cronológica.
  const groups = useMemo<IssueGroup[]>(() => {
    const map = new Map<string, IssueGroup>();
    for (const e of events) {
      if (!e.issueId) continue;
      if (!stepMatches(e, filter)) continue;
      const g = map.get(e.issueId);
      if (g) {
        g.events.push(e);
        if (e.startedAt > g.latest) g.latest = e.startedAt;
      } else {
        map.set(e.issueId, {
          issueId: e.issueId,
          label: e.issueKey != null ? `#${e.issueKey}` : t('agents.audit.noIssue'),
          events: [e],
          latest: e.startedAt,
        });
      }
    }
    const arr = [...map.values()];
    for (const g of arr) g.events.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    arr.sort((a, b) => b.latest.localeCompare(a.latest));
    return arr;
  }, [events, filter, t]);

  const showChanges = filter === 'all' || filter === 'patch';

  // Lista final: grupos com passos visíveis, ou (quando showChanges) grupos que
  // têm arquivos alterados mesmo sem passo casando o filtro.
  const visibleGroups = useMemo(() => {
    const ids = new Set(groups.map((g) => g.issueId));
    const extra: IssueGroup[] = [];
    if (showChanges) {
      for (const issueId of Object.keys(changesByIssue)) {
        if (ids.has(issueId)) continue;
        const any = events.find((e) => e.issueId === issueId);
        extra.push({
          issueId,
          label: any?.issueKey != null ? `#${any.issueKey}` : t('agents.audit.noIssue'),
          events: [],
          latest: any?.startedAt ?? '',
        });
      }
    }
    return [...groups, ...extra]
      .filter(
        (g) => g.events.length > 0 || (showChanges && (changesByIssue[g.issueId]?.length ?? 0) > 0),
      )
      .sort((a, b) => b.latest.localeCompare(a.latest));
  }, [groups, changesByIssue, showChanges, events, t]);

  if (traceQuery.isPending) {
    return <div className="text-[13px] text-text-muted">{t('common.loading')}</div>;
  }

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-hairline px-6 py-10 text-center">
        <Activity className="mx-auto h-5 w-5 text-text-faint" />
        <div className="mt-2 text-[13px] font-medium text-text-secondary">
          {t('agents.audit.empty')}
        </div>
        <div className="mx-auto mt-1 max-w-sm text-[11.5px] text-text-muted">
          {t('agents.audit.emptyHint')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11.5px] text-text-muted">
          {t('agents.audit.summary', {
            actions: summary.actions,
            files: summary.filesChanged,
            tools: summary.tools,
          })}
        </span>
        <span className="flex-1" />
        <Filter className="h-3.5 w-3.5 text-text-faint" />
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
              filter === f
                ? 'border-hairline-strong bg-surface-active text-text-primary'
                : 'border-hairline bg-surface-faint text-text-muted hover:text-text-primary',
            )}
          >
            {t(`agents.audit.filters.${f}`)}
          </button>
        ))}
      </div>

      {visibleGroups.length === 0 ? (
        <div className="rounded-md border border-dashed border-hairline px-4 py-6 text-center text-[12px] text-text-muted">
          {t('agents.audit.noneForFilter')}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {visibleGroups.map((g) => {
            const files = changesByIssue[g.issueId] ?? [];
            return (
              <div key={g.issueId} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-faint">
                  <span className="font-mono text-text-muted">{g.label}</span>
                  <span className="h-px flex-1 bg-surface-2" />
                  {g.latest && (
                    <span className="lowercase tracking-normal">{fmtDay(g.latest)}</span>
                  )}
                </div>

                {showChanges && files.length > 0 && <ChangedFiles files={files} t={t} />}

                {g.events.map((ev) => (
                  <AuditRow key={ev.id} ev={ev} t={t} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChangedFiles({ files, t }: { files: ChangedFile[]; t: TFunction }) {
  return (
    <div className="rounded-md border border-hairline-faint bg-surface-veil">
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wider text-text-faint">
        <FileEdit className="h-3 w-3" />
        {t('agents.audit.changedFiles')}
        <span className="text-text-muted">· {files.length}</span>
      </div>
      <div className="flex flex-col">
        {files.map((f) => (
          <FileDiffRow key={f.filePath} file={f} t={t} />
        ))}
      </div>
    </div>
  );
}

function FileDiffRow({ file, t }: { file: ChangedFile; t: TFunction }) {
  const [open, setOpen] = useState(false);
  const diffQuery = useQuery({
    queryKey: ['git-diff', file.sourceId, file.filePath],
    enabled: open && !!file.sourceId,
    queryFn: () =>
      window.orkestral['git:diff']({
        sourceId: file.sourceId!,
        filePath: file.filePath,
        staged: false,
      }),
  });

  const diff = diffQuery.data?.diff ?? '';

  return (
    <div className="border-t border-hairline-faint first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-faint"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-faint" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary">
          {file.filePath}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-accent-green">+{file.additions}</span>
        <span className="shrink-0 font-mono text-[11px] text-accent-red">−{file.deletions}</span>
      </button>
      {open && (
        <div className="px-3 pb-2">
          {!file.sourceId ? (
            <div className="text-[11px] text-text-faint">{t('agents.audit.noDiff')}</div>
          ) : diffQuery.isPending ? (
            <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> {t('common.loading')}
            </div>
          ) : diffQuery.isError ? (
            <div className="text-[11px] text-accent-red">{t('agents.audit.diffError')}</div>
          ) : diff.trim() === '' ? (
            <div className="text-[11px] text-text-faint">{t('agents.audit.noDiff')}</div>
          ) : (
            <DiffBlock diff={diff} t={t} />
          )}
        </div>
      )}
    </div>
  );
}

function DiffBlock({ diff, t }: { diff: string; t: TFunction }) {
  const lines = diff.split('\n');
  const MAX = 160;
  const shown = lines.slice(0, MAX);
  return (
    <div className="thin-scrollbar overflow-auto rounded-md border border-hairline-faint font-mono text-[11px] leading-[1.6]">
      {shown.map((ln, i) => {
        const add = ln.startsWith('+') && !ln.startsWith('+++');
        const del = ln.startsWith('-') && !ln.startsWith('---');
        const hunk = ln.startsWith('@@');
        const meta =
          ln.startsWith('diff ') ||
          ln.startsWith('index ') ||
          ln.startsWith('+++') ||
          ln.startsWith('---');
        return (
          <div
            key={i}
            className={cn(
              'whitespace-pre px-2',
              add && 'bg-accent-green/[0.10] text-accent-green',
              del && 'bg-accent-red/[0.10] text-accent-red',
              hunk && 'text-accent-blue',
              meta && 'text-text-faint',
              !add && !del && !hunk && !meta && 'text-text-secondary',
            )}
          >
            {ln || ' '}
          </div>
        );
      })}
      {lines.length > MAX && (
        <div className="px-2 py-1 text-[10.5px] text-text-faint">
          {t('agents.audit.diffTruncated', { n: lines.length })}
        </div>
      )}
    </div>
  );
}

function AuditRow({ ev, t }: { ev: AgentTraceEvent; t: TFunction }) {
  const Icon = KIND_ICON[ev.kind];
  const dur = humanMs(ev.durationMs);
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-hairline-faint bg-surface-veil px-3 py-2">
      <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', statusColor(ev.status))} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] text-text-primary">{ev.title}</span>
          <span className="shrink-0 rounded border border-hairline-faint bg-surface-1 px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wider text-text-faint">
            {t(`agents.audit.kind.${ev.kind}`)}
          </span>
        </div>
        {ev.summary && (
          <div className="mt-0.5 truncate text-[11px] text-text-muted">{ev.summary}</div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-[10px] text-text-faint">{fmtClock(ev.startedAt)}</span>
        {dur && <span className="text-[10px] text-text-faint">{dur}</span>}
      </div>
    </div>
  );
}
