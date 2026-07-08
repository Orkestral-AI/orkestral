import { create } from 'zustand';

export interface TerminalInfo {
  id: string;
  name: string;
  /** Source (repo) a que o terminal pertence — terminais são escopados por repo,
   *  igual workspace do VS Code: trocou de source, mostra os terminais daquele source. */
  sourceId: string;
}

interface TerminalState {
  terminals: TerminalInfo[];
  /** Terminal ativo por source. */
  activeBySource: Record<string, string | null>;
  /** Contador monotônico global só pra nomear "Terminal 1, 2, 3…". */
  seq: number;
  addTerminal: (sourceId: string, id: string) => void;
  /** Re-attach pós-reload: restaura no store os PTYs que sobreviveram no main (sem
   *  duplicar os já presentes), nomeando "Terminal N" e ativando o 1º de cada source. */
  hydrate: (items: Array<{ id: string; sourceId: string }>) => void;
  removeTerminal: (id: string) => void;
  setActive: (sourceId: string, id: string) => void;
  renameTerminal: (id: string, name: string) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  terminals: [],
  activeBySource: {},
  seq: 0,
  addTerminal: (sourceId, id) =>
    set((s) => {
      const n = s.seq + 1;
      return {
        terminals: [...s.terminals, { id, name: `Terminal ${n}`, sourceId }],
        activeBySource: { ...s.activeBySource, [sourceId]: id },
        seq: n,
      };
    }),
  hydrate: (items) =>
    set((s) => {
      const existing = new Set(s.terminals.map((tm) => tm.id));
      const fresh = items.filter((it) => !existing.has(it.id));
      if (fresh.length === 0) return s;
      let seq = s.seq;
      const added = fresh.map((it) => ({
        id: it.id,
        name: `Terminal ${++seq}`,
        sourceId: it.sourceId,
      }));
      const activeBySource = { ...s.activeBySource };
      for (const a of added)
        if (activeBySource[a.sourceId] == null) activeBySource[a.sourceId] = a.id;
      return { terminals: [...s.terminals, ...added], activeBySource, seq };
    }),
  removeTerminal: (id) =>
    set((s) => {
      const target = s.terminals.find((tm) => tm.id === id);
      if (!target) return s;
      const sourceId = target.sourceId;
      const mine = s.terminals.filter((tm) => tm.sourceId === sourceId);
      const idx = mine.findIndex((tm) => tm.id === id);
      const terminals = s.terminals.filter((tm) => tm.id !== id);
      const activeBySource = { ...s.activeBySource };
      if (activeBySource[sourceId] === id) {
        const remaining = mine.filter((tm) => tm.id !== id);
        const next = remaining[idx - 1] ?? remaining[idx] ?? remaining[remaining.length - 1];
        activeBySource[sourceId] = next?.id ?? null;
      }
      return { terminals, activeBySource };
    }),
  setActive: (sourceId, id) =>
    set((s) => ({ activeBySource: { ...s.activeBySource, [sourceId]: id } })),
  renameTerminal: (id, name) =>
    set((s) => ({
      terminals: s.terminals.map((tm) => (tm.id === id ? { ...tm, name } : tm)),
    })),
}));
