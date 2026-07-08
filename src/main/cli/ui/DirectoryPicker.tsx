import React, { useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Navegador de pastas pro terminal (Ink). Em vez de digitar o caminho inteiro
 * do projeto na criação de workspace, o usuário anda pela árvore de diretórios
 * com as setas e escolhe uma pasta.
 *
 * Só lista diretórios (arquivos não interessam pra escolher a raiz do projeto).
 * A leitura é feita em memo derivado do `cwd` — sem efeito colateral no render —
 * e é envolvida em try/catch pra tolerar pasta sem permissão (mostra um aviso
 * dim e fica parado, em vez de estourar).
 *
 * Itens da lista, nesta ordem:
 *   0: "✓ usar esta pasta"  → onSelect(cwd)
 *   1: ".."                 → sobe pro pai (some/desabilita se já na raiz)
 *   2+: subdiretórios       → entra na pasta
 */

const WINDOW = 10;
/** Piso do header quando o terminal é MUITO estreito — nunca trunca abaixo disso. */
const HEADER_MIN = 20;

interface DirEntry {
  /** id estável na lista: 'use' | 'up' | 'dir:<nome>' */
  id: string;
  /** rótulo exibido */
  label: string;
  /** tipo pra decidir a ação no Enter */
  kind: 'use' | 'up' | 'dir';
  /** nome da subpasta (só quando kind === 'dir') */
  name?: string;
}

/** Trunca o caminho pela ESQUERDA pra manter a pasta mais profunda visível. */
function truncateLeft(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - (max - 1))}`;
}

/** Lê só os subdiretórios de `dir`, ordenados case-insensitive. Erro → null. */
function readSubdirs(dir: string): string[] | null {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch {
    return null;
  }
}

export function DirectoryPicker({
  initialPath,
  onSelect,
  onCancel,
}: {
  initialPath?: string;
  onSelect: (absPath: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [cwd, setCwd] = useState<string>(() => path.resolve(initialPath ?? process.cwd()));
  const [idx, setIdx] = useState(0);
  // Header adaptativo: o caminho trunca pela largura REAL do terminal (-10 de
  // respiro), re-renderizando no resize — antes era um cap fixo de 70 colunas.
  const { columns } = useWindowSize();
  const headerMax = Math.max(HEADER_MIN, columns - 10);

  const isRoot = path.dirname(cwd) === cwd;
  const subdirs = useMemo(() => readSubdirs(cwd), [cwd]);
  const readFailed = subdirs === null;

  const items = useMemo<DirEntry[]>(() => {
    const list: DirEntry[] = [{ id: 'use', label: '✓ usar esta pasta', kind: 'use' }];
    if (!isRoot) list.push({ id: 'up', label: '..', kind: 'up' });
    for (const name of subdirs ?? []) {
      list.push({ id: `dir:${name}`, label: `› ${name}`, kind: 'dir', name });
    }
    return list;
  }, [subdirs, isRoot]);

  // Troca de diretório sempre zera a seleção pro topo — feito no handler (e não
  // num efeito) pra manter `cwd` e `idx` sincronizados numa única atualização.
  const navigateTo = (dir: string): void => {
    setCwd(dir);
    setIdx(0);
  };

  const goParent = (): void => {
    if (isRoot) return;
    navigateTo(path.dirname(cwd));
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(items.length - 1, i + 1));
      return;
    }
    if (key.leftArrow) {
      goParent();
      return;
    }
    if (input === 's') {
      onSelect(cwd);
      return;
    }
    if (key.return) {
      const item = items[idx];
      if (!item) return;
      if (item.kind === 'use') onSelect(cwd);
      else if (item.kind === 'up') goParent();
      else if (item.kind === 'dir' && item.name) navigateTo(path.join(cwd, item.name));
    }
  });

  // Janela rolante de ~WINDOW itens centrada na seleção.
  const start = Math.max(0, Math.min(idx - Math.floor(WINDOW / 2), items.length - WINDOW));
  const end = Math.min(items.length, start + WINDOW);
  const visible = items.slice(start, end);
  const hasAbove = start > 0;
  const hasBelow = end < items.length;

  return (
    <Box flexDirection="column">
      <Text dimColor>{truncateLeft(cwd, headerMax)}</Text>
      {hasAbove ? <Text dimColor> …</Text> : null}
      {visible.map((it, i) => {
        const absoluteIndex = start + i;
        const selected = absoluteIndex === idx;
        return (
          <Text key={it.id} color={selected ? '#a78bfa' : undefined}>
            {selected ? '❯ ' : '  '}
            {it.label}
          </Text>
        );
      })}
      {hasBelow ? <Text dimColor> …</Text> : null}
      {readFailed ? <Text dimColor>(sem permissão)</Text> : null}
      <Text dimColor>↑↓ navega · Enter abre · ← sobe · s usa esta pasta · Esc cancela</Text>
    </Box>
  );
}
