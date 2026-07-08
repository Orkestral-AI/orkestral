/**
 * Edição PURA de um buffer single-line com cursor — o motor do TextInput.
 *
 * Recebe o par (input, key) exatamente como o `useInput` do Ink entrega e
 * devolve o próximo estado `{value, cursor}` + `handled` dizendo se a tecla foi
 * consumida aqui. Teclas de "decisão" (Enter/Esc/Tab/↑/↓) e combos de controle
 * desconhecidos NUNCA são tratados — quem é dono do campo decide (submit,
 * histórico, autocomplete, cancelar). Assim o Repl pode rodar as teclas
 * especiais dele ANTES e delegar só a edição de texto pra cá.
 */

/** Subconjunto estrutural do `Key` do Ink que a edição usa (tudo opcional). */
export interface EditKey {
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  tab?: boolean;
  return?: boolean;
  escape?: boolean;
}

export interface EditResult {
  value: string;
  cursor: number;
  handled: boolean;
}

const clamp = (n: number, len: number): number => Math.max(0, Math.min(n, len));

/** Início da palavra antes do cursor: pula espaços à esquerda, depois a palavra. */
function wordStartBefore(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(value[i - 1])) i--;
  while (i > 0 && !/\s/.test(value[i - 1])) i--;
  return i;
}

export function applyKeyToBuffer(
  value: string,
  cursor: number,
  input: string,
  key: EditKey,
): EditResult {
  // Cursor pode chegar fora do range (valor trocado por fora, ex.: recall de
  // histórico) — clampa antes de qualquer operação.
  const pos = clamp(cursor, value.length);
  const unhandled: EditResult = { value, cursor: pos, handled: false };
  // Ctrl+letra chega com o `input` na letra (minúscula na prática; toLowerCase
  // por segurança entre terminais).
  const ctrlChar = key.ctrl ? input.toLowerCase() : '';

  // Movimento do cursor.
  if (key.leftArrow) return { value, cursor: clamp(pos - 1, value.length), handled: true };
  if (key.rightArrow) return { value, cursor: clamp(pos + 1, value.length), handled: true };
  if (key.home || ctrlChar === 'a') return { value, cursor: 0, handled: true };
  if (key.end || ctrlChar === 'e') return { value, cursor: value.length, handled: true };

  // Deleções. Alt+Backspace (meta) apaga a palavra anterior, igual Ctrl+W.
  if (ctrlChar === 'w' || (key.backspace && key.meta)) {
    const start = wordStartBefore(value, pos);
    return { value: value.slice(0, start) + value.slice(pos), cursor: start, handled: true };
  }
  if (key.backspace) {
    if (pos === 0) return { value, cursor: 0, handled: true };
    return { value: value.slice(0, pos - 1) + value.slice(pos), cursor: pos - 1, handled: true };
  }
  if (key.delete) {
    return { value: value.slice(0, pos) + value.slice(pos + 1), cursor: pos, handled: true };
  }
  if (ctrlChar === 'u') return { value: value.slice(pos), cursor: 0, handled: true };
  if (ctrlChar === 'k') return { value: value.slice(0, pos), cursor: pos, handled: true };

  // Teclas de decisão — o dono do campo trata (submit/histórico/autocomplete).
  if (key.return || key.escape || key.tab || key.upArrow || key.downArrow) return unhandled;
  // Demais combos de controle (Ctrl+C, Alt+algo…) não editam o buffer.
  if (key.ctrl || key.meta) return unhandled;
  if (!input) return unhandled;

  // Texto digitável — inclusive paste multi-char. Campo é single-line: quebras
  // coladas viram espaço (\r\n conta como UMA quebra).
  const text = input.replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
  return {
    value: value.slice(0, pos) + text + value.slice(pos),
    cursor: pos + text.length,
    handled: true,
  };
}
