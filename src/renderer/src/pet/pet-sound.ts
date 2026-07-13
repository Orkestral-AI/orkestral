/**
 * Beep de notificação do pet — mesma assinatura sonora do app
 * (lib/notify.ts: dois tons 660→880Hz em Web Audio, zero asset).
 * Duplicado aqui de propósito: importar lib/notify puxaria stores/tokens do
 * app inteiro pro bundle do pet.
 */
export function playPetSound(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const playTone = (freq: number, start: number, dur: number): void => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.05, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    };
    playTone(660, 0, 0.15);
    playTone(880, 0.08, 0.15);
    window.setTimeout(() => void ctx.close().catch(() => {}), 400);
  } catch {
    // som é acessório — nunca quebra o pet
  }
}
