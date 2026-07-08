import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface SelectItem {
  id: string;
  label: string;
  meta?: string;
  current?: boolean;
}

/**
 * Lista navegável (↑↓ + Enter) usada pelos overlays do REPL. Esc chama
 * `onCancel` quando fornecido (fechar sem escolher). Lista vazia rende um
 * aviso e ignora Enter/setas — nunca indexa fora do array (o `idx` também é
 * clampado ao tamanho ATUAL de `items`, que pode mudar entre renders).
 */
export function Selector({
  title,
  items,
  onPick,
  onCancel,
}: {
  title: string;
  items: SelectItem[];
  onPick: (id: string) => void;
  onCancel?: () => void;
}): React.ReactElement {
  const [idx, setIdx] = useState(
    Math.max(
      0,
      items.findIndex((i) => i.current),
    ),
  );
  // `idx` é state e `items` é prop — se a lista encolher, clampa antes de usar.
  const cur = Math.min(idx, Math.max(0, items.length - 1));
  useInput((_input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (items.length === 0) return; // Enter/setas são no-op sem itens
    if (key.upArrow) setIdx((i) => Math.max(0, Math.min(i, items.length - 1) - 1));
    if (key.downArrow) setIdx((i) => Math.min(items.length - 1, i + 1));
    if (key.return) {
      const picked = items[cur];
      if (picked) onPick(picked.id);
    }
  });
  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Text dimColor>nada disponível — Esc fecha</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {items.map((it, i) => (
        <Text key={it.id} color={i === cur ? '#a78bfa' : undefined}>
          {i === cur ? '› ' : '  '}
          {it.current ? '✓ ' : '  '}
          {it.label}
          {it.meta ? ` · ${it.meta}` : ''}
        </Text>
      ))}
    </Box>
  );
}
