/**
 * Preset de DESEMPENHO/MEMÓRIA — escolhido no onboarding (slider) e ajustável
 * depois em Configurações. É a FONTE ÚNICA de verdade que decide o footprint dos
 * modelos locais conforme a máquina do usuário: máquinas com pouca RAM não podem
 * segurar embeddings/fast-apply quentes por muito tempo.
 *
 * Um preset controla, de uma vez:
 *   - os limites do runtime local (RAM, contexto, tempo ocioso até descarregar);
 *   - o quão agressivo o fast-apply e os embeddings liberam memória ao ficar ociosos.
 *
 * Compartilhado main+renderer: o main aplica (config/runtime/download) e o
 * renderer mostra o que cada preset faz no slider — sem hardcode dos dois lados.
 */
export type PerformancePreset = 'economic' | 'moderate' | 'high';

export const PERFORMANCE_PRESETS: readonly PerformancePreset[] = [
  'economic',
  'moderate',
  'high',
] as const;

/**
 * Default quando não há preset salvo (instalações antigas / pré-onboarding).
 * 'moderate' = exatamente o comportamento histórico do app (RAM 6GB, idle 30s)
 * — assim ninguém regride ao introduzir o preset.
 */
export const DEFAULT_PERFORMANCE_PRESET: PerformancePreset = 'moderate';

export interface PerformanceProfile {
  /** Limites do runtime de execução local (smart-exec). */
  local: {
    /** Segundos ocioso até descarregar o Forge da RAM. */
    idleUnloadSeconds: number;
    maxPromptTokens: number;
    maxOutputTokens: number;
  };
  /** Segundos ocioso até descarregar o modelo de fast-apply (o "morph" próprio). */
  fastApplyIdleSeconds: number;
  embeddings: {
    /** Segundos ocioso até descarregar o modelo de embeddings (~640MB). */
    idleUnloadSeconds: number;
  };
}

/**
 * Mapeamento preset → footprint. 'moderate' reproduz os defaults históricos
 * (não regride ninguém). 'economic' encolhe tudo pra caber em máquinas apertadas;
 * 'high' solta os limites pra aproveitar máquinas fortes.
 */
export const PRESET_PROFILES: Record<PerformancePreset, PerformanceProfile> = {
  economic: {
    local: {
      idleUnloadSeconds: 12,
      maxPromptTokens: 12288,
      maxOutputTokens: 3072,
    },
    fastApplyIdleSeconds: 6,
    embeddings: { idleUnloadSeconds: 20 },
  },
  moderate: {
    local: {
      idleUnloadSeconds: 30,
      maxPromptTokens: 24576,
      maxOutputTokens: 4096,
    },
    fastApplyIdleSeconds: 8,
    embeddings: { idleUnloadSeconds: 60 },
  },
  high: {
    local: {
      idleUnloadSeconds: 120,
      maxPromptTokens: 28672,
      maxOutputTokens: 4096,
    },
    fastApplyIdleSeconds: 15,
    embeddings: { idleUnloadSeconds: 120 },
  },
};

export function performanceProfileFor(preset: PerformancePreset): PerformanceProfile {
  return PRESET_PROFILES[preset] ?? PRESET_PROFILES[DEFAULT_PERFORMANCE_PRESET];
}

/**
 * Preset recomendado pela RAM total da máquina (em MB). Limiares: <8GB → econômico,
 * 8–16GB → moderado, ≥16GB → alto. Usado só pra PRÉ-selecionar o slider no
 * onboarding — o usuário sempre pode trocar.
 */
export function recommendPresetForRamMb(totalRamMb: number): PerformancePreset {
  if (!Number.isFinite(totalRamMb) || totalRamMb <= 0) return DEFAULT_PERFORMANCE_PRESET;
  if (totalRamMb < 8 * 1024) return 'economic';
  if (totalRamMb < 16 * 1024) return 'moderate';
  return 'high';
}
