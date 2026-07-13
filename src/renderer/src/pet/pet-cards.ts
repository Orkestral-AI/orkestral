/**
 * Fila de cards de notificação do pet — LÓGICA PURA (testável, sem DOM).
 * Convenções: mais recente primeiro; no máximo MAX_VISIBLE_CARDS na tela
 * (resto espera na fila); sucesso/info expiram sozinhos, erro é sticky
 * (só sai com dispensa manual — é o que o usuário não pode perder).
 */

export type PetCardTone = 'success' | 'error' | 'info';
export type PetCardSource = 'execution' | 'session' | 'inbox' | 'update';

export interface PetCard {
  id: string;
  tone: PetCardTone;
  source: PetCardSource;
  title: string;
  description?: string;
  /** Rota (hash do HashRouter) aberta no clique. null = só focar o app. */
  hash: string | null;
  /** Etiqueta de contexto (nome do workspace). Omitida quando só há 1 workspace. */
  meta?: string;
  /** true = não expira sozinho (erros). */
  sticky: boolean;
  /** Timestamp (ms) em que expira. Ignorado quando sticky. */
  expiresAt: number;
}

export const CARD_TTL_MS = 8_000;
export const MAX_VISIBLE_CARDS = 3;

/** Adiciona no topo. Id repetido substitui (evento re-emitido não duplica card). */
export function addCard(cards: readonly PetCard[], card: PetCard): PetCard[] {
  return [card, ...cards.filter((c) => c.id !== card.id)];
}

/** Remove os não-sticky vencidos. Retorna a MESMA referência se nada mudou
 *  (deixa o setState do React pular re-render no tick). */
export function expireCards(cards: readonly PetCard[], now: number): readonly PetCard[] {
  const alive = cards.filter((c) => c.sticky || c.expiresAt > now);
  return alive.length === cards.length ? cards : alive;
}

export function dismissCard(cards: readonly PetCard[], id: string): PetCard[] {
  return cards.filter((c) => c.id !== id);
}

export function visibleCards(cards: readonly PetCard[]): PetCard[] {
  return cards.slice(0, MAX_VISIBLE_CARDS);
}

/** Quantos aguardam na fila além dos visíveis (mostrado como "+N"). */
export function queuedCount(cards: readonly PetCard[]): number {
  return Math.max(0, cards.length - MAX_VISIBLE_CARDS);
}
