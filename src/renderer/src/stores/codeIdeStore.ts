import { create } from 'zustand';

export type PendingEdit =
  | { kind: 'rename'; sourceId: string; targetRelPath: string }
  | { kind: 'new-file'; sourceId: string; parentRelPath: string }
  | { kind: 'new-dir'; sourceId: string; parentRelPath: string }
  | null;

interface CodeIdeState {
  /** revealPath scoped by source: null = none. */
  revealPath: { sourceId: string; relPath: string } | null;
  pendingEdit: PendingEdit;
  /** expandedDirs keyed by sourceId. */
  expandedDirs: Record<string, string[]>;
  toggleDir: (sourceId: string, relPath: string) => void;
  openDir: (sourceId: string, relPath: string) => void;
  /** collapseAll(sourceId) = collapse one source; collapseAll() = collapse all. */
  collapseAll: (sourceId?: string) => void;
  resetTree: (sourceId?: string) => void;
  requestReveal: (sourceId: string, relPath: string) => void;
  clearReveal: () => void;
  startRename: (sourceId: string, targetRelPath: string) => void;
  startNewFile: (sourceId: string, parentRelPath: string) => void;
  startNewDir: (sourceId: string, parentRelPath: string) => void;
  clearEdit: () => void;
  view: 'files' | 'search';
  setView: (v: 'files' | 'search') => void;
  goTo: { sourceId: string; relPath: string; line: number } | null;
  requestGoTo: (sourceId: string, relPath: string, line: number) => void;
  clearGoTo: () => void;
  focusSearch: number;
  bumpFocusSearch: () => void;
  // Clipboard — GLOBAL (cut/copy/paste across sources is intentional).
  clipboard: { relPath: string; mode: 'cut' | 'copy' } | null;
  setClipboard: (relPath: string, mode: 'cut' | 'copy') => void;
  clearClipboard: () => void;
  // Escopo da busca (Buscar nesta pasta). null = buscar em todas as fontes.
  searchScope: { sourceId: string; relPath: string } | null;
  setSearchScope: (scope: { sourceId: string; relPath: string } | null) => void;
  // Painel de terminal.
  terminalOpen: boolean;
  toggleTerminal: () => void;
}

export const useCodeIdeStore = create<CodeIdeState>((set) => ({
  revealPath: null,
  pendingEdit: null,
  expandedDirs: {},
  toggleDir: (sourceId, relPath) =>
    set((s) => {
      const current = s.expandedDirs[sourceId] ?? [];
      return {
        expandedDirs: {
          ...s.expandedDirs,
          [sourceId]: current.includes(relPath)
            ? current.filter((p) => p !== relPath)
            : [...current, relPath],
        },
      };
    }),
  openDir: (sourceId, relPath) =>
    set((s) => {
      const current = s.expandedDirs[sourceId] ?? [];
      if (current.includes(relPath)) return s;
      return {
        expandedDirs: {
          ...s.expandedDirs,
          [sourceId]: [...current, relPath],
        },
      };
    }),
  collapseAll: (sourceId?) =>
    set((s) => {
      if (sourceId !== undefined) {
        return { expandedDirs: { ...s.expandedDirs, [sourceId]: [] } };
      }
      return { expandedDirs: {} };
    }),
  resetTree: (sourceId?) =>
    set((s) => {
      if (sourceId !== undefined) {
        return { expandedDirs: { ...s.expandedDirs, [sourceId]: [] } };
      }
      return { expandedDirs: {} };
    }),
  requestReveal: (sourceId, relPath) => set({ revealPath: { sourceId, relPath } }),
  clearReveal: () => set({ revealPath: null }),
  startRename: (sourceId, targetRelPath) =>
    set({ pendingEdit: { kind: 'rename', sourceId, targetRelPath } }),
  startNewFile: (sourceId, parentRelPath) =>
    set({ pendingEdit: { kind: 'new-file', sourceId, parentRelPath } }),
  startNewDir: (sourceId, parentRelPath) =>
    set({ pendingEdit: { kind: 'new-dir', sourceId, parentRelPath } }),
  clearEdit: () => set({ pendingEdit: null }),
  view: 'files',
  setView: (view) => set({ view }),
  goTo: null,
  requestGoTo: (sourceId, relPath, line) => set({ goTo: { sourceId, relPath, line } }),
  clearGoTo: () => set({ goTo: null }),
  focusSearch: 0,
  bumpFocusSearch: () => set((s) => ({ focusSearch: s.focusSearch + 1 })),
  clipboard: null,
  setClipboard: (relPath, mode) => set({ clipboard: { relPath, mode } }),
  clearClipboard: () => set({ clipboard: null }),
  searchScope: null,
  setSearchScope: (scope) => set({ searchScope: scope }),
  terminalOpen: false,
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
}));
