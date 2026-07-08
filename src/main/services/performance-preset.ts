/**
 * Acesso (lado main) ao preset de desempenho/memória escolhido no onboarding.
 * Lê das settings persistidas e resolve o PerformanceProfile compartilhado.
 *
 * Tudo via try/catch com fallback pro default: este módulo é importado pela
 * config do smart-exec e pelos runtimes locais, que rodam em testes SEM um DB
 * aberto — nesses casos cai no perfil 'moderate' (defaults históricos) em vez
 * de explodir.
 */
import { SettingsRepository } from '../db/repositories/settings.repo';
import {
  DEFAULT_PERFORMANCE_PRESET,
  performanceProfileFor,
  type PerformancePreset,
  type PerformanceProfile,
} from '../../shared/performance-presets';

export function getPerformancePreset(): PerformancePreset {
  try {
    const preset = new SettingsRepository().get().performance?.preset;
    return preset ?? DEFAULT_PERFORMANCE_PRESET;
  } catch {
    return DEFAULT_PERFORMANCE_PRESET;
  }
}

export function getPerformanceProfile(): PerformanceProfile {
  return performanceProfileFor(getPerformancePreset());
}
