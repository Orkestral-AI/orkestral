import { useEffect, useState } from 'react';
import { Loader2, Layers } from 'lucide-react';
import { dockerImageIcon } from '@renderer/lib/dockerImageIcon';
import { fmtBytes } from '@renderer/lib/dockerFormat';

/**
 * Activity Monitor estilo OrbStack: containers agrupados por projeto compose, ícone
 * real por imagem, colunas CPU/Memory/Network/Disk, e 4 cards com sparkline embaixo.
 * Poll manual (2s) — guarda histórico local pros gráficos sem warning de set-state.
 */

const MAX_POINTS = 48;

interface StatRow {
  id: string;
  name: string;
  project: string | null;
  image: string;
  cpuPercent: number;
  memUsedMb: number;
  netKbps: number;
  diskMbps: number;
}
interface Totals {
  cpu: number;
  mem: number;
  net: number;
  disk: number;
}

export function ActivityMonitorView() {
  const [rows, setRows] = useState<StatRow[] | null>(null);
  const [history, setHistory] = useState<Totals[]>([]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        const r = await window.orkestral['docker:stats-all']();
        if (!alive) return;
        setRows(r.stats);
        const t = totals(r.stats);
        setHistory((h) => [...h, t].slice(-MAX_POINTS));
      } catch {
        if (alive) setRows([]);
      }
      if (alive) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (rows === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    );
  }

  // Agrupa por projeto (null = Avulsos), rodando primeiro já vem do backend.
  const groups = new Map<string, StatRow[]>();
  for (const r of rows) {
    const k = r.project ?? 'Avulsos';
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }
  const t = totals(rows);

  return (
    <div className="flex h-full flex-col">
      {/* Cabeçalho de colunas */}
      <div className="flex shrink-0 items-center gap-3 border-b border-hairline-faint px-5 py-2 text-[11px] font-medium text-text-muted">
        <span className="flex-1">Name</span>
        <span className="w-20 shrink-0 text-right">CPU %</span>
        <span className="w-24 shrink-0 text-right">Memory</span>
        <span className="w-24 shrink-0 text-right">Network</span>
        <span className="w-24 shrink-0 text-right">Disk</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {[...groups.entries()].map(([project, items]) => {
          const g = totals(items);
          return (
            <div key={project}>
              {/* Header do projeto com somatório */}
              <StatLine
                indent={0}
                icon={<Layers className="h-4 w-4 text-accent-green" />}
                name={project}
                bold
                cpu={g.cpu}
                mem={g.mem}
                net={g.net}
                disk={g.disk}
              />
              {items.map((r) => {
                const { Icon, color } = dockerImageIcon(r.image);
                return (
                  <StatLine
                    key={r.id}
                    indent={1}
                    icon={<Icon className="h-4 w-4" style={{ color }} />}
                    name={r.name}
                    cpu={r.cpuPercent}
                    mem={r.memUsedMb}
                    net={r.netKbps}
                    disk={r.diskMbps}
                  />
                );
              })}
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="px-5 py-4 text-[12px] text-text-faint">Nenhum container rodando.</p>
        )}
      </div>

      {/* 4 cards com sparkline (estilo OrbStack) */}
      <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-border p-2 sm:grid-cols-4">
        <MetricCard
          title="Total CPU"
          value={`${t.cpu.toFixed(1)}%`}
          color="#ef4444"
          values={history.map((h) => h.cpu)}
        />
        <MetricCard
          title="Memory"
          value={fmtBytes(t.mem * 1024 * 1024)}
          color="#3b82f6"
          values={history.map((h) => h.mem)}
        />
        <MetricCard
          title="Network"
          value={fmtNet(t.net)}
          color="#22c55e"
          values={history.map((h) => h.net)}
        />
        <MetricCard
          title="Disk"
          value={fmtDisk(t.disk)}
          color="#a855f7"
          values={history.map((h) => h.disk)}
        />
      </div>
    </div>
  );
}

function StatLine({
  indent,
  icon,
  name,
  cpu,
  mem,
  net,
  disk,
  bold,
}: {
  indent: number;
  icon: React.ReactNode;
  name: string;
  cpu: number;
  mem: number;
  net: number;
  disk: number;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-hairline-faint/50 px-5 py-1.5 text-[12.5px]">
      <span className="flex min-w-0 flex-1 items-center gap-2" style={{ paddingLeft: indent * 18 }}>
        {icon}
        <span
          className={`truncate ${bold ? 'font-semibold text-text-primary' : 'text-text-primary'}`}
        >
          {name}
        </span>
      </span>
      <span className="w-20 shrink-0 text-right font-mono text-text-secondary">
        {cpu.toFixed(1)}
      </span>
      <span className="w-24 shrink-0 text-right font-mono text-text-secondary">
        {fmtBytes(mem * 1024 * 1024)}
      </span>
      <span className="w-24 shrink-0 text-right font-mono text-text-secondary">{fmtNet(net)}</span>
      <span className="w-24 shrink-0 text-right font-mono text-text-secondary">
        {fmtDisk(disk)}
      </span>
    </div>
  );
}

function MetricCard({
  title,
  value,
  color,
  values,
}: {
  title: string;
  value: string;
  color: string;
  values: number[];
}) {
  return (
    <div className="flex min-h-[88px] flex-col rounded-lg border border-hairline-soft bg-surface-faint p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-semibold text-text-primary">{title}</span>
        <span className="font-mono text-[13px] font-semibold text-text-primary">{value}</span>
      </div>
      <div className="relative mt-2 min-h-0 flex-1">
        <Sparkline values={values} color={color} />
      </div>
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 100;
  const H = 32;
  if (values.length < 2) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        <line x1="0" y1={H - 1} x2={W} y2={H - 1} stroke={color} strokeWidth="1" opacity="0.4" />
      </svg>
    );
  }
  const max = Math.max(...values, 0.0001);
  const step = W / (values.length - 1);
  const pts = values.map(
    (v, i) => `${(i * step).toFixed(2)},${(H - (v / max) * (H - 2) - 1).toFixed(2)}`,
  );
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p}`).join(' ');
  const gid = `am-${color.replace('#', '')}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function totals(rows: StatRow[]): Totals {
  return rows.reduce(
    (a, r) => ({
      cpu: a.cpu + r.cpuPercent,
      mem: a.mem + r.memUsedMb,
      net: a.net + r.netKbps,
      disk: a.disk + r.diskMbps,
    }),
    { cpu: 0, mem: 0, net: 0, disk: 0 },
  );
}
function fmtNet(kbps: number): string {
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${kbps.toFixed(0)} KB/s`;
}
function fmtDisk(mbps: number): string {
  if (mbps < 1) return `${(mbps * 1024).toFixed(0)} KB/s`;
  return `${mbps.toFixed(1)} MB/s`;
}
