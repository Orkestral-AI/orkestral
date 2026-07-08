import { create } from 'zustand';

/** Chave do rascunho do composer na tela inicial (Novo chat / Home). */
export const HOME_DRAFT_KEY = 'home';

interface DraftState {
  /** Texto digitado e ainda não enviado, por chat (sessionId ou HOME_DRAFT_KEY). */
  drafts: Record<string, string>;
  setDraft: (key: string, value: string) => void;
  clearDraft: (key: string) => void;
}

/**
 * Rascunhos do composer por chat. O texto vive aqui (não no estado local do
 * ChatPrompt) pra sobreviver à navegação entre chats e à volta pra Home — onde
 * o componente desmonta/remonta ou só troca de sessionId sem remontar.
 */
export const useDraftStore = create<DraftState>((set) => ({
  drafts: {},
  setDraft: (key, value) =>
    set((s) => (s.drafts[key] === value ? s : { drafts: { ...s.drafts, [key]: value } })),
  clearDraft: (key) =>
    set((s) => {
      if (!(key in s.drafts)) return s;
      const next = { ...s.drafts };
      delete next[key];
      return { drafts: next };
    }),
}));
