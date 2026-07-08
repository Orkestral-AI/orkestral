/**
 * Parser de markdown MÍNIMO pro texto do assistant no REPL. Escopo fechado de
 * propósito (simples e robusto > completo): `**negrito**`, `*itálico*`,
 * `` `código inline` `` (cyan), fences ``` (bloco cyan com régua dim em
 * cima/embaixo), bullets `- ` (viram `•`) e headings `#`/`##` (negrito).
 * SEM aninhamento, links ou tabelas — marcador que não fecha vira texto puro,
 * nunca quebra. Puro: string → linhas de spans estilizados; o Markdown.tsx
 * traduz pra runs de `<Text>` do Ink.
 */

/** Um trecho estilizado de UMA linha renderizada. */
export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Código (inline ou linha de fence) — renderiza em cyan. */
  code?: boolean;
  /** Apagado (réguas de fence). */
  dim?: boolean;
}

/** Régua horizontal dim que abre/fecha um bloco de código. */
const FENCE_RULE = '──────────';

/**
 * Estilos inline de uma linha (fora de fence): `código`, **negrito**, *itálico*.
 * Um marcador sem par não consome nada — o caractere segue como texto puro.
 * Itálico exige conteúdo colado nos asteriscos (`*x*`, não `* x *`) pra não
 * engolir multiplicações tipo `2 * 3 * 4`.
 */
function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain) {
      spans.push({ text: plain });
      plain = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        spans.push({ text: text.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        spans.push({ text: text.slice(i + 2, end), bold: true });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end > i + 1 && text[i + 1] !== ' ' && text[end - 1] !== ' ') {
        flush();
        spans.push({ text: text.slice(i + 1, end), italic: true });
        i = end + 1;
        continue;
      }
    }
    plain += text[i];
    i++;
  }
  flush();
  return spans;
}

/**
 * Converte um texto markdown em LINHAS de spans estilizados. Linha em branco →
 * `[]` (o renderer imprime uma linha vazia). Fence sem fechamento é tolerado:
 * tudo até o fim vira bloco de código (nunca lança).
 */
export function parseMarkdown(text: string): MdSpan[][] {
  const out: MdSpan[][] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    // Abertura/fechamento de fence — a linha ``` vira uma régua dim.
    if (line.trimStart().startsWith('```')) {
      const lang = inFence ? '' : line.trim().slice(3).trim();
      out.push([{ text: lang ? `${FENCE_RULE} ${lang}` : FENCE_RULE, dim: true }]);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line ? [{ text: line, code: true }] : []);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(parseInline(heading[1]).map((s) => ({ ...s, bold: true })));
      continue;
    }
    const bullet = /^(\s*)- (.*)$/.exec(line);
    if (bullet) {
      out.push([{ text: `${bullet[1]}• ` }, ...parseInline(bullet[2])]);
      continue;
    }
    out.push(parseInline(line));
  }
  return out;
}
