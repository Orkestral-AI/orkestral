import React, { useMemo } from 'react';
import { Text } from 'ink';
import { parseMarkdown } from './markdown';

/**
 * Renderiza texto do assistant como markdown mínimo (ver ui/markdown.ts): cada
 * linha do parse vira UM `<Text>` com runs estilizados. Linha vazia imprime um
 * espaço pro Ink manter a altura (Text vazio colapsa). O parse é memoizado por
 * texto — no streaming o mesmo bloco re-renderiza a cada flush (~50ms).
 *
 * Arquivo se chama MarkdownText (não Markdown.tsx) porque `markdown.ts` +
 * `Markdown.tsx` colidem por casing em filesystem case-insensitive (macOS).
 */
export function MarkdownText({ children }: { children: string }): React.ReactElement {
  const lines = useMemo(() => parseMarkdown(children), [children]);
  return (
    <>
      {lines.map((spans, i) => (
        <Text key={i}>
          {spans.length === 0
            ? ' '
            : spans.map((span, j) => (
                <Text
                  key={j}
                  bold={span.bold}
                  italic={span.italic}
                  color={span.code ? 'cyan' : undefined}
                  dimColor={span.dim}
                >
                  {span.text}
                </Text>
              ))}
        </Text>
      ))}
    </>
  );
}
