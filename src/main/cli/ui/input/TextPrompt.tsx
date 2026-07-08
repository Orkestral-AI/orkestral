import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput';
import { applyKeyToBuffer } from './text-edit';

/**
 * Prompt de texto single-line dos wizards (init / canais / criação de
 * workspace) — ÚNICA implementação, construída sobre o TextInput controlado +
 * `applyKeyToBuffer` (cursor real: setas, home/end, ctrl+u/k/w, paste).
 *
 * Enter confirma com o valor trimado. Esc chama `onCancel` QUANDO fornecido;
 * sem `onCancel` o Esc não é consumido aqui e segue pros handlers de quem
 * montou o prompt (ex.: o ChannelConnect fecha a tela inteira no Esc dele).
 * Montar com `key=` distinta por passo continua zerando o estado (remount).
 */
export function TextPrompt({
  label,
  placeholder,
  mask,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder?: string;
  mask?: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.return) {
      onSubmit(value.trim());
      return;
    }
    const edited = applyKeyToBuffer(value, cursor, input, key);
    if (edited.handled) {
      setValue(edited.value);
      setCursor(edited.cursor);
    }
  });
  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <TextInput value={value} cursor={cursor} placeholder={placeholder} mask={mask} />
    </Box>
  );
}
