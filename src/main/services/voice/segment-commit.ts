export interface WhisperSegment {
  from: number; // ms
  to: number; // ms
  text: string;
}

/**
 * Escolhe os segmentos ESTÁVEIS pra commitar: os que terminaram com uma folga
 * (`safetyMs`) antes do fim do buffer atual — logo já têm contexto futuro
 * suficiente e não vão mudar. Devolve o texto a anexar e o ponto de corte (ms)
 * até onde o áudio pode ser descartado. trimMs=0 ⇒ nada a commitar ainda.
 */
export function pickCommitted(
  segments: WhisperSegment[],
  durationMs: number,
  safetyMs: number,
): { text: string; trimMs: number } {
  const stable = segments.filter((s) => s.to <= durationMs - safetyMs);
  if (stable.length === 0) return { text: '', trimMs: 0 };
  const text = stable
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ');
  return { text, trimMs: stable[stable.length - 1].to };
}
