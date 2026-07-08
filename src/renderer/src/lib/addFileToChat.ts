import { useDraftStore, HOME_DRAFT_KEY } from '@renderer/stores/draftStore';
import { toast } from '@renderer/stores/toastStore';

/** Anexa `@relPath` ao rascunho do novo chat (Home). O caller navega pra '/'.
 *  Não há sessão de chat ativa acessível a partir da rota da IDE, então o destino
 *  é sempre o compositor do novo chat. `successMsg` vem traduzido (i18n). */
export function addFileToChat(relPath: string, successMsg: string): void {
  const { drafts, setDraft } = useDraftStore.getState();
  const current = drafts[HOME_DRAFT_KEY] ?? '';
  const next = (current ? current.trimEnd() + ' ' : '') + '@' + relPath;
  setDraft(HOME_DRAFT_KEY, next);
  toast.success(successMsg);
}
