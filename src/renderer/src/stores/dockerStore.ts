import { create } from 'zustand';
import type { DockerContainer } from '@renderer/lib/dockerGrouping';

export type EngineStatus = 'unknown' | 'connected' | 'no-engine' | 'error';

/** Sub-view do gerenciador (nav estilo OrbStack). */
export type DockerView = 'containers' | 'volumes' | 'images' | 'networks' | 'activity';

export interface ContainerStatsView {
  cpuPercent: number;
  memUsedMb: number;
  memLimitMb: number;
  netKbps: number;
  diskMbps: number;
}

interface DockerState {
  engine: EngineStatus;
  engineMessage?: string;
  view: DockerView;
  setView: (v: DockerView) => void;
  containers: DockerContainer[];
  selectedId: string | null;
  /** Logs acumulados por container id. */
  logsById: Record<string, string>;
  /** Última stat por container id. */
  statsById: Record<string, ContainerStatsView>;
  setEngine: (status: EngineStatus, message?: string) => void;
  setContainers: (containers: DockerContainer[]) => void;
  select: (id: string | null) => void;
  appendLog: (id: string, chunk: string) => void;
  clearLog: (id: string) => void;
  setStats: (id: string, stats: ContainerStatsView) => void;
}

const MAX_LOG_CHARS = 200_000; // cap por container pra não crescer sem limite

export const useDockerStore = create<DockerState>((set) => ({
  engine: 'unknown',
  view: 'containers',
  setView: (view) => set({ view }),
  containers: [],
  selectedId: null,
  logsById: {},
  statsById: {},
  setEngine: (status, message) => set({ engine: status, engineMessage: message }),
  setContainers: (containers) => set({ containers }),
  select: (id) => set({ selectedId: id }),
  appendLog: (id, chunk) =>
    set((s) => {
      const next = (s.logsById[id] ?? '') + chunk;
      const capped = next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next;
      return { logsById: { ...s.logsById, [id]: capped } };
    }),
  clearLog: (id) => set((s) => ({ logsById: { ...s.logsById, [id]: '' } })),
  setStats: (id, stats) => set((s) => ({ statsById: { ...s.statsById, [id]: stats } })),
}));
