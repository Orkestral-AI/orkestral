import { create } from 'zustand';

export interface IdeSelection {
  id: string;
  framework: 'react' | 'vue' | 'dom';
  file?: string;
  line?: number;
  component?: string;
  tag: string;
  selector: string;
  text?: string;
}

interface IdeChatState {
  open: boolean;
  /** Sessão aberta no drawer; 'new' = compositor de chat novo. */
  activeSessionId: string | 'new';
  /** Modo de seleção do Preview ligado. */
  selecting: boolean;
  pendingSelections: IdeSelection[];
  seq: number;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  setSession: (id: string | 'new') => void;
  setSelecting: (on: boolean) => void;
  addSelection: (s: Omit<IdeSelection, 'id'>) => void;
  removeSelection: (id: string) => void;
  clearSelections: () => void;
}

export const useIdeChatStore = create<IdeChatState>((set) => ({
  open: false,
  activeSessionId: 'new',
  selecting: false,
  pendingSelections: [],
  seq: 0,
  openDrawer: () => set({ open: true }),
  closeDrawer: () => set({ open: false }),
  toggleDrawer: () => set((s) => ({ open: !s.open })),
  setSession: (activeSessionId) => set({ activeSessionId }),
  setSelecting: (selecting) => set({ selecting }),
  addSelection: (s) =>
    set((st) => {
      const n = st.seq + 1;
      return {
        seq: n,
        pendingSelections: [...st.pendingSelections, { ...s, id: `sel_${n}` }],
        open: true,
      };
    }),
  removeSelection: (id) =>
    set((st) => ({ pendingSelections: st.pendingSelections.filter((x) => x.id !== id) })),
  clearSelections: () => set({ pendingSelections: [] }),
}));
