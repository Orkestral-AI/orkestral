import { create } from 'zustand';

/**
 * Navegação da seção Dev unificada (trilho 2): IDE / Git / Docker. O sub-modo do
 * IDE (Código vs Preview) também mora aqui pra ser dirigido pela página + atalhos.
 * O sub-view do Docker (Containers/Volumes/…) fica no dockerStore.view.
 */
export type DevSection = 'ide' | 'git' | 'docker';
export type IdeTab = 'code' | 'preview';

interface DevNavState {
  section: DevSection;
  setSection: (s: DevSection) => void;
  ideTab: IdeTab;
  setIdeTab: (t: IdeTab) => void;
}

export const useDevNavStore = create<DevNavState>((set) => ({
  section: 'ide',
  setSection: (section) => set({ section }),
  ideTab: 'code',
  setIdeTab: (ideTab) => set({ ideTab }),
}));
