import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Marca de "última vez que vi os erros do Sentry" (ISO). Vive só no renderer
 * (localStorage). A sidebar usa pra contar problemas NOVOS (issues com lastSeen
 * depois dessa marca) e mostrar um badge de notificação. A SentryPage chama
 * `markViewed()` ao abrir, zerando o badge.
 */
interface SentryViewState {
  lastViewedAt: string | null;
  markViewed: () => void;
}

export const useSentryViewStore = create<SentryViewState>()(
  persist(
    (set) => ({
      lastViewedAt: null,
      markViewed: () => set({ lastViewedAt: new Date().toISOString() }),
    }),
    {
      name: 'orkestral-sentry-last-viewed',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
