import { describe, expect, it } from 'vitest';
import { runPooled } from './kb-embedding-queue';

/**
 * Testes do pool de concorrência limitada que processa as páginas de um job de
 * embedding. Regras: no máximo N em voo, TODO item processado uma vez, parar de
 * pegar novos itens ao cancelar (sem abortar os em voo) e propagar falha.
 */
describe('runPooled', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('processa todos os itens exatamente uma vez, preservando a cobertura', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const seen: number[] = [];
    await runPooled(items, 3, async (item) => {
      await tick();
      seen.push(item);
    });
    expect(seen.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it('nunca ultrapassa o limite de concorrência', async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    await runPooled(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('limita o pool ao número de itens (não cria workers ociosos)', async () => {
    let peak = 0;
    let inFlight = 0;
    await runPooled([1, 2], 8, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('para de pegar novos itens quando shouldStop fica verdadeiro (cancelamento)', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const processed: number[] = [];
    let cancelled = false;
    await runPooled(
      items,
      2,
      async (item) => {
        processed.push(item);
        await tick();
        if (processed.length >= 4) cancelled = true;
      },
      () => cancelled,
    );
    // Cancelou cedo: não deve ter varrido a lista inteira.
    expect(processed.length).toBeLessThan(items.length);
    expect(processed.length).toBeGreaterThanOrEqual(4);
  });

  it('propaga a falha de uma task', async () => {
    await expect(
      runPooled([1, 2, 3], 2, async (item) => {
        await tick();
        if (item === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('lida com lista vazia sem erro', async () => {
    let called = 0;
    await runPooled([], 3, async () => {
      called++;
    });
    expect(called).toBe(0);
  });
});
