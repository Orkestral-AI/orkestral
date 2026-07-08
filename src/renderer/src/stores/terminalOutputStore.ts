import { create } from 'zustand';

const MAX_LINES = 200;

interface TerminalOutputState {
  buffers: Record<string, string[]>; // id -> recent lines (capped)
  append: (id: string, chunk: string) => void;
  clear: (id: string) => void;
  /** Returns last N lines joined as a single string. */
  recent: (id: string, lines: number) => string;
}

export const useTerminalOutputStore = create<TerminalOutputState>((set, get) => ({
  buffers: {},
  append: (id, chunk) =>
    set((s) => {
      const prev = s.buffers[id] ?? [];
      // Join prev lines + new chunk, strip basic ANSI color codes, re-split by line
      const text = (prev.join('\n') + chunk).replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
      const lines = text.split('\n').slice(-MAX_LINES);
      return { buffers: { ...s.buffers, [id]: lines } };
    }),
  clear: (id) =>
    set((s) => {
      const b = { ...s.buffers };
      delete b[id];
      return { buffers: b };
    }),
  recent: (id, lines) => (get().buffers[id] ?? []).slice(-lines).join('\n'),
}));
