import { defineConfig } from 'vitest/config';

/**
 * Testes UNITÁRIOS de lógica pura (parser de streaming, morphismo, estado de
 * plano, classificador de execução). Ambiente node — sem Electron/DOM. Os
 * arquivos de teste ficam ao lado do código (`*.test.ts`). UI crítica é coberta
 * por typecheck + plano de teste manual (ver 02_GLOBAL_ACCEPTANCE_TEST_PLAN.md).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Não tocar nos diretórios de build/deps.
    exclude: ['node_modules', 'dist', 'out'],
  },
});
