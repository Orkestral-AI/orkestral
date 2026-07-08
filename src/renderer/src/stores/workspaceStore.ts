import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Workspace, Project } from '@shared/types';
import { applyWorkspaceAccent } from '@renderer/lib/accents';

interface WorkspaceState {
  active: Workspace | null;
  activeProject: Project | null;
  requiresWorkspaceSelection: boolean;
  /**
   * Id do último workspace ativo. Sobrevive a reload — o objeto completo
   * (`active`) hidrata do DB no boot via WorkspaceSwitcher.
   */
  preferredWorkspaceId: string | null;
  setActive: (workspace: Workspace | null) => void;
  setActiveProject: (project: Project | null) => void;
  enterWorkspaceSelection: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      active: null,
      activeProject: null,
      preferredWorkspaceId: null,
      requiresWorkspaceSelection: false,
      setActive: (active) => {
        // Accent do app = cor do workspace ativo. Reaplica ao trocar (ou ao
        // hidratar no boot, quando o switcher chama setActive com o objeto).
        applyWorkspaceAccent(active?.color);
        set({
          active,
          ...(active ? { requiresWorkspaceSelection: false } : {}),
          preferredWorkspaceId: active?.id ?? null,
        });
      },
      setActiveProject: (activeProject) => set({ activeProject }),
      enterWorkspaceSelection: () => {
        applyWorkspaceAccent(null);
        set({
          active: null,
          activeProject: null,
          preferredWorkspaceId: null,
          requiresWorkspaceSelection: true,
        });
      },
    }),
    {
      name: 'orkestral.workspace',
      storage: createJSONStorage(() => localStorage),
      // Persiste só o id — o objeto completo vem do DB e pode ter mudado
      // (mission/path/etc.). Hidratar do localStorage manteria dados velhos.
      partialize: (state) => ({ preferredWorkspaceId: state.preferredWorkspaceId }),
    },
  ),
);
