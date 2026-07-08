/**
 * Parser PURO de streaming do chat — sem dependências de Electron/DB, pra ser
 * testável isoladamente. Segura a renderização de componentes `<orkestral:...>`
 * enquanto eles ainda chegam (nunca vaza markup parcial) e corta tokens "veneno"
 * (blocos de automação que viram card e não devem aparecer como texto). (P0-03)
 */

/**
 * Comprimento SEGURO pra exibir: segura a renderização a partir do primeiro
 * componente `<orkestral:...>` que ainda está INCOMPLETO durante o streaming —
 * tag de abertura sem `>`, bloco aberto sem o `</orkestral:NAME>` correspondente,
 * ou um prefixo parcial do literal no fim do buffer. Componentes COMPLETOS passam
 * (o renderer os transforma em card). Determinístico, suporta chunks arbitrários
 * e múltiplos componentes na mesma stream.
 */
export function orkestralComponentCut(raw: string): number {
  const lower = raw.toLowerCase();
  let i = 0;
  while (i < raw.length) {
    const open = lower.indexOf('<orkestral', i);
    if (open === -1) break;
    const gt = raw.indexOf('>', open);
    if (gt === -1) return open; // tag de abertura ainda chegando → segura aqui
    const openTag = raw.slice(open, gt + 1);
    if (/\/>\s*$/.test(openTag)) {
      i = gt + 1; // self-closing → componente completo; segue após ele
      continue;
    }
    const nameMatch = /^<orkestral:([\w-]+)/i.exec(openTag);
    if (!nameMatch) return open; // "<orkestral" sem ":nome" válido → segura
    const closeTag = `</orkestral:${nameMatch[1]}>`.toLowerCase();
    const close = lower.indexOf(closeTag, gt + 1);
    if (close === -1) return open; // bloco aberto sem fechamento ainda → segura
    i = close + closeTag.length;
  }
  // Prefixo PARCIAL do literal "<orkestral" no fim do buffer (ex.: "<ork").
  const token = '<orkestral';
  for (let len = Math.min(token.length - 1, raw.length); len > 0; len--) {
    if (lower.slice(raw.length - len) === token.slice(0, len)) return raw.length - len;
  }
  return raw.length;
}

/**
 * Versão EXIBÍVEL do texto em streaming. Segura componentes `<orkestral:...>`
 * incompletos e corta os tokens "veneno" (blocos que viram card, ex.: hiring) por
 * completo, inclusive um prefixo parcial chegando no fim do buffer. Em respostas
 * normais (sem componentes/tokens) é no-op.
 */
export function safeStreamDisplay(raw: string, poisonTokens: readonly string[]): string {
  let cut = orkestralComponentCut(raw);
  const lower = raw.toLowerCase();
  for (const tok of poisonTokens) {
    const at = lower.indexOf(tok.toLowerCase());
    if (at !== -1) cut = Math.min(cut, at);
    // Prefixo parcial do token no fim do buffer (ex.: "...HIRING_DEC").
    for (let len = Math.min(tok.length - 1, raw.length); len > 0; len--) {
      if (lower.slice(raw.length - len) === tok.slice(0, len).toLowerCase()) {
        cut = Math.min(cut, raw.length - len);
        break;
      }
    }
  }
  return stripLeakedArtifacts(raw.slice(0, cut));
}

/**
 * Limpa artefatos que vazam no texto VISÍVEL vindos do CLI: tags de thinking soltas (o thinking
 * nativo é renderizado à parte, então qualquer `<thinking>`/`</thinking>` no texto é vazamento) e
 * ecos de continuação ("User: Continue ...") que a auto-compactação do CLI injeta entre os turnos.
 */
function stripLeakedArtifacts(text: string): string {
  return text
    .replace(/<\/?thinking>/gi, '')
    .replace(/^[ \t]*(User|Human|Assistant):[ \t]*Continu\w*.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n');
}
