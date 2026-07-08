import type {
  AdapterDescriptor,
  AdapterModel,
  AdapterTestResult,
  AdapterType,
} from '@shared/types';

/**
 * Contrato que cada adapter CLI deve implementar no main process.
 * Inspirado no paperclip (packages/adapter-utils/src/types.ts) mas enxuto
 * pro que precisamos no onboarding: descriptor + listModels + testEnvironment.
 *
 * Implementações concretas em ./impl/<adapter>.ts e registradas em ./registry.ts.
 */
export interface AdapterModule {
  /** Descritor exibido na grade de seleção do onboarding. */
  descriptor: AdapterDescriptor;

  /**
   * Descobre os modelos disponíveis pra esse adapter. Para CLIs locais
   * normalmente lê config local ou roda `<cli> --list-models` / `--help`.
   * Retorno sempre tem ao menos `{ id: 'default', label: 'Default' }`.
   */
  listModels(): Promise<AdapterModel[]>;

  /**
   * "Test now" — roda probe pra verificar se o adapter está pronto:
   *  1. CLI instalado/no PATH
   *  2. Autenticado (login válido, env var presente)
   *  3. Probe rápido ("respond with hello")
   * Retorna pass/warn/fail + checklist humano.
   */
  testEnvironment(): Promise<AdapterTestResult>;
}

export type AdapterRegistry = Map<AdapterType, AdapterModule>;
