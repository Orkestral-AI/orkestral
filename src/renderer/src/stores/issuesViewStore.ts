import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** View da página de Issues — persistida em localStorage pra sobreviver a
 *  remount/reabertura do app. Espelha os tipos locais da IssuesPage. */
export type IssuesView = 'list' | 'board';
export type IssuesGroupMode = 'status' | 'assignee' | 'priority' | 'none';
export type IssuesSortMode = 'updated' | 'created' | 'priority' | 'number';

interface IssuesViewState {
  view: IssuesView;
  group: IssuesGroupMode;
  sortBy: IssuesSortMode;
  setView: (view: IssuesView) => void;
  setGroup: (group: IssuesGroupMode) => void;
  setSortBy: (sortBy: IssuesSortMode) => void;
}

export const useIssuesViewStore = create<IssuesViewState>()(
  persist(
    (set) => ({
      view: 'list',
      group: 'none',
      sortBy: 'created',
      setView: (view) => set({ view }),
      setGroup: (group) => set({ group }),
      setSortBy: (sortBy) => set({ sortBy }),
    }),
    {
      name: 'orkestral-issues-view',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
