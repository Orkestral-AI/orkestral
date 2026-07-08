/**
 * Motor v2: contabilidade de tokens HONESTA (premium vs local).
 *
 * A tela de "economia $3.67" do chatbot_v3 mentia: somava o que o local "economizou" e
 * ignorava o premium queimado planejando. Aqui o numero e LIQUIDO: o que o premium custou
 * de verdade, contra o que custaria se o premium fizesse tudo (o trabalho do local incluso).
 * Se o liquido for negativo, a gente AVISA "gastou mais que economizou", em vez de esconder.
 *
 * Ver docs/MOTOR-FATIAS-VERTICAIS.md (metricas de sucesso: economia pelo liquido, nao bruto).
 */

export interface TokenLedger {
  /** Tokens de entrada do premium (planejar + conduzir + escalar). */
  premiumIn: number;
  /** Tokens de saida do premium. */
  premiumOut: number;
  /** Tokens gerados pelo modelo local (Forge). */
  localTokens: number;
}

export interface PremiumPricing {
  /** USD por 1M tokens de entrada do premium. */
  inputPerMTok: number;
  /** USD por 1M tokens de saida do premium. */
  outputPerMTok: number;
}

/** Preco default aproximado de um modelo premium classe Opus (ajustavel por chamada). */
export const DEFAULT_PREMIUM_PRICING: PremiumPricing = {
  inputPerMTok: 15,
  outputPerMTok: 75,
};

export interface EconomyReport {
  /** O que o premium custou DE VERDADE nesta run (planejar + conduzir + escalar). */
  premiumCostUsd: number;
  /** Estimativa do que custaria se o premium tambem tivesse feito o trabalho do local. */
  counterfactualLocalCostUsd: number;
  /** Liquido = counterfactual do local menos o premium gasto. Negativo = prejuizo. */
  netSavedUsd: number;
  /** True quando netSaved < 0: gastou mais planejando do que o local economizou. */
  spentMoreThanSaved: boolean;
  premiumTokens: number;
  localTokens: number;
}

export function emptyLedger(): TokenLedger {
  return { premiumIn: 0, premiumOut: 0, localTokens: 0 };
}

export function addPremium(ledger: TokenLedger, inputTokens: number, outputTokens: number): void {
  ledger.premiumIn += Math.max(0, inputTokens);
  ledger.premiumOut += Math.max(0, outputTokens);
}

export function addLocal(ledger: TokenLedger, tokens: number): void {
  ledger.localTokens += Math.max(0, tokens);
}

/**
 * Calcula a economia LIQUIDA. O trabalho do local e valorado ao preco de SAIDA do premium
 * (e o que custaria se o premium tivesse gerado aquele codigo). O liquido honesto e esse
 * valor menos o premium realmente gasto. Se der negativo, a orquestracao nao se pagou.
 */
export function economyReport(
  ledger: TokenLedger,
  pricing: PremiumPricing = DEFAULT_PREMIUM_PRICING,
): EconomyReport {
  const premiumCostUsd =
    (ledger.premiumIn / 1_000_000) * pricing.inputPerMTok +
    (ledger.premiumOut / 1_000_000) * pricing.outputPerMTok;
  const counterfactualLocalCostUsd = (ledger.localTokens / 1_000_000) * pricing.outputPerMTok;
  const netSavedUsd = counterfactualLocalCostUsd - premiumCostUsd;
  return {
    premiumCostUsd: round4(premiumCostUsd),
    counterfactualLocalCostUsd: round4(counterfactualLocalCostUsd),
    netSavedUsd: round4(netSavedUsd),
    spentMoreThanSaved: netSavedUsd < 0,
    premiumTokens: ledger.premiumIn + ledger.premiumOut,
    localTokens: ledger.localTokens,
  };
}

/** Linha curta e honesta pro usuario (sem maquiagem). */
export function economyLine(report: EconomyReport): string {
  if (report.spentMoreThanSaved) {
    return (
      `Prejuizo: o premium custou $${report.premiumCostUsd.toFixed(2)} e o local so ` +
      `economizou $${report.counterfactualLocalCostUsd.toFixed(2)} (liquido ` +
      `-$${Math.abs(report.netSavedUsd).toFixed(2)}). A orquestracao nao se pagou aqui.`
    );
  }
  return (
    `Economia liquida $${report.netSavedUsd.toFixed(2)} ` +
    `(premium gasto $${report.premiumCostUsd.toFixed(2)}, local valeu ` +
    `$${report.counterfactualLocalCostUsd.toFixed(2)}).`
  );
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
