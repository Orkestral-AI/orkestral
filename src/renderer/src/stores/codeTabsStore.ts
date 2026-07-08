import { create } from 'zustand';

export interface CodeTab {
  sourceId: string; // source this tab belongs to
  relPath: string; // path relative to source root
  name: string; // basename to display
  dirty: boolean;
  /** Content being edited. undefined while the file is still loading. */
  draft?: string;
}

const sameTab = (t: CodeTab, sourceId: string, relPath: string) =>
  t.sourceId === sourceId && t.relPath === relPath;

interface CodeTabsState {
  tabs: CodeTab[];
  active: { sourceId: string; relPath: string } | null;
  openTab: (sourceId: string, relPath: string, name: string) => void;
  closeTab: (sourceId: string, relPath: string) => void;
  setActive: (sourceId: string, relPath: string) => void;
  setDraft: (sourceId: string, relPath: string, draft: string) => void;
  markSaved: (sourceId: string, relPath: string) => void;
  closeOthers: (sourceId: string, relPath: string) => void;
  closeToRight: (sourceId: string, relPath: string) => void;
  closeSaved: () => void;
  closeAll: () => void;
  renameTab: (sourceId: string, oldRelPath: string, newRelPath: string, newName: string) => void;
  reset: () => void;
}

export const useCodeTabsStore = create<CodeTabsState>((set) => ({
  tabs: [],
  active: null,
  openTab: (sourceId, relPath, name) =>
    set((s) => {
      if (s.tabs.some((t) => sameTab(t, sourceId, relPath)))
        return { active: { sourceId, relPath } };
      return {
        tabs: [...s.tabs, { sourceId, relPath, name, dirty: false }],
        active: { sourceId, relPath },
      };
    }),
  closeTab: (sourceId, relPath) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => !sameTab(t, sourceId, relPath));
      const isActive = s.active !== null && sameTab(s.active as CodeTab, sourceId, relPath);
      if (!isActive) return { tabs };
      // Activate neighbor: prefer previous, fall back to next.
      const oldIdx = s.tabs.findIndex((t) => sameTab(t, sourceId, relPath));
      const neighbor = tabs[oldIdx - 1] ?? tabs[oldIdx] ?? null;
      const active = neighbor ? { sourceId: neighbor.sourceId, relPath: neighbor.relPath } : null;
      return { tabs, active };
    }),
  setActive: (sourceId, relPath) => set({ active: { sourceId, relPath } }),
  setDraft: (sourceId, relPath, draft) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (sameTab(t, sourceId, relPath) ? { ...t, draft, dirty: true } : t)),
    })),
  markSaved: (sourceId, relPath) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (sameTab(t, sourceId, relPath) ? { ...t, dirty: false } : t)),
    })),
  closeOthers: (sourceId, relPath) =>
    set((s) => ({
      tabs: s.tabs.filter((t) => sameTab(t, sourceId, relPath)),
      active: { sourceId, relPath },
    })),
  closeToRight: (sourceId, relPath) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => sameTab(t, sourceId, relPath));
      if (idx < 0) return s;
      const tabs = s.tabs.slice(0, idx + 1);
      const activeStillExists =
        s.active !== null && tabs.some((t) => sameTab(t, s.active!.sourceId, s.active!.relPath));
      const active = activeStillExists ? s.active : { sourceId, relPath };
      return { tabs, active };
    }),
  closeSaved: () =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.dirty);
      const activeStillExists =
        s.active !== null && tabs.some((t) => sameTab(t, s.active!.sourceId, s.active!.relPath));
      const last = tabs[tabs.length - 1] ?? null;
      const active = activeStillExists
        ? s.active
        : last
          ? { sourceId: last.sourceId, relPath: last.relPath }
          : null;
      return { tabs, active };
    }),
  closeAll: () => set({ tabs: [], active: null }),
  renameTab: (sourceId, oldRelPath, newRelPath, newName) =>
    set((s) => {
      const tabs = s.tabs.map((t) =>
        sameTab(t, sourceId, oldRelPath) ? { ...t, relPath: newRelPath, name: newName } : t,
      );
      const active =
        s.active !== null && sameTab(s.active as CodeTab, sourceId, oldRelPath)
          ? { sourceId, relPath: newRelPath }
          : s.active;
      return { tabs, active };
    }),
  reset: () => set({ tabs: [], active: null }),
}));
