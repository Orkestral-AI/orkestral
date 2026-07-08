import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Scope do chat = quais sources do workspace o agente deve considerar.
 *
 * Modelos:
 *   - 'all'           → contexto geral (workspace inteiro com todos os sources)
 *   - string[]        → 1+ sources específicos selecionados (pelo id)
 *
 * Persistido em localStorage por workspaceId, para sobreviver entre sessões.
 */
type Scope = 'all' | string[];

interface ScopeState {
  /** Map workspaceId → scope selecionado. */
  scopes: Record<string, Scope>;
  getScope: (workspaceId: string) => Scope;
  setScope: (workspaceId: string, scope: Scope) => void;
  /** Toggle de um source individual (mantém os outros). */
  toggleSource: (workspaceId: string, sourceId: string) => void;
}

export const useScopeStore = create<ScopeState>()(
  persist(
    (set, get) => ({
      scopes: {},
      getScope: (workspaceId) => get().scopes[workspaceId] ?? 'all',
      setScope: (workspaceId, scope) =>
        set((s) => ({ scopes: { ...s.scopes, [workspaceId]: scope } })),
      toggleSource: (workspaceId, sourceId) =>
        set((s) => {
          const current = s.scopes[workspaceId];
          let next: Scope;
          if (current === 'all' || !current) {
            // Estava em 'all' — passa pra ter SÓ esse source desmarcando os outros
            // (na prática começa por esse explícito)
            next = [sourceId];
          } else {
            const has = current.includes(sourceId);
            if (has) {
              const filtered = current.filter((id) => id !== sourceId);
              next = filtered.length === 0 ? 'all' : filtered;
            } else {
              next = [...current, sourceId];
            }
          }
          return { scopes: { ...s.scopes, [workspaceId]: next } };
        }),
    }),
    {
      name: 'orkestral-scope',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
