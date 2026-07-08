import { useEffect, useMemo, useRef, useState, useCallback, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Cpu,
  CircleDot,
  Brain,
  MessageSquare,
  GitPullRequestArrow,
  Cog,
  Search,
  Trash2,
  ArrowDown,
  SquareTerminal,
  Sparkles,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  FileText,
  Check,
  X,
  Clock,
  Pause,
  Play,
  Wand2,
  Coins,
  DollarSign,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { useT, type TFunction } from '@renderer/i18n';
import type {
  Agent,
  TraceEntry,
  TraceSource,
  TraceLevel,
  TaskExecutionRecord,
} from '@shared/types';

const MAX_ENTRIES = 1500;

const SOURCE_META: Record<TraceSource, { label: string; chip: string; icon: LucideIcon }> = {
  forge: { label: 'forge', chip: 'bg-accent-purple/15 text-accent-purple', icon: Cpu },
  embedding: { label: 'embed', chip: 'bg-accent-cyan/15 text-accent-cyan', icon: Search },
  issue: { label: 'issue', chip: 'bg-accent-yellow/15 text-accent-yellow', icon: CircleDot },
  chat: { label: 'chat', chip: 'bg-accent-green/15 text-accent-green', icon: MessageSquare },
  review: {
    label: 'review',
    chip: 'bg-accent-yellow/15 text-accent-yellow',
    icon: GitPullRequestArrow,
  },
  learning: { label: 'learn', chip: 'bg-accent-green/15 text-accent-green', icon: Brain },
  system: { label: 'sys', chip: 'bg-white/[0.06] text-text-muted', icon: Cog },
  'model-routing': {
    label: 'route',
    chip: 'bg-accent-blue/15 text-accent-blue',
    icon: Sparkles,
  },
};

const LEVEL_TEXT: Record<TraceLevel, string> = {
  error: 'text-accent-red',
  warn: 'text-accent-yellow',
  success: 'text-accent-green',
  info: 'text-text-secondary',
  debug: 'text-text-faint',
};

/** Paleta colorida pros avatares de agente (ciclada por índice). */
const AGENT_COLORS = [
  {
    dot: 'bg-accent-purple',
    bar: 'bg-accent-purple',
    text: 'text-accent-purple',
    soft: 'bg-accent-purple/10',
  },
  {
    dot: 'bg-accent-blue',
    bar: 'bg-accent-blue',
    text: 'text-accent-blue',
    soft: 'bg-accent-blue/10',
  },
  {
    dot: 'bg-accent-green',
    bar: 'bg-accent-green',
    text: 'text-accent-green',
    soft: 'bg-accent-green/10',
  },
  {
    dot: 'bg-accent-yellow',
    bar: 'bg-accent-yellow',
    text: 'text-accent-yellow',
    soft: 'bg-accent-yellow/10',
  },
  { dot: 'bg-accent-red', bar: 'bg-accent-red', text: 'text-accent-red', soft: 'bg-accent-red/10' },
];

type FilterKey = 'all' | TraceSource;

const FILTERS: { key: FilterKey; labelKey: string }[] = [
  { key: 'all', labelKey: 'pages.logs.filterAll' },
  { key: 'embedding', labelKey: 'pages.logs.filterEmbedding' },
  { key: 'issue', labelKey: 'pages.logs.filterIssues' },
  { key: 'chat', labelKey: 'pages.logs.filterChat' },
  { key: 'review', labelKey: 'pages.logs.filterReview' },
];

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, l = 2): string => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Rótulo do bloco de tempo (HH:MM) usado nos separadores do stream. */
function fmtBlock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Formata contagem de tokens de forma compacta (1500 -> 1.5k). */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function LogsPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  // Pausa o stream ao vivo: o backfill/eventos continuam chegando, mas as novas
  // linhas ficam num buffer e só entram na lista quando o usuário retoma.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  const bufferRef = useRef<TraceEntry[]>([]);
  // Espelha `paused` num ref pra o handler do stream ler o valor atual sem
  // reassinar o evento a cada toggle (o sync vai num effect, não no render).
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const agentsQuery = useQuery({
    queryKey: ['agents', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: activeWorkspace!.id }),
  });
  const agents = agentsQuery.data ?? [];

  // O canal `logs:*` é montado no preload. Em dev, mudar o contrato exige
  // reiniciar o `npm run dev` (preload não tem HMR). Guardamos pra nunca
  // derrubar o app inteiro caso o preload esteja desatualizado.
  const apiReady =
    typeof window.orkestral?.['logs:list'] === 'function' &&
    typeof window.orkestralEvents?.onLogEntry === 'function';

  // Backfill + stream ao vivo.
  useEffect(() => {
    if (!apiReady) return;
    let mounted = true;
    window.orkestral['logs:list']({ limit: MAX_ENTRIES }).then((list) => {
      if (mounted) setEntries(list);
    });
    const off = window.orkestralEvents.onLogEntry((entry) => {
      // Quando pausado, segura a linha no buffer (não re-renderiza a lista).
      if (pausedRef.current) {
        bufferRef.current.push(entry);
        if (bufferRef.current.length > MAX_ENTRIES) {
          bufferRef.current = bufferRef.current.slice(bufferRef.current.length - MAX_ENTRIES);
        }
        return;
      }
      setEntries((prev) => {
        const next = prev.length >= MAX_ENTRIES ? prev.slice(prev.length - MAX_ENTRIES + 1) : prev;
        return [...next, entry];
      });
    });
    return () => {
      mounted = false;
      off();
    };
  }, [apiReady]);

  // Ao retomar, drena o buffer acumulado durante a pausa.
  const togglePause = useCallback(() => {
    setPaused((wasPaused) => {
      if (wasPaused && bufferRef.current.length > 0) {
        const drained = bufferRef.current;
        bufferRef.current = [];
        setEntries((prev) => {
          const merged = [...prev, ...drained];
          return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged;
        });
      }
      return !wasPaused;
    });
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter !== 'all' && e.source !== filter) return false;
      if (q && !`${e.message} ${e.agentName ?? ''} ${e.scope ?? ''}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [entries, filter, query]);

  async function clearLogs(): Promise<void> {
    if (typeof window.orkestral?.['logs:clear'] === 'function') {
      await window.orkestral['logs:clear']({});
    }
    bufferRef.current = [];
    setEntries([]);
  }

  return (
    <div className="flex h-full flex-col pb-4 pl-2 pr-4 pt-4">
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-background">
        {/* ---- Coluna principal: o stream ---- */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Header enxuto */}
          <div className="window-drag flex shrink-0 items-start justify-between gap-3 px-6 pb-4 pt-5">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-[21px] font-semibold tracking-tight text-text-primary">
                  {t('pages.logs.title')}
                </h1>
                <span className="window-no-drag inline-flex items-center gap-1.5 rounded-full border border-accent-green/30 bg-accent-green/10 px-2.5 py-1 text-[12px] font-medium text-accent-green">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-green opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent-green" />
                  </span>
                  {t('pages.logs.live')}
                </span>
              </div>
              <p className="mt-1.5 text-[13px] text-text-muted">{t('pages.logs.subtitle')}</p>
            </div>
          </div>

          {!activeWorkspace ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
              {t('pages.logs.noActiveWorkspace')}
            </div>
          ) : !apiReady ? (
            <div className="flex flex-1 flex-col items-center justify-center text-center">
              <SquareTerminal className="h-7 w-7 text-text-muted" />
              <div className="mt-3 text-[13px] font-medium text-text-primary">
                {t('pages.logs.restartTitle')}
              </div>
              <div className="mt-1 max-w-md text-[12px] text-text-muted">
                {t('pages.logs.restartDesc1')}
                <span className="font-mono"> npm run dev</span>
                {t('pages.logs.restartDesc2')}
              </div>
            </div>
          ) : (
            <Terminal
              entries={visible}
              total={entries.length}
              filter={filter}
              onFilter={setFilter}
              query={query}
              onQuery={setQuery}
              paused={paused}
              onTogglePause={togglePause}
              onClear={clearLogs}
              workspaceId={activeWorkspace.id}
              t={t}
            />
          )}
        </div>

        {/* ---- Rail de insights (coluna direita) ---- */}
        {activeWorkspace && apiReady && (
          <aside className="thin-scrollbar w-[286px] shrink-0 overflow-y-auto border-l border-hairline bg-rail px-4 py-4">
            <InsightsRail
              workspaceId={activeWorkspace.id}
              agents={agents}
              entries={entries}
              t={t}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   RAIL DE INSIGHTS (coluna direita)
   ============================================================ */

function InsightsRail({
  workspaceId,
  agents,
  entries,
  t,
}: {
  workspaceId: string;
  agents: Agent[];
  entries: TraceEntry[];
  t: TFunction;
}) {
  return (
    <div className="flex flex-col gap-5">
      <ConsumptionPanel workspaceId={workspaceId} t={t} />
      <DiagnosticsPanel workspaceId={workspaceId} t={t} />
      <MemoryPanel t={t} />
      <AgentDashboard agents={agents} entries={entries} t={t} />
    </div>
  );
}

/* ------------------------------ Consumo (tokens gastos + custo) --------- */

/**
 * Painel de CONSUMO: tokens GASTOS no projeto (entrada + saída) e o custo, total
 * e médio por run. Mesma agregação da saúde (`diagnostics:get`). Some sem runs.
 */
function ConsumptionPanel({ workspaceId, t }: { workspaceId: string; t: TFunction }) {
  const has = typeof window.orkestral?.['diagnostics:get'] === 'function';
  const q = useQuery({
    queryKey: ['diagnostics', workspaceId],
    enabled: has,
    refetchInterval: 15_000,
    queryFn: () => window.orkestral['diagnostics:get']({ workspaceId }),
  });
  const m = q.data?.metrics;
  if (!m || m.totalRuns === 0) return null;
  const tokensSpent = m.totalTokensIn + m.totalTokensOut;
  const avgCost = m.totalRuns > 0 ? m.totalCostUsd / m.totalRuns : 0;
  const usd = (n: number): string => `$${n > 0 && n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {t('pages.logs.rail.consumption')}
        </span>
        <span className="font-mono text-[11px] text-text-faint">
          {t('pages.logs.rail.consumptionRuns', { runs: m.totalRuns })}
        </span>
      </div>
      <div className="flex flex-col gap-2.5 rounded-xl border border-hairline bg-rail-card px-3.5 py-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[12px] text-text-secondary">
            <Coins className="h-3.5 w-3.5 text-text-faint" />
            {t('pages.logs.rail.tokensSpent')}
          </span>
          <span className="font-mono text-[12.5px] font-semibold text-text-primary">
            {formatTokens(tokensSpent)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[12px] text-text-secondary">
            <DollarSign className="h-3.5 w-3.5 text-text-faint" />
            {t('pages.logs.rail.totalCost')}
          </span>
          <span className="font-mono text-[12.5px] font-semibold text-text-primary">
            {usd(m.totalCostUsd)}
          </span>
        </div>
        <div className="flex items-center justify-between border-t border-hairline pt-2">
          <span className="text-[12px] text-text-muted">{t('pages.logs.rail.avgCost')}</span>
          <span className="font-mono text-[12px] text-text-secondary">{usd(avgCost)}</span>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Diagnóstico de saúde + métricas --------- */

/**
 * Painel de SAÚDE (inspirado no kanban_diagnostics do Hermes): findings
 * heurísticos (run suspeita/travada/falha) + uma linha de métricas agregadas.
 * Dados de `diagnostics:get`. Some quando não há runs. Atualiza a cada 15s.
 */
function DiagnosticsPanel({ workspaceId, t }: { workspaceId: string; t: TFunction }) {
  const has = typeof window.orkestral?.['diagnostics:get'] === 'function';
  const q = useQuery({
    queryKey: ['diagnostics', workspaceId],
    enabled: has,
    refetchInterval: 15_000,
    queryFn: () => window.orkestral['diagnostics:get']({ workspaceId }),
  });
  const data = q.data;
  if (!data || data.metrics.totalRuns === 0) return null;
  const { findings, metrics } = data;
  const dot = (s: 'high' | 'medium' | 'low'): string =>
    cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', {
      'bg-accent-red': s === 'high',
      'bg-accent-yellow': s === 'medium',
      'bg-text-faint': s === 'low',
    });
  const label = (s: 'high' | 'medium' | 'low'): string =>
    cn('shrink-0 font-medium', {
      'text-accent-red': s === 'high',
      'text-accent-yellow': s === 'medium',
      'text-text-muted': s === 'low',
    });
  const healthy = findings.length === 0;
  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {t('pages.logs.rail.health')}
        </span>
        <span className="text-[11px] text-text-faint">
          {t('pages.logs.rail.healthRuns', { runs: metrics.totalRuns, failed: metrics.failed })}
        </span>
      </div>
      {healthy ? (
        <div className="flex items-center gap-3 rounded-xl border border-hairline bg-rail-card px-3.5 py-3">
          <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[9px] border border-accent-purple/30 bg-accent-purple/15">
            <Check className="h-[15px] w-[15px] text-accent-purple" />
          </span>
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold text-text-primary">
              {t('pages.logs.rail.allHealthy')}
            </div>
            <div className="text-[11.5px] text-text-muted">
              {t('pages.logs.rail.allHealthySub')}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1 rounded-xl border border-hairline bg-rail-card px-3.5 py-3">
          {findings.slice(0, 12).map((f, i) => {
            // Fallback: t() devolve a própria key em miss; se um kind futuro não
            // tiver tradução, mostra o kind cru em vez do path da chave.
            const key = `pages.logs.diagnostics.${f.kind}`;
            const kindLabel = t(key);
            return (
              <div
                key={`${f.issueId}-${f.kind}-${i}`}
                className="flex items-start gap-2 text-[12px]"
              >
                <span className={dot(f.severity)} />
                <span className="shrink-0 font-mono text-text-secondary">{f.issueKey}</span>
                <span className={label(f.severity)}>{kindLabel === key ? f.kind : kindLabel}</span>
                <span className="min-w-0 text-text-muted">— {f.detail}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ------------------------------ Memória (app + modelos locais) ao vivo --- */

const MEMORY_MODEL_META: Record<'forge' | 'fast-apply' | 'embeddings', LucideIcon> = {
  forge: Cpu,
  'fast-apply': Wand2,
  embeddings: Search,
};

/**
 * Monitor de RAM AO VIVO: RSS do processo (app + modelos locais nativos do
 * llama.cpp) como barra sobre o total da máquina, + linhas idle/loaded de cada
 * modelo residente (Forge, Fast-Apply, Embeddings). Atualiza a cada 2s.
 */
function MemoryPanel({ t }: { t: TFunction }) {
  const has = typeof window.orkestral?.['system:memory-stats'] === 'function';
  const q = useQuery({
    queryKey: ['memory-stats'],
    enabled: has,
    refetchInterval: 2_000,
    queryFn: () => window.orkestral['system:memory-stats'](),
  });
  const d = q.data;
  if (!d) return null;
  const pct = d.totalMemMb > 0 ? Math.min(100, Math.round((d.rssMb / d.totalMemMb) * 100)) : 0;
  const gb = (mb: number): string => (mb / 1024).toFixed(1);
  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {t('pages.logs.rail.memory')}
        </span>
        <span className="font-mono text-[11px] text-text-muted">
          {gb(d.rssMb)} / {gb(d.totalMemMb)} GB · {pct}%
        </span>
      </div>
      <div className="rounded-xl border border-hairline bg-rail-card px-3.5 py-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={cn('h-full rounded-full transition-[width] duration-500 ease-out', {
              'bg-accent-red': pct > 85,
              'bg-accent-yellow': pct > 65 && pct <= 85,
              'bg-accent': pct <= 65,
            })}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {d.models
            .filter((m) => m.kind !== 'forge')
            .map((m) => {
              const Icon = MEMORY_MODEL_META[m.kind];
              return (
                <div key={m.kind} className="flex items-center gap-2.5 text-[12px]">
                  <span
                    className={cn('h-1.5 w-1.5 shrink-0 rounded-full', {
                      'bg-accent-green': m.loaded,
                      'bg-text-faint/50': !m.loaded,
                    })}
                  />
                  <Icon className="h-3.5 w-3.5 shrink-0 text-text-faint" />
                  <span className={m.loaded ? 'text-text-secondary' : 'text-text-faint'}>
                    {t(`pages.logs.memory.${m.kind === 'fast-apply' ? 'fastApply' : m.kind}`)}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-text-faint">
                    {m.loaded ? t('pages.logs.memory.loaded') : t('pages.logs.memory.idle')}
                  </span>
                </div>
              );
            })}
        </div>
      </div>
      <div className="mt-1.5 text-[10.5px] text-text-faint">
        {t('pages.logs.memory.appPlusModels')}
      </div>
    </section>
  );
}

/* ------------------------------ Execuções do Forge (detalhe do Morph) --- */

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/**
 * Lista as execuções do Forge (tabela task_executions, via
 * `smart-exec:list-records`) — é o conteúdo da aba "Forge" do terminal. Cada
 * linha expande num cartão com o detalhe do Morph: arquivos tocados, resultado
 * da validação, tentativas, tokens evitados, resumo do diff e (se falhou) o
 * motivo do escalonamento. Substitui o trace cru de forge por algo legível.
 */
function ForgeRunsList({ workspaceId, t }: { workspaceId: string; t: TFunction }) {
  const has = typeof window.orkestral?.['smart-exec:list-records'] === 'function';
  const q = useQuery({
    queryKey: ['smart-exec-records', workspaceId],
    enabled: has,
    refetchInterval: 10_000,
    queryFn: () => window.orkestral['smart-exec:list-records']({ workspaceId, limit: 50 }),
  });
  const records = q.data ?? [];

  if (records.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-text-faint">
        <Cpu className="h-7 w-7" />
        <div className="mt-2 text-[12.5px]">{t('pages.logs.forgeRuns.emptyTitle')}</div>
        <div className="mt-1 text-[11px]">{t('pages.logs.forgeRuns.emptyHint')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-3">
      {records.map((r) => (
        <ForgeRunCard key={r.id} r={r} t={t} />
      ))}
    </div>
  );
}

function ForgeRunCard({ r, t }: { r: TaskExecutionRecord; t: TFunction }) {
  // Cada card abre/fecha de forma INDEPENDENTE (antes era acordeão: abrir um
  // fechava o outro, o que confundia).
  const [open, setOpen] = useState(false);
  const isLocal = r.modelUsed === 'local';
  const tokensAvoided =
    r.metrics.estimatedPremiumInputTokensAvoided + r.metrics.estimatedPremiumOutputTokensAvoided;
  const headline =
    (isLocal ? r.diffSummary : r.failureReason || r.diffSummary) ||
    (r.filesChanged.length > 0 ? r.filesChanged.join(', ') : t('pages.logs.forgeRuns.noFiles'));
  // Evita repetir o headline na seção expandida (era um box amarelão duplicado).
  const showFailureDetail = !!r.failureReason && r.failureReason !== headline;

  return (
    <div className="rounded-lg border border-hairline bg-surface-faint">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-faint"
      >
        <span
          className={cn(
            'inline-flex h-[18px] shrink-0 items-center gap-1 rounded px-1.5 text-[10px] font-medium',
            isLocal
              ? 'bg-accent-purple/12 text-accent-purple'
              : 'border border-hairline-strong bg-surface-hover text-text-muted',
          )}
        >
          {isLocal ? (
            <Sparkles className="h-2.5 w-2.5" />
          ) : (
            <ArrowUpRight className="h-2.5 w-2.5" />
          )}
          {isLocal ? t('pages.logs.forgeRuns.local') : t('pages.logs.forgeRuns.premium')}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">{headline}</span>
        <ValidationBadge result={r.validationResult} t={t} />
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-text-faint">
          <Clock className="h-3 w-3" />
          {fmtDuration(r.durationMs)}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-faint" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" />
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-hairline-faint px-3 py-2.5 text-[11.5px]">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-text-muted">
            <span>
              {t('pages.logs.forgeRuns.mode')}:{' '}
              <span className="text-text-secondary">{r.executionMode}</span>
            </span>
            <span>
              {t('pages.logs.forgeRuns.risk')}:{' '}
              <span className="text-text-secondary">{r.risk}</span>
            </span>
            <span>
              {t('pages.logs.forgeRuns.attempts')}:{' '}
              <span className="text-text-secondary">{r.attempts}</span>
            </span>
            {tokensAvoided > 0 && (
              <span>
                {t('pages.logs.forgeRuns.tokensAvoided')}:{' '}
                <span className="text-accent-green">{formatTokens(tokensAvoided)}</span>
              </span>
            )}
          </div>

          {r.filesChanged.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {r.filesChanged.map((f) => (
                <span
                  key={f}
                  className="inline-flex items-center gap-1 rounded border border-hairline bg-black/30 px-1.5 py-0.5 font-mono text-[10.5px] text-text-secondary"
                >
                  <FileText className="h-2.5 w-2.5 text-text-faint" />
                  {f}
                </span>
              ))}
            </div>
          )}

          {r.diffSummary && <div className="text-text-secondary">{r.diffSummary}</div>}
          {showFailureDetail && (
            <div className="rounded-md border border-hairline bg-surface-faint px-2 py-1.5 text-text-muted">
              {r.failureReason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ValidationBadge({
  result,
  t,
}: {
  result: TaskExecutionRecord['validationResult'];
  t: TFunction;
}) {
  if (result === 'passed') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-accent-green">
        <Check className="h-3 w-3" />
        {t('pages.logs.forgeRuns.passed')}
      </span>
    );
  }
  if (result === 'failed') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-accent-red">
        <X className="h-3 w-3" />
        {t('pages.logs.forgeRuns.failed')}
      </span>
    );
  }
  return (
    <span className="shrink-0 text-[10.5px] text-text-faint">
      {t('pages.logs.forgeRuns.skipped')}
    </span>
  );
}

/* ------------------------------ Agentes (rail) ------------------------- */

interface AgentLive {
  busy: boolean;
  label: string;
  level: TraceLevel;
  ts: number;
}

/** Deriva "no que cada agente está trabalhando" a partir do stream de traces. */
function deriveActivity(entries: TraceEntry[]): Map<string, AgentLive> {
  const map = new Map<string, AgentLive>();
  for (const e of entries) {
    if (!e.agentId) continue;
    const cur = map.get(e.agentId);
    // Atualiza a última linha vista do agente.
    const next: AgentLive = {
      busy: cur?.busy ?? false,
      label: e.message,
      level: e.level,
      ts: e.ts,
    };
    // Busy é controlado só pelo ciclo de execução de issue (start → end).
    if (e.source === 'issue' && e.scope === 'run') {
      if (e.level === 'info') next.busy = true; // começou
      if (e.level === 'success' || e.level === 'error') next.busy = false; // terminou
    }
    map.set(e.agentId, next);
  }
  return map;
}

function AgentDashboard({
  agents,
  entries,
  t,
}: {
  agents: Agent[];
  entries: TraceEntry[];
  t: TFunction;
}) {
  const activity = useMemo(() => deriveActivity(entries), [entries]);
  const workingCount = agents.filter((a) => activity.get(a.id)?.busy).length;

  if (agents.length === 0) return null;

  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {t('pages.logs.rail.agents')}
        </span>
        <span className="text-[11px]">
          {workingCount > 0 ? (
            <span className="text-accent-purple">
              {t('pages.logs.workingNow', { n: workingCount })}
            </span>
          ) : (
            <span className="text-text-faint">{t('pages.logs.allIdle')}</span>
          )}
        </span>
      </div>
      <div className="flex flex-col rounded-2xl border border-hairline bg-rail-card px-1.5 py-1.5">
        {agents.map((a, i) => (
          <AgentRow
            key={a.id}
            agent={a}
            color={AGENT_COLORS[i % AGENT_COLORS.length]}
            live={activity.get(a.id)}
            t={t}
          />
        ))}
      </div>
    </section>
  );
}

function AgentRow({
  agent,
  color,
  live,
  t,
}: {
  agent: Agent;
  color: (typeof AGENT_COLORS)[number];
  live?: AgentLive;
  t: TFunction;
}) {
  const busy = live?.busy ?? false;
  const statusColor =
    agent.status === 'error'
      ? 'bg-accent-red'
      : agent.status === 'paused'
        ? 'bg-accent-yellow'
        : busy
          ? color.dot
          : 'bg-text-faint';
  const activityText = busy
    ? live?.label
    : (live?.label ?? (agent.status === 'paused' ? t('pages.logs.paused') : t('pages.logs.idle')));

  return (
    <div
      className="flex items-center gap-3 rounded-lg px-1.5 py-2 transition-colors hover:bg-surface-1"
      title={activityText ?? agent.name}
    >
      <div className="relative shrink-0">
        <AgentAvatar seed={agent.avatarSeed} name={agent.name} size={26} rounded="md" />
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-background',
            statusColor,
            busy && 'animate-pulse',
          )}
        />
      </div>
      <span className="flex-1 truncate text-[12.5px] font-medium text-text-primary">
        {agent.name}
      </span>
      {busy ? (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-accent-purple">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-purple" />
          {t('pages.logs.rail.working')}
        </span>
      ) : (
        <span className="text-[11px] text-text-faint">
          {agent.status === 'paused' ? t('pages.logs.paused') : t('pages.logs.idle')}
        </span>
      )}
    </div>
  );
}

/* ------------------------------ Terminal (stream) ---------------------- */

function Terminal({
  entries,
  total,
  filter,
  onFilter,
  query,
  onQuery,
  paused,
  onTogglePause,
  onClear,
  workspaceId,
  t,
}: {
  entries: TraceEntry[];
  total: number;
  filter: FilterKey;
  onFilter: (f: FilterKey) => void;
  query: string;
  onQuery: (q: string) => void;
  paused: boolean;
  onTogglePause: () => void;
  onClear: () => void;
  workspaceId: string;
  t: TFunction;
}) {
  const isForgeView = filter === 'forge';
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  // Autoscroll quando novas linhas chegam e o usuário está no fim.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [entries.length, scrollToBottom]);

  const rows = useMemo(() => (isForgeView ? [] : foldEmbedNoise(entries)), [entries, isForgeView]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar em uma linha: segmented control · spacer · busca · pausar · limpar */}
      <div className="flex shrink-0 items-center gap-2.5 px-6 pb-3">
        <div className="flex items-center gap-[3px] rounded-[10px] border border-hairline bg-background p-[3px]">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => onFilter(f.key)}
              className={cn(
                'whitespace-nowrap rounded-[7px] px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                filter === f.key
                  ? 'bg-surface-strong text-text-primary'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              {t(f.labelKey)}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {!isForgeView && (
          <>
            <div className="flex w-[200px] items-center gap-2 rounded-[9px] border border-hairline bg-background px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
              <input
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                placeholder={t('pages.logs.filterCountPlaceholder', { n: total })}
                className="w-full bg-transparent text-[12.5px] text-text-primary placeholder:text-text-faint focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={onTogglePause}
              title={paused ? t('pages.logs.resume') : t('pages.logs.pause')}
              className={cn(
                'grid h-8 w-8 place-items-center rounded-[9px] border border-hairline bg-background transition-colors hover:border-hairline-vivid',
                paused ? 'text-accent-yellow' : 'text-text-muted hover:text-text-primary',
              )}
            >
              {paused ? (
                <Play className="h-[15px] w-[15px]" />
              ) : (
                <Pause className="h-[15px] w-[15px]" />
              )}
            </button>
            <button
              type="button"
              onClick={onClear}
              title={t('pages.logs.clearTrace')}
              className="grid h-8 w-8 place-items-center rounded-[9px] border border-hairline bg-background text-text-muted transition-colors hover:border-hairline-vivid hover:text-accent-red"
            >
              <Trash2 className="h-[15px] w-[15px]" />
            </button>
          </>
        )}
      </div>

      {/* Stream */}
      <div className="relative min-h-0 flex-1">
        {isForgeView ? (
          // Aba Forge: cartões legíveis das execuções (detalhe do Morph), não o
          // trace cru — bem mais fácil de entender o que aconteceu.
          <div className="thin-scrollbar h-full overflow-y-auto bg-background">
            <ForgeRunsList workspaceId={workspaceId} t={t} />
          </div>
        ) : (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="thin-scrollbar h-full overflow-y-auto px-4 pb-5 pt-0.5"
          >
            {entries.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center text-text-faint">
                <SquareTerminal className="h-7 w-7" />
                <div className="mt-2 text-[12.5px]">{t('pages.logs.noEvents')}</div>
                <div className="mt-1 text-[11px]">{t('pages.logs.noEventsHint')}</div>
              </div>
            ) : (
              rows.map((row, i) => {
                const ts =
                  row.type === 'entry' ? row.entry.ts : row.type === 'group' ? row.last.ts : 0;
                const prevTs = lastTs(rows[i - 1]);
                const showSep = prevTs == null || fmtBlock(prevTs) !== fmtBlock(ts);
                return (
                  <Fragment key={row.type === 'entry' ? row.entry.id : row.id}>
                    {showSep && <TimeSeparator label={fmtBlock(ts)} />}
                    {row.type === 'entry' ? (
                      <Line entry={row.entry} />
                    ) : row.count === 1 ? (
                      <Line entry={row.last} />
                    ) : (
                      <EmbedGroupLine count={row.count} last={row.last} t={t} />
                    )}
                  </Fragment>
                );
              })
            )}
          </div>
        )}

        {!isForgeView && showJump && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 right-4 flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[11.5px] text-text-secondary shadow-lg transition-colors hover:text-text-primary"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {t('pages.logs.newLines')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Timestamp da última linha de uma row (pra agrupar por bloco de tempo). */
function lastTs(row: LogRow | undefined): number | null {
  if (!row) return null;
  return row.type === 'entry' ? row.entry.ts : row.last.ts;
}

/** Separador de bloco de tempo: rótulo mono + linha fina. */
function TimeSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-2 pb-2 pt-4">
      <span className="font-mono text-[11px] font-semibold tracking-wider text-text-faint">
        {label}
      </span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}

// Dobra as linhas de ruído do EMBED (indexação semântica "iniciada/concluída · 1
// página", repetidas dezenas de vezes) em UM grupo com contador. Só colapsa o
// scope 'queue' — linhas de embed úteis (analysis, rag-benchmark, load/unload) ficam.
type LogRow =
  | { type: 'entry'; entry: TraceEntry }
  | { type: 'group'; id: string; count: number; last: TraceEntry };

function foldEmbedNoise(entries: TraceEntry[]): LogRow[] {
  const rows: LogRow[] = [];
  for (const e of entries) {
    const isNoise = e.source === 'embedding' && e.scope === 'queue';
    const prev = rows[rows.length - 1];
    if (isNoise && prev && prev.type === 'group') {
      prev.count += 1;
      prev.last = e;
    } else if (isNoise) {
      rows.push({ type: 'group', id: e.id, count: 1, last: e });
    } else {
      rows.push({ type: 'entry', entry: e });
    }
  }
  return rows;
}

/** Grid de colunas alinhadas: timestamp · badge · mensagem · duração. */
const ROW_GRID = 'grid grid-cols-[74px_70px_1fr_auto] items-baseline gap-3.5';

/** Badge tonal por tipo (mono, uppercase, fundo do accent a ~12%). */
function SourceBadge({ source }: { source: TraceSource }) {
  const meta = SOURCE_META[source];
  return (
    <span
      className={cn(
        'rounded-md py-[3px] text-center font-mono text-[10px] font-semibold uppercase tracking-wide',
        meta.chip,
      )}
    >
      {meta.label}
    </span>
  );
}

function EmbedGroupLine({ count, last, t }: { count: number; last: TraceEntry; t: TFunction }) {
  return (
    <div
      className={cn(ROW_GRID, 'rounded-lg px-2.5 py-[5px] transition-colors hover:bg-background')}
    >
      <span className="select-none font-mono text-[12px] text-text-faint">{fmtTime(last.ts)}</span>
      <SourceBadge source="embedding" />
      <span className="flex min-w-0 items-center gap-2 truncate font-mono text-[12.5px] text-text-faint">
        <span className="shrink-0 rounded-[5px] border border-hairline bg-surface-strong px-1.5 font-mono text-[10px] font-semibold tabular-nums text-text-muted">
          ×{count}
        </span>
        {t('pages.logs.memory.embedGrouped')}
      </span>
      <span />
    </div>
  );
}

// Realces inline da mensagem: refs (#15) azul, valores-chave / nomes de modelo
// destacados, "passou/concluída" verde. Token-driven, sem regex frágil demais.
const REF_RE = /(#\d+)/;
const VALUE_RE = /\b(claude_local|claude-local|GPU=\w+|cpu|metal|cuda|forge\.gguf|v\d+)\b/i;
const SUCCESS_RE = /\b(passou|concluída|concluido|concluído|passed|done|succeeded|ok)\b/i;

/** Quebra a mensagem em spans coloridos por tipo de realce. */
function HighlightedMessage({ text }: { text: string }) {
  const parts = text.split(/(#\d+|\b(?:claude_local|claude-local|GPU=\w+|forge\.gguf|v\d+)\b)/i);
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        if (REF_RE.test(part) && /^#\d+$/.test(part)) {
          return (
            <span key={i} className="text-accent-blue">
              {part}
            </span>
          );
        }
        if (VALUE_RE.test(part)) {
          return (
            <span key={i} className="text-accent-purple">
              {part}
            </span>
          );
        }
        if (SUCCESS_RE.test(part)) {
          return (
            <span key={i} className="text-accent-green">
              {part}
            </span>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

function Line({ entry }: { entry: TraceEntry }) {
  // Fast-apply ("morph") é o modelo dedicado de merge — destaca com um chip próprio
  // pra ficar VISÍVEL no trace que ele foi usado (antes parecia uma linha forge igual).
  const isFastApply = entry.source === 'forge' && entry.scope === 'morph';
  const isSuccess = entry.level === 'success' || SUCCESS_RE.test(entry.message);
  return (
    <div
      className={cn(ROW_GRID, 'rounded-lg px-2.5 py-[5px] transition-colors hover:bg-background')}
    >
      <span className="select-none font-mono text-[12px] text-text-faint">{fmtTime(entry.ts)}</span>
      <SourceBadge source={entry.source} />
      <span
        className={cn(
          'min-w-0 truncate font-mono text-[12.5px]',
          isSuccess ? 'text-accent-green' : LEVEL_TEXT[entry.level],
        )}
      >
        {isFastApply && (
          <span className="mr-1.5 rounded bg-accent-green/15 px-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-accent-green">
            fast-apply
          </span>
        )}
        {entry.agentName && <span className="text-text-muted">{entry.agentName} </span>}
        {entry.issueKey != null && <span className="text-accent-blue">#{entry.issueKey} </span>}
        {entry.scope && <span className="text-text-faint">{entry.scope}: </span>}
        <HighlightedMessage text={entry.message} />
      </span>
      {entry.durationMs != null ? (
        <span className="select-none whitespace-nowrap font-mono text-[11px] tabular-nums text-text-faint">
          {entry.durationMs}ms
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}
