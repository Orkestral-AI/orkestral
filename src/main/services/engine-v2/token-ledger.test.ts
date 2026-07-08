import { describe, it, expect } from 'vitest';

import { emptyLedger, addPremium, addLocal, economyReport, economyLine } from './token-ledger';

describe('token-ledger (honest net savings of engine v2)', () => {
  it('local doing the bulk + lean premium = positive savings', () => {
    const l = emptyLedger();
    addPremium(l, 2_000, 500); // premium so planejou/conduziu
    addLocal(l, 200_000); // local gerou muito codigo
    const r = economyReport(l);
    expect(r.spentMoreThanSaved).toBe(false);
    expect(r.netSavedUsd).toBeGreaterThan(0);
  });

  it('heavy premium + shallow local (the chatbot_v3 case) = WARNS of loss, does not hide it', () => {
    const l = emptyLedger();
    addPremium(l, 400_000, 80_000); // 2h de Opus planejando/narrando
    addLocal(l, 5_000); // local quase nao entregou
    const r = economyReport(l);
    expect(r.spentMoreThanSaved).toBe(true);
    expect(r.netSavedUsd).toBeLessThan(0);
    expect(economyLine(r)).toMatch(/Prejuizo|nao se pagou/);
  });

  it('economyLine shows savings when positive', () => {
    const l = emptyLedger();
    addPremium(l, 1_000, 200);
    addLocal(l, 300_000);
    expect(economyLine(economyReport(l))).toMatch(/Economia liquida/);
  });

  it('does not accept negative tokens', () => {
    const l = emptyLedger();
    addPremium(l, -100, -50);
    addLocal(l, -10);
    expect(l).toEqual({ premiumIn: 0, premiumOut: 0, localTokens: 0 });
  });
});
