import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface UIState {
  settingsOpen: boolean;
  settingsTab: string;
  commandPaletteOpen: boolean;
  sidebarCollapsed: boolean;
  /** Largura da sidebar quando expandida — usuário ajusta arrastando a borda. */
  sidebarWidth: number;
  /** True enquanto o usuário arrasta a borda. Desliga a transição de largura
   *  pra a sidebar acompanhar o cursor 1:1 (sem amortecimento do framer). */
  sidebarResizing: boolean;
  /** Largura do painel de lista de arquivos em Code Changes — usuário arrasta a borda. */
  fileListWidth: number;
  /** True enquanto o usuário arrasta a borda do painel de arquivos. */
  fileListResizing: boolean;
  /** Largura da sidebar de arquivos da IDE (SourceCodePage) — arrasta a borda. */
  codeSidebarWidth: number;
  /** Altura do painel de terminal da IDE — arrasta a borda de cima. */
  terminalHeight: number;
  newAgentOpen: boolean;
  newProjectOpen: boolean;
  addSourceOpen: boolean;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: string) => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setSidebarResizing: (resizing: boolean) => void;
  setFileListWidth: (width: number) => void;
  setFileListResizing: (resizing: boolean) => void;
  setCodeSidebarWidth: (width: number) => void;
  setTerminalHeight: (height: number) => void;
  openNewAgent: () => void;
  closeNewAgent: () => void;
  openNewProject: () => void;
  closeNewProject: () => void;
  openAddSource: () => void;
  closeAddSource: () => void;
}

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 256;

export const FILELIST_MIN_WIDTH = 260;
export const FILELIST_MAX_WIDTH = 640;
export const FILELIST_DEFAULT_WIDTH = 340;

export const CODE_SIDEBAR_MIN_WIDTH = 180;
export const CODE_SIDEBAR_MAX_WIDTH = 480;
export const CODE_SIDEBAR_DEFAULT_WIDTH = 256;

export const TERMINAL_MIN_HEIGHT = 120;
export const TERMINAL_MAX_HEIGHT = 640;
export const TERMINAL_DEFAULT_HEIGHT = 260;

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      settingsOpen: false,
      settingsTab: 'general',
      commandPaletteOpen: false,
      sidebarCollapsed: false,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      sidebarResizing: false,
      fileListWidth: FILELIST_DEFAULT_WIDTH,
      fileListResizing: false,
      codeSidebarWidth: CODE_SIDEBAR_DEFAULT_WIDTH,
      terminalHeight: TERMINAL_DEFAULT_HEIGHT,
      newAgentOpen: false,
      newProjectOpen: false,
      addSourceOpen: false,
      openSettings: (tab) =>
        set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab })),
      closeSettings: () => set({ settingsOpen: false }),
      setSettingsTab: (settingsTab) => set({ settingsTab }),
      openCommandPalette: () => set({ commandPaletteOpen: true }),
      closeCommandPalette: () => set({ commandPaletteOpen: false }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSidebarWidth: (width) =>
        set({
          sidebarWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width)),
        }),
      setSidebarResizing: (sidebarResizing) => set({ sidebarResizing }),
      setFileListWidth: (width) =>
        set({
          fileListWidth: Math.max(FILELIST_MIN_WIDTH, Math.min(FILELIST_MAX_WIDTH, width)),
        }),
      setFileListResizing: (fileListResizing) => set({ fileListResizing }),
      setCodeSidebarWidth: (width) =>
        set({
          codeSidebarWidth: Math.max(
            CODE_SIDEBAR_MIN_WIDTH,
            Math.min(CODE_SIDEBAR_MAX_WIDTH, width),
          ),
        }),
      setTerminalHeight: (height) =>
        set({
          terminalHeight: Math.max(TERMINAL_MIN_HEIGHT, Math.min(TERMINAL_MAX_HEIGHT, height)),
        }),
      openNewAgent: () => set({ newAgentOpen: true }),
      closeNewAgent: () => set({ newAgentOpen: false }),
      openNewProject: () => set({ newProjectOpen: true }),
      closeNewProject: () => set({ newProjectOpen: false }),
      openAddSource: () => set({ addSourceOpen: true }),
      closeAddSource: () => set({ addSourceOpen: false }),
    }),
    {
      name: 'orkestral-ui',
      storage: createJSONStorage(() => localStorage),
      // Só persistimos o estado de colapso e a largura — modais e atalhos não.
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        fileListWidth: state.fileListWidth,
        codeSidebarWidth: state.codeSidebarWidth,
        terminalHeight: state.terminalHeight,
      }),
    },
  ),
);
