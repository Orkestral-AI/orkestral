import React from 'react';
import { Box, Text } from 'ink';
import type { WorkspaceFile } from '../file-mentions';

/**
 * Menu de autocomplete de `@arquivo` renderizado ABAIXO do input — irmão visual
 * do CommandAutocomplete (mesma borda arredondada, marcador `›` e cores).
 * Recebe os matches JÁ filtrados pelo Repl (`filterFiles`, cap 8 — cabe inteiro,
 * sem janela rolante nem `…`). Navegação (↑/↓), aceite (Tab/Enter) e fechamento
 * (Esc) são tratados pelo Repl — este componente é só apresentação (a seleção é
 * controlada pelo pai). Não renderiza nada quando não há match.
 */
export function FileAutocomplete({
  matches,
  selectedIndex,
}: {
  matches: readonly WorkspaceFile[];
  selectedIndex: number;
}): React.ReactElement | null {
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
      {matches.map((file, i) => {
        const active = i === selectedIndex;
        return (
          <Text key={file.relPath}>
            {active ? '› ' : '  '}
            <Text color={active ? '#a78bfa' : 'gray'} bold={active}>
              @{file.relPath}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
