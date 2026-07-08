import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Rastreia "última vez que o usuário abriu a issue" por issueId. Persistido
 * em localStorage. Comparando com `issue.updatedAt`, derivamos se a issue
 * tem novidades não vistas.
 *
 * Vive APENAS no renderer — não tem backend nem sync entre instâncias.
 * Reset via `clear()` (futuro: botão "marcar tudo como lido").
 */
interface IssueReadState {
  /** Map issueId → ISO string da última visita. */
  readAt: Record<string, string>;
  /** Marca uma issue como lida AGORA. */
  markRead: (issueId: string) => void;
  /** Conta quantas issues têm updatedAt > readAt. */
  countUnread: (issues: Array<{ id: string; updatedAt: string }>) => number;
  /** Filtra ids unread. */
  unreadIds: (issues: Array<{ id: string; updatedAt: string }>) => string[];
  /** Marca todas como lidas (limpa a noção de "novidade"). */
  markAllRead: (issues: Array<{ id: string; updatedAt: string }>) => void;
  /** Reset total (dev/debug). */
  clear: () => void;
}

export const useIssueReadStore = create<IssueReadState>()(
  persist(
    (set, get) => ({
      readAt: {},
      markRead: (issueId) =>
        set((state) => ({
          readAt: { ...state.readAt, [issueId]: new Date().toISOString() },
        })),
      countUnread: (issues) => {
        const { readAt } = get();
        let n = 0;
        for (const i of issues) {
          const r = readAt[i.id];
          if (!r || i.updatedAt > r) n++;
        }
        return n;
      },
      unreadIds: (issues) => {
        const { readAt } = get();
        const out: string[] = [];
        for (const i of issues) {
          const r = readAt[i.id];
          if (!r || i.updatedAt > r) out.push(i.id);
        }
        return out;
      },
      markAllRead: (issues) =>
        set((state) => {
          const now = new Date().toISOString();
          const next = { ...state.readAt };
          for (const i of issues) next[i.id] = now;
          return { readAt: next };
        }),
      clear: () => set({ readAt: {} }),
    }),
    {
      name: 'orkestral-issue-read',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
