import { useEffect, useState } from 'react';
import { motion, useMotionValueEvent, useSpring } from 'framer-motion';
import { Boxes, Layers, Network, Sparkles, TrendingUp } from 'lucide-react';
import { EMPTY_KB_STATS, type KbGraphStats } from '@shared/types';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';

interface KbHudProps {
  stats: KbGraphStats;
  onFocusNode?: (id: string, kind: 'page' | 'entity') => void;
}

const LAYER_COLORS: Record<string, string> = {
  index: 'var(--color-accent-yellow)',
  doc: 'var(--color-accent-blue)',
  'auto-generated': 'var(--color-accent-purple)',
  'agent-memory': 'var(--color-accent-pink, #ff8fb8)',
  entity: 'var(--color-accent-green)',
};

const CARD =
  'pointer-events-auto rounded-xl border border-hairline bg-surface-elevated/70 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.35)]';

/**
 * Cards de indicadores (telemetria) sobrepostos no canvas da KB. Só leitura —
 * filtros/zoom ficam no próprio KbGalaxyView. Defensivo: sem stats, não renderiza.
 */
export function KbHud({ stats: rawStats, onFocusNode }: KbHudProps) {
  const stats = rawStats ?? EMPTY_KB_STATS;
  if (stats.totalPages + stats.totalEntities === 0) return null;

  return (
    <>
      <KnowledgeMassCard stats={stats} />
      <GrowthCard stats={stats} onFocusNode={onFocusNode} />
      <TopHubsCard stats={stats} onFocusNode={onFocusNode} />
    </>
  );
}

// ── Knowledge Mass (topo-esquerdo, abaixo dos filtros) ───────────────────────

function KnowledgeMassCard({ stats }: { stats: KbGraphStats }) {
  const { t } = useT();
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={cn(CARD, 'absolute left-3 top-[52px] z-10 w-[208px] p-3.5')}
    >
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-text-faint">
        <Boxes className="h-3.5 w-3.5 text-text-faint" />
        {t('knowledge.hud.knowledgeMass')}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <AnimatedNumber
          value={stats.totalChunks}
          className="text-[26px] font-semibold leading-none text-text-primary"
        />
        <span className="text-[11px] text-text-muted">{t('knowledge.hud.chunks')}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Pill>{t('knowledge.hud.pages', { count: stats.totalPages })}</Pill>
        <Pill>{t('knowledge.hud.entities', { count: stats.totalEntities })}</Pill>
        {stats.totalRetrievals > 0 && (
          <Pill>{t('knowledge.hud.retrievals', { count: stats.totalRetrievals })}</Pill>
        )}
      </div>
      {stats.layerDistribution.length > 0 && <LayerBar stats={stats} />}
    </motion.div>
  );
}

function LayerBar({ stats }: { stats: KbGraphStats }) {
  const { t } = useT();
  const total = stats.layerDistribution.reduce((s, l) => s + l.count, 0) || 1;
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 text-[9.5px] font-medium uppercase tracking-wide text-text-faint">
        <Layers className="h-3 w-3" />
        {t('knowledge.hud.layers')}
        {stats.constellationCount > 0 && (
          <span className="ml-auto font-mono text-text-muted">
            {t('knowledge.hud.constellations', { count: stats.constellationCount })}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-surface-2">
        {stats.layerDistribution.map((l) => (
          <motion.div
            key={l.key}
            initial={{ width: 0 }}
            animate={{ width: `${(l.count / total) * 100}%` }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            style={{ backgroundColor: LAYER_COLORS[l.key] ?? 'var(--color-text-faint)' }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5">
        {stats.layerDistribution.map((l) => (
          <span key={l.key} className="flex items-center gap-1 text-[9.5px] text-text-muted">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: LAYER_COLORS[l.key] ?? 'var(--color-text-faint)' }}
            />
            {t(`knowledge.hud.layer.${l.key}`)} {l.count}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Growth (topo-direito) ────────────────────────────────────────────────────

function GrowthCard({
  stats,
  onFocusNode,
}: {
  stats: KbGraphStats;
  onFocusNode?: (id: string, kind: 'page' | 'entity') => void;
}) {
  const { t } = useT();
  const max = Math.max(1, ...stats.weeklyGrowth);
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
      className={cn(CARD, 'absolute right-3 top-3 z-10 w-[212px] p-3.5')}
    >
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-text-faint">
        <TrendingUp className="h-3.5 w-3.5 text-text-faint" />
        {t('knowledge.hud.growth')}
      </div>
      <div className="mt-1.5 flex items-end justify-between">
        <span className="text-[16px] font-semibold text-text-primary">
          {t('knowledge.hud.thisWeek', { count: stats.recentlyAddedCount })}
        </span>
        <div className="flex h-7 items-end gap-[3px]">
          {stats.weeklyGrowth.map((v, i) => (
            <motion.span
              key={i}
              initial={{ height: 2 }}
              animate={{ height: `${Math.max(2, (v / max) * 26)}px` }}
              transition={{ duration: 0.4, delay: i * 0.03 }}
              className="w-[5px] rounded-sm bg-accent-green/70"
            />
          ))}
        </div>
      </div>
      {stats.recentPages.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center gap-1.5 text-[9.5px] font-medium uppercase tracking-wide text-text-faint">
            <Sparkles className="h-3 w-3" />
            {t('knowledge.hud.becomingKb')}
          </div>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {stats.recentPages.map((p, i) => (
              <motion.button
                key={p.id}
                type="button"
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 + i * 0.05 }}
                onClick={() => onFocusNode?.(p.id, 'page')}
                className="truncate rounded-md px-1.5 py-1 text-left text-[11px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
              >
                {p.title}
              </motion.button>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ── Top Hubs (baixo-esquerdo) ────────────────────────────────────────────────

function TopHubsCard({
  stats,
  onFocusNode,
}: {
  stats: KbGraphStats;
  onFocusNode?: (id: string, kind: 'page' | 'entity') => void;
}) {
  const { t } = useT();
  if (stats.topHubs.length === 0) return null;
  const max = Math.max(1, ...stats.topHubs.map((hub) => hub.degree));
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
      className={cn(CARD, 'absolute bottom-3 left-3 z-10 w-[230px] p-3.5')}
    >
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-text-faint">
        <Network className="h-3.5 w-3.5 text-text-faint" />
        {t('knowledge.hud.topHubs')}
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {stats.topHubs.map((hub, i) => (
          <button
            key={hub.id}
            type="button"
            onClick={() => onFocusNode?.(hub.id, hub.kind)}
            className="group flex items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-surface-2"
          >
            <span className="w-3 text-center text-[10px] font-mono text-text-faint">{i + 1}</span>
            <span
              className={cn('h-2 w-2 shrink-0 rounded-full', hub.isPlanet ? '' : 'opacity-60')}
              style={{
                backgroundColor: hub.isPlanet ? 'var(--color-accent)' : 'var(--color-accent-blue)',
              }}
            />
            <span className="min-w-0 flex-1 truncate text-[11px] text-text-secondary group-hover:text-text-primary">
              {hub.label}
            </span>
            <span className="relative h-1 w-9 overflow-hidden rounded-full bg-surface-active">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-accent/70"
                style={{ width: `${(hub.degree / max) * 100}%` }}
              />
            </span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}

// ── Primitivos ───────────────────────────────────────────────────────────────

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-text-muted">
      {children}
    </span>
  );
}

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const spring = useSpring(0, { stiffness: 90, damping: 18 });
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    spring.set(value);
  }, [value, spring]);
  useMotionValueEvent(spring, 'change', (v) => setDisplay(v));
  return <span className={className}>{COMPACT.format(Math.round(display))}</span>;
}
