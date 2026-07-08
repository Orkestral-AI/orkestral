import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectIntent, detectIntentWithFallback, clearIntentCache } from './intent-detector';

vi.mock('./smart-exec/llama-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./smart-exec/llama-runtime')>();
  return {
    ...actual,
    runLocalPhase: vi.fn(async () => null),
  };
});

/**
 * O caminho RÁPIDO (regex) é síncrono e não pode regredir. O fallback do modelo
 * local é fail-safe: no ambiente de teste NÃO há GGUF empacotado, então
 * `runLocalPhase` retorna null e `detectIntentWithFallback` SEMPRE mantém o
 * resultado do regex — é exatamente o contrato de segurança que validamos aqui
 * (modelo indisponível nunca derruba/altera o caminho rápido).
 */
describe('detectIntent — caminho regex (síncrono) marca confiança', () => {
  it('sinal claro de plano → high confidence + diretiva', () => {
    const s = detectIntent('implement a new feature to import CSV files', false);
    expect(s.kind).toBe('planning');
    expect(s.confidence).toBe('high');
    expect(s.directive.length).toBeGreaterThan(0);
  });

  it('bug claro → high confidence', () => {
    const s = detectIntent('there is a bug in the login flow', false);
    expect(s.kind).toBe('bug-investigation');
    expect(s.confidence).toBe('high');
  });

  it('pergunta simples → high confidence, sem diretiva', () => {
    const s = detectIntent('what is the difference?', false);
    expect(s.kind).toBe('pure-question');
    expect(s.confidence).toBe('high');
    expect(s.directive).toBe('');
  });

  it('frase natural sem keyword → unknown + low confidence (porta do fallback)', () => {
    // PT acentuado, multi-palavra, sem nenhum trigger do regex — o caso que o
    // modelo local existe pra recuperar.
    const s = detectIntent('dá um jeito naquele defeito chato do carrinho, por favor', false);
    expect(s.kind).toBe('unknown');
    expect(s.confidence).toBe('low');
  });
});

describe('detectIntentWithFallback — fail-safe quando o modelo local está ausente', () => {
  beforeEach(() => clearIntentCache());

  it('caso claro: retorna o regex SEM tocar no modelo (mesmo resultado, high)', async () => {
    const fast = detectIntent('refactor the architecture of the payments module', false);
    const resolved = await detectIntentWithFallback(
      'refactor the architecture of the payments module',
      false,
    );
    expect(resolved.kind).toBe(fast.kind);
    expect(resolved.confidence).toBe('high');
  });

  it('caso ambíguo + modelo ausente: mantém o resultado do regex (não quebra)', async () => {
    const content = 'dá um jeito naquele defeito chato do carrinho, por favor';
    const fast = detectIntent(content, false);
    const resolved = await detectIntentWithFallback(content, false);
    // Sem GGUF no teste, runLocalPhase devolve null → preserva o regex.
    expect(resolved.kind).toBe(fast.kind);
    expect(resolved).toEqual(fast);
  });

  it('mensagem trivial/curta: nem chama o modelo, devolve o regex', async () => {
    const resolved = await detectIntentWithFallback('ok', false);
    expect(resolved.kind).toBe('unknown');
  });
});
