import { describe, it, expect } from 'vitest';
import { getSmartExecConfig, referencePricingForModel } from './config';

// ECONOMIA É O PILAR: a política do app é fallback premium DESLIGADO por padrão
// (default FALSE em AiRoutingSettings — settings.repo + model-routing-policy);
// premium é opt-in EXPLÍCITO nas Settings. O gate de execução de um agente
// orkestral_local consulta APENAS o setting de AiRoutingSettings (=== true).
describe('getSmartExecConfig — áreas críticas', () => {
  it('sem áreas críticas: Forge executa tudo local (validação fica no review)', () => {
    expect(getSmartExecConfig().allowLocalOnCritical).toBe(true);
    expect(getSmartExecConfig().criticalGlobs).toHaveLength(0);
  });
});

describe('referencePricingForModel — economia relativa ao modelo/esforço do usuário', () => {
  it('Opus custa muito mais que Sonnet (evitar Opus economiza mais)', () => {
    const opus = referencePricingForModel('claude-opus-4-8');
    const sonnet = referencePricingForModel('claude-sonnet-4-6');
    expect(opus.outputUsdPerMTok).toBeGreaterThan(sonnet.outputUsdPerMTok);
    expect(opus.label).toMatch(/Opus/);
  });

  it('modelo desconhecido / nulo cai no default Sonnet (número conservador)', () => {
    const def = referencePricingForModel(null);
    expect(def.inputUsdPerMTok).toBe(3);
    expect(def.outputUsdPerMTok).toBe(15);
    expect(def.label).toMatch(/Sonnet/);
  });

  it('esforço alto aumenta o custo de OUTPUT (premium gastaria mais saída); input estável', () => {
    const med = referencePricingForModel('claude-opus-4-8', 'medium');
    const high = referencePricingForModel('claude-opus-4-8', 'high');
    const max = referencePricingForModel('claude-opus-4-8', 'max');
    expect(high.outputUsdPerMTok).toBeGreaterThan(med.outputUsdPerMTok);
    expect(max.outputUsdPerMTok).toBeGreaterThan(high.outputUsdPerMTok);
    expect(high.inputUsdPerMTok).toBe(med.inputUsdPerMTok);
    expect(high.label).toMatch(/esforço high/);
  });
});
