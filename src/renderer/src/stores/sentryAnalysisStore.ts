import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Mapa issueId → sessionId das análises do Sentry já abertas. Vive no renderer
 * (localStorage). Depois de "Analisar e corrigir", o card do erro deixa de
 * oferecer analisar de novo e passa a linkar pra sessão de chat criada.
 */
interface SentryAnalysisState {
  analyzed: Record<string, string>;
  markAnalyzed: (issueId: string, sessionId: string) => void;
}

export const useSentryAnalysisStore = create<SentryAnalysisState>()(
  persist(
    (set) => ({
      analyzed: {},
      markAnalyzed: (issueId, sessionId) =>
        set((state) => ({ analyzed: { ...state.analyzed, [issueId]: sessionId } })),
    }),
    {
      name: 'orkestral-sentry-analyzed',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
