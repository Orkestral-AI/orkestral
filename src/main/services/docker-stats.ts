/** Payload bruto relevante de `container.stats()` do dockerode. */
export interface RawDockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: { io_service_bytes_recursive?: Array<{ op?: string; value?: number }> | null };
  read?: string;
  preread?: string;
}

export interface ContainerStats {
  cpuPercent: number;
  memUsedMb: number;
  memLimitMb: number;
  /** Throughput de rede (rx+tx) em KB/s. */
  netKbps: number;
  /** Throughput de disco (read+write) em MB/s. */
  diskMbps: number;
}

const MB = 1024 * 1024;
const KB = 1024;

/** Totais cumulativos de I/O (bytes) do payload — usados pra calcular taxa entre amostras. */
export function ioTotals(raw: RawDockerStats): { netBytes: number; diskBytes: number; ts: number } {
  let netBytes = 0;
  for (const iface of Object.values(raw.networks ?? {})) {
    netBytes += (iface?.rx_bytes ?? 0) + (iface?.tx_bytes ?? 0);
  }
  let diskBytes = 0;
  for (const e of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
    const op = (e?.op ?? '').toLowerCase();
    if (op === 'read' || op === 'write') diskBytes += e?.value ?? 0;
  }
  const ts = raw.read ? Date.parse(raw.read) : 0;
  return { netBytes, diskBytes, ts: Number.isFinite(ts) ? ts : 0 };
}

/** Calcula CPU% e memória (MB) a partir do payload bruto do Docker.
 *  Fórmula oficial do `docker stats`. Robusto a amostra inicial (systemDelta=0).
 *  net/disk saem 0 aqui — as TAXAS são calculadas no serviço (diff entre amostras). */
export function computeContainerStats(raw: RawDockerStats): ContainerStats {
  const cpu = raw.cpu_stats;
  const pre = raw.precpu_stats;
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const numCpus = cpu?.online_cpus ?? cpu?.cpu_usage?.percpu_usage?.length ?? 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;
  return {
    cpuPercent,
    memUsedMb: (raw.memory_stats?.usage ?? 0) / MB,
    memLimitMb: (raw.memory_stats?.limit ?? 0) / MB,
    netKbps: 0,
    diskMbps: 0,
  };
}

/** Taxa entre duas amostras de I/O. Retorna KB/s (rede) e MB/s (disco), nunca negativo. */
export function ioRates(
  cur: { netBytes: number; diskBytes: number; ts: number },
  prev: { netBytes: number; diskBytes: number; ts: number } | undefined,
): { netKbps: number; diskMbps: number } {
  if (!prev || cur.ts <= prev.ts) return { netKbps: 0, diskMbps: 0 };
  const dt = (cur.ts - prev.ts) / 1000;
  const netKbps = Math.max(0, (cur.netBytes - prev.netBytes) / dt / KB);
  const diskMbps = Math.max(0, (cur.diskBytes - prev.diskBytes) / dt / MB);
  return { netKbps, diskMbps };
}
