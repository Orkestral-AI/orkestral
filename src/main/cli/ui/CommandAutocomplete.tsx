import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { filterCommands } from './command-filter';
import { commandColumnWidth } from '../commands';

/** No máx. 8 linhas de comando visíveis — o resto vira indicador `…`. */
const WINDOW = 8;

/**
 * O hint de teclas ("Tab/Enter aceita…") aparece UMA vez por processo — na
 * primeira abertura do popup. Depois disso o usuário já sabe; o hint fixo só
 * roubava uma linha do terminal a cada `/`.
 */
let hintShownOnce = false;

/**
 * Menu de autocomplete de slash commands renderizado ABAIXO do input. Mostra os
 * comandos filtrados em colunas alinhadas (`/nome` padEnd + descrição dim),
 * destacando o ativo (`selectedIndex`). Com mais de 8 matches, vira uma janela
 * rolante centrada na seleção com `…` indicando overflow acima/abaixo. A
 * navegação (↑/↓), aceitar (Tab/Enter) e fechar (Esc) são tratados pelo Repl —
 * este componente é só de apresentação (a seleção é controlada pelo pai). Não
 * renderiza nada quando não há match. `onAccept` fica disponível pro pai delegar
 * o aceite (ex.: clique futuro); o Repl atual aceita via teclado.
 */
export function CommandAutocomplete({
  query,
  selectedIndex,
  onAccept: _onAccept,
}: {
  query: string;
  selectedIndex: number;
  onAccept?: (name: string) => void;
}): React.ReactElement | null {
  void _onAccept;
  // Snapshot no mount: se este popup é o primeiro do processo, ele mostra o
  // hint durante toda a vida dele; os próximos nascem sem.
  const [showHint] = useState(() => !hintShownOnce);
  useEffect(() => {
    hintShownOnce = true;
  }, []);
  const matches = filterCommands(query);
  if (matches.length === 0) return null;
  const width = commandColumnWidth();
  // Janela rolante de até WINDOW itens centrada na seleção (igual DirectoryPicker).
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(WINDOW / 2), matches.length - WINDOW),
  );
  const end = Math.min(matches.length, start + WINDOW);
  const visible = matches.slice(start, end);
  const hasAbove = start > 0;
  const hasBelow = end < matches.length;
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
      {hasAbove ? <Text dimColor>…</Text> : null}
      {visible.map((c, i) => {
        const absoluteIndex = start + i;
        const active = absoluteIndex === selectedIndex;
        return (
          <Text key={c.name}>
            {active ? '› ' : '  '}
            <Text color={active ? '#a78bfa' : 'gray'} bold={active}>
              {`/${c.name}`.padEnd(width)}
            </Text>
            <Text dimColor>{c.desc}</Text>
          </Text>
        );
      })}
      {hasBelow ? <Text dimColor>…</Text> : null}
      {showHint ? <Text dimColor>Tab/Enter aceita · ↑↓ navega · Esc fecha</Text> : null}
    </Box>
  );
}
