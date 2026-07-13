import { describe, expect, it } from 'vitest';
import {
  addCard,
  expireCards,
  dismissCard,
  visibleCards,
  queuedCount,
  MAX_VISIBLE_CARDS,
  type PetCard,
} from './pet-cards';

const NOW = 1_000_000;

function card(id: string, overrides: Partial<PetCard> = {}): PetCard {
  return {
    id,
    tone: 'success',
    source: 'execution',
    title: id,
    hash: null,
    sticky: false,
    expiresAt: NOW + 8_000,
    ...overrides,
  };
}

describe('pet-cards', () => {
  it('addCard põe no topo e substitui id repetido (evento re-emitido)', () => {
    let cards = addCard([], card('a'));
    cards = addCard(cards, card('b'));
    cards = addCard(cards, card('a', { title: 'a-v2' }));
    expect(cards.map((c) => c.id)).toEqual(['a', 'b']);
    expect(cards[0].title).toBe('a-v2');
  });

  it('expireCards remove vencidos mas preserva sticky (erro fica até dispensa)', () => {
    const cards = [
      card('vivo', { expiresAt: NOW + 1 }),
      card('vencido', { expiresAt: NOW - 1 }),
      card('erro', { tone: 'error', sticky: true, expiresAt: NOW - 999 }),
    ];
    expect(expireCards(cards, NOW).map((c) => c.id)).toEqual(['vivo', 'erro']);
  });

  it('expireCards devolve a MESMA referência sem mudança (evita re-render no tick)', () => {
    const cards = [card('a')];
    expect(expireCards(cards, NOW)).toBe(cards);
  });

  it('visíveis capados + contagem de fila', () => {
    const cards = ['a', 'b', 'c', 'd', 'e'].map((id) => card(id));
    expect(visibleCards(cards)).toHaveLength(MAX_VISIBLE_CARDS);
    expect(queuedCount(cards)).toBe(2);
    expect(queuedCount(cards.slice(0, 2))).toBe(0);
  });

  it('dismissCard promove o próximo da fila', () => {
    const cards = ['a', 'b', 'c', 'd'].map((id) => card(id));
    const after = dismissCard(cards, 'a');
    expect(visibleCards(after).map((c) => c.id)).toEqual(['b', 'c', 'd']);
  });
});
