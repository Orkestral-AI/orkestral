import { create } from 'zustand';

/**
 * Estado leve do workspace IDE unificado. O "source focado" (que dirige
 * Git/Preview/Terminal) NÃO mora aqui — deriva de `codeTabsStore.active?.sourceId`
 * (fallback = source primária). Aqui fica só o que não dá pra derivar.
 */
interface WorkspaceIdeState {
  /** sourceId cujo dialog de Configurações está aberto. null = fechado. */
  configSourceId: string | null;
  openConfig: (sourceId: string) => void;
  closeConfig: () => void;
}

export const useWorkspaceIdeStore = create<WorkspaceIdeState>((set) => ({
  configSourceId: null,
  openConfig: (sourceId) => set({ configSourceId: sourceId }),
  closeConfig: () => set({ configSourceId: null }),
}));
