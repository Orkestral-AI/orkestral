/**
 * Edit ancorado por LINHA — o caminho mais confiável pro modelo pequeno.
 *
 * Em vez de reproduzir uma ÂNCORA de texto (que o 1.5B/3B erra → "âncora não
 * casou"), o modelo recebe o arquivo NUMERADO e responde QUAIS linhas mexer, por
 * NÚMERO:
 *
 *   @@REPLACE 42-45
 *   <código novo>
 *   @@END@@
 *
 *   @@INSERT 42
 *   <código a inserir DEPOIS da linha 42>
 *   @@END@@
 *
 * O modelo só precisa ESCOLHER NÚMEROS (trivial) — não há âncora pra errar. O app
 * funde determinístico pelo número da linha. PURO (sem fs/llama, como
 * morph.ts/region.ts): testável e seguro (range inválido/sobreposto → null e o
 * caller cai no fallback; nada grava sem snapshot+validação+rollback).
 */

export interface LineEdit {
  op: 'replace' | 'insert';
  /** 1-based. REPLACE: 1ª linha do intervalo. INSERT: insere DEPOIS desta linha (0=topo). */
  start: number;
  /** 1-based inclusivo. REPLACE: última linha do intervalo. INSERT: === start. */
  end: number;
  /** Linhas novas (vazio = deleção, no REPLACE). */
  lines: string[];
}

// Linha de CABEÇALHO de um edit: a LINHA INTEIRA (trimmed) é `@@REPLACE a-b` /
// `@@INSERT n`. O "-b" é opcional (REPLACE de 1 linha).
const HEADER_RE = /^@@(REPLACE|INSERT)[ \t]+(\d+)(?:[ \t]*-[ \t]*(\d+))?$/;
const END_MARKER = '@@END@@';

/**
 * Extrai os edits por linha do texto bruto do modelo. Parsing BASEADO EM LINHA (não
 * regex sobre o texto todo): o corpo só termina numa linha que É EXATAMENTE `@@END@@`
 * (trimmed) — assim código novo que CONTÉM "@@END@@" no meio de uma linha (ex.: uma
 * string `"@@END@@"`) NÃO trunca o edit. Um novo cabeçalho antes do @@END@@ também
 * encerra o corpo (o modelo emitiu o próximo edit). Ordem preservada.
 */
export function parseLineEdits(raw: string): LineEdit[] {
  const lines = raw.split('\n');
  const out: LineEdit[] = [];
  let i = 0;
  while (i < lines.length) {
    const h = HEADER_RE.exec(lines[i].trim());
    if (!h) {
      i++;
      continue;
    }
    const op = h[1] === 'INSERT' ? 'insert' : 'replace';
    const start = Number(h[2]);
    const end = op === 'insert' ? start : h[3] !== undefined ? Number(h[3]) : start;
    i++; // pula o cabeçalho
    const body: string[] = [];
    // Corpo até a linha que É exatamente @@END@@, ou até o próximo cabeçalho.
    while (i < lines.length && lines[i].trim() !== END_MARKER && !HEADER_RE.test(lines[i].trim())) {
      body.push(lines[i]);
      i++;
    }
    if (i < lines.length && lines[i].trim() === END_MARKER) i++; // consome o @@END@@
    out.push({ op, start, end, lines: body });
  }
  return out;
}

/**
 * Aplica os edits por linha sobre `content` e devolve o arquivo novo, ou null se
 * algo é inseguro: range fora dos limites, REPLACE invertido, intervalos de REPLACE
 * SOBREPOSTOS, edit que cobre quase o arquivo todo (>90% — não é cirúrgico, deixa o
 * rewrite decidir), ou resultado idêntico/sem mudança (no-op). Funde no EOL dominante.
 */
export function applyLineEdits(content: string, edits: LineEdit[]): string | null {
  if (edits.length === 0) return null;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const total = lines.length;

  // Validação de limites + REPLACE não-invertido + INSERT sem corpo é no-op.
  for (const e of edits) {
    if (!Number.isInteger(e.start) || !Number.isInteger(e.end)) return null;
    if (e.op === 'replace') {
      if (e.start < 1 || e.end > total || e.start > e.end) return null;
      if (e.end - e.start + 1 > total * 0.9) return null; // não é cirúrgico
    } else {
      if (e.start < 0 || e.start > total) return null; // insere DEPOIS de [0..total]
      if (e.lines.length === 0) return null; // inserir nada = no-op
    }
  }

  // REPLACE não pode sobrepor outro REPLACE (ordem indefinida + perda de código).
  const ranges = edits
    .filter((e) => e.op === 'replace')
    .map((e) => [e.start, e.end] as const)
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] <= ranges[i - 1][1]) return null;
  }

  // INSERT NÃO pode cair DENTRO de um range de REPLACE: o splice end-to-start aplicaria
  // o INSERT primeiro, deslocando os índices, e o REPLACE removeria as linhas erradas
  // (duplicação/perda de código). Inserir em `start` é "depois da linha start"; conflita
  // se start está em [a..b]. start=a-1 (antes do bloco) é seguro e permitido.
  for (const ins of edits) {
    if (ins.op !== 'insert') continue;
    for (const [a, b] of ranges) {
      if (ins.start >= a && ins.start <= b) return null;
    }
  }

  // Aplica do FIM pro começo pra os índices das edits anteriores não deslocarem.
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  const next = [...lines];
  for (const e of ordered) {
    if (e.op === 'replace') next.splice(e.start - 1, e.end - e.start + 1, ...e.lines);
    else next.splice(e.start, 0, ...e.lines); // insere DEPOIS da linha `start`
  }

  const result = next.join(eol);
  return result === lines.join(eol) ? null : result;
}
