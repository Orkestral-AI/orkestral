import { create } from 'zustand';

/**
 * Marca sessões de chat com "mensagem não lida" — quando um run termina (agente
 * acabou e está aguardando o usuário) numa sessão que NÃO está aberta, ela vira
 * não-lida. Dá feedback no menu Recentes (bolinha) sem precisar de backend.
 * Persiste em localStorage.
 */
interface SessionReadState {
  unread: Record<string, true>;
  markUnread: (sessionId: string) => void;
  markRead: (sessionId: string) => void;
  isUnread: (sessionId: string) => boolean;
}

const STORAGE_KEY = 'orkestral:session-unread:v1';

function load(): Record<string, true> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, true>) : {};
  } catch {
    return {};
  }
}

function persist(unread: Record<string, true>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(unread));
  } catch {
    /* ignore */
  }
}

export const useSessionReadStore = create<SessionReadState>((set, get) => ({
  unread: load(),
  markUnread: (sessionId) =>
    set((s) => {
      if (s.unread[sessionId]) return s;
      const next = { ...s.unread, [sessionId]: true as const };
      persist(next);
      return { unread: next };
    }),
  markRead: (sessionId) =>
    set((s) => {
      if (!s.unread[sessionId]) return s;
      const { [sessionId]: _omit, ...rest } = s.unread;
      persist(rest);
      return { unread: rest };
    }),
  isUnread: (sessionId) => !!get().unread[sessionId],
}));
