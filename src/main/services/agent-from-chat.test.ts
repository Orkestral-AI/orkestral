import { describe, expect, it } from 'vitest';
import { decideHiringApply } from './agent-from-chat';

/**
 * Prova a idempotência do apply de hiring — o cerne do fix do "botão de aprovar
 * perde o estado e manda 2-3x a mensagem de criar plano". Um re-fire (remount do
 * card, duplo clique) NÃO pode re-materializar nem re-pedir blocos ao CEO.
 */
describe('decideHiringApply (idempotência do hiring)', () => {
  it('aplica quando há proposta pendente e nada em voo', () => {
    expect(
      decideHiringApply({
        hasPendingProposal: true,
        hasAppliedMarker: false,
        isApplyInFlight: false,
      }),
    ).toBe('apply');
  });

  it('re-fire stale (sem pendência, já aplicado) vira no-op', () => {
    expect(
      decideHiringApply({
        hasPendingProposal: false,
        hasAppliedMarker: true,
        isApplyInFlight: false,
      }),
    ).toBe('skip-already-applied');
  });

  it('2º clique enquanto o 1º apply está em voo vira no-op', () => {
    expect(
      decideHiringApply({
        hasPendingProposal: true,
        hasAppliedMarker: false,
        isApplyInFlight: true,
      }),
    ).toBe('skip-in-flight');
  });

  it('proposta NOVA (pendente) aplica mesmo havendo marcador de contratação anterior', () => {
    expect(
      decideHiringApply({
        hasPendingProposal: true,
        hasAppliedMarker: true,
        isApplyInFlight: false,
      }),
    ).toBe('apply');
  });

  it('sem pendência, sem marcador e sem voo: aplica (fluxo legado prosa → pede blocos ao CEO)', () => {
    expect(
      decideHiringApply({
        hasPendingProposal: false,
        hasAppliedMarker: false,
        isApplyInFlight: false,
      }),
    ).toBe('apply');
  });

  it('a trava de já-aplicado tem precedência sobre a de em-voo', () => {
    // Sem pendência + já aplicado + (em voo) ⇒ devolve os nomes aplicados, não no-op vazio.
    expect(
      decideHiringApply({
        hasPendingProposal: false,
        hasAppliedMarker: true,
        isApplyInFlight: true,
      }),
    ).toBe('skip-already-applied');
  });
});
