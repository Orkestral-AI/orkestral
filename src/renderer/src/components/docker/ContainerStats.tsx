import { useEffect, useState } from 'react';
import { useDockerStore } from '@renderer/stores/dockerStore';

/**
 * Aba "Stats" — 4 cards com gráfico (sparkline) estilo OrbStack: CPU / Memory /
 * Network / Disk. Escuta o stream de stats (mesmo broadcast que o ContainerDetail
 * dá start/stop) e mantém um histórico curto local pra desenhar a linha.
 * IMPORTANTE: renderizar com `key={id}` no pai pra resetar o histórico ao trocar.
 */

const MAX_POINTS = 48;

interface Sample {
  cpu: number;
  mem: number;
  net: number;
  disk: number;
}

export function ContainerStats({ id }: { id: string }) {
  const current = useDockerStore((s) => s.statsById[id]);
  const [history, setHistory] = useState<Sample[]>([]);

  useEffect(() => {
    // setState dentro do callback do subscribe (não no corpo do effect) — ok.
    return window.orkestralEvents.onDockerStatsData((e) => {
      if (e.id !== id) return;
      setHistory((h) =>
        [...h, { cpu: e.cpuPercent, mem: e.memUsedMb, net: e.netKbps, disk: e.diskMbps }].slice(
          -MAX_POINTS,
        ),
      );
    });
  }, [id]);

  const cpu = current?.cpuPercent ?? 0;
  const memUsed = current?.memUsedMb ?? 0;
  const net = current?.netKbps ?? 0;
  const disk = current?.diskMbps ?? 0;

  return (
    <div className="grid h-full grid-cols-1 content-start gap-3 overflow-y-auto p-4 sm:grid-cols-2">
      <StatCard
        title="CPU"
        value={`${cpu.toFixed(1)}%`}
        color="#ef4444"
        values={history.map((h) => h.cpu)}
      />
      <StatCard
        title="Memory"
        value={fmtMem(memUsed)}
        color="#3b82f6"
        values={history.map((h) => h.mem)}
      />
      <StatCard
        title="Network"
        value={fmtRateKb(net)}
        color="#22c55e"
        values={history.map((h) => h.net)}
      />
      <StatCard
        title="Disk"
        value={fmtRateMb(disk)}
        color="#a855f7"
        values={history.map((h) => h.disk)}
      />
    </div>
  );
}

function StatCard({
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
    <div className="flex min-h-[150px] flex-col rounded-xl border border-hairline-soft bg-surface-faint p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-text-primary">{title}</span>
        <span className="font-mono text-[15px] font-semibold text-text-primary">{value}</span>
      </div>
      <div className="relative mt-3 min-h-0 flex-1">
        <Sparkline values={values} color={color} />
      </div>
    </div>
  );
}

/** Sparkline SVG simples: linha + preenchimento suave. Auto-escala pelo máximo. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 100;
  const H = 40;
  if (values.length < 2) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        <line x1="0" y1={H - 1} x2={W} y2={H - 1} stroke={color} strokeWidth="1" opacity="0.5" />
      </svg>
    );
  }
  const max = Math.max(...values, 0.0001);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = H - (v / max) * (H - 2) - 1;
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const gid = `spark-${color.replace('#', '')}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
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

function fmtMem(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}
function fmtRateKb(kbps: number): string {
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${kbps.toFixed(0)} KB/s`;
}
function fmtRateMb(mbps: number): string {
  if (mbps < 1) return `${(mbps * 1024).toFixed(0)} KB/s`;
  return `${mbps.toFixed(1)} MB/s`;
}
