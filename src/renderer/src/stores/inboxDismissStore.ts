import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Itens dispensados do Inbox — vive só no renderer (localStorage), não mexe na
 * issue nem no backend. Cada item tem uma "assinatura" (sig): pra issues uso o
 * `updatedAt`, então se o item mudar ele reaparece; pra eventos (code review),
 * uso o id do evento, que é estável → fica dispensado pra sempre.
 */
interface InboxDismissState {
  /** Map key → assinatura no momento da dispensa. */
  dismissed: Record<string, string>;
  dismiss: (key: string, sig: string) => void;
  dismissMany: (items: Array<{ key: string; sig: string }>) => void;
  isDismissed: (key: string, sig: string) => boolean;
  restoreAll: () => void;
}

export const useInboxDismissStore = create<InboxDismissState>()(
  persist(
    (set, get) => ({
      dismissed: {},
      dismiss: (key, sig) => set((state) => ({ dismissed: { ...state.dismissed, [key]: sig } })),
      dismissMany: (items) =>
        set((state) => {
          const next = { ...state.dismissed };
          for (const it of items) next[it.key] = it.sig;
          return { dismissed: next };
        }),
      isDismissed: (key, sig) => get().dismissed[key] === sig,
      restoreAll: () => set({ dismissed: {} }),
    }),
    {
      name: 'orkestral-inbox-dismissed',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
