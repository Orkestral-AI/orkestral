import React from 'react';
import { Text } from 'ink';

/**
 * Campo de texto single-line CONTROLADO — só renderiza; a edição fica no dono
 * do estado via `applyKeyToBuffer` (text-edit.ts). Desenha o glifo do prompt e
 * o valor com um cursor de bloco em vídeo inverso na posição atual (espaço
 * invertido quando o cursor está no fim). `mask` troca cada char por `•`
 * mantendo o cursor na posição real. Vazio → cursor + placeholder em dim.
 */
export function TextInput({
  value,
  cursor,
  placeholder,
  mask = false,
  prompt = '❯',
  promptColor = '#a78bfa',
  showCursor = true,
}: {
  value: string;
  cursor: number;
  placeholder?: string;
  mask?: boolean;
  prompt?: string;
  promptColor?: string;
  /** Desliga o bloco de cursor (campo visível porém sem foco). */
  showCursor?: boolean;
}): React.ReactElement {
  const shown = mask ? '•'.repeat(value.length) : value;
  const pos = Math.max(0, Math.min(cursor, shown.length));
  const before = shown.slice(0, pos);
  const at = shown.slice(pos, pos + 1);
  const after = shown.slice(pos + 1);

  return (
    <Text color={promptColor}>
      {prompt} {before}
      {showCursor ? <Text inverse>{at || ' '}</Text> : at}
      {after}
      {shown.length === 0 && placeholder ? <Text dimColor>{placeholder}</Text> : null}
    </Text>
  );
}
