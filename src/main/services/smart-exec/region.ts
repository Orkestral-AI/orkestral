/**
 * Extração de REGIÃO editável. Isola a MENOR função/método/classe/bloco que contém
 * o foco da edição, pra o Forge (modelo local pequeno) reescrever SÓ esse trecho —
 * nunca o arquivo inteiro (que um 1.5B não reproduz fiel e DROPA código). O app
 * funde a região de volta determinístico. Assim o Forge edita confiável até em
 * arquivo grande, e o dano fica impossível (só o span da região muda).
 *
 * Determinístico e PURO (sem fs/llama, como morph.ts/warpgrep.ts). Conservador: em
 * QUALQUER ambiguidade retorna null e o caller cai no fallback antigo (nada é
 * gravado sem snapshot + validação + rollback, então região errada nunca destrói).
 */
import { extname } from 'node:path';

export interface Region {
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  text: string; // conteúdo das linhas [startLine..endLine]
  kind: 'brace' | 'indent';
}

/** Região maior que isto não vale a pena isolar (deixa o fallback decidir). */
export const REGION_MAX_LINES = 160;
/** Se a região passa desta fração do arquivo, não é "uma função" — é quase tudo. */
export const REGION_MAX_FILE_RATIO = 0.4;

const BRACE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.php',
  '.java',
  '.go',
  '.rs',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.kt',
  '.swift',
  '.scala',
  '.dart',
]);
const INDENT_EXT = new Set(['.py', '.rb']);

export function detectLangKind(filePath: string): 'brace' | 'indent' | null {
  const ext = extname(filePath).toLowerCase();
  if (BRACE_EXT.has(ext)) return 'brace';
  if (INDENT_EXT.has(ext)) return 'indent';
  return null;
}

// Assinatura de bloco com chaves (multi-linguagem, conservador). Cobre os casos
// comuns: function/func/fn/def/class/interface/struct/enum/trait com modificadores.
const SIGNATURE_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+|async\s+|override\s+|open\s+)*(?:function|func|fn|def|class|interface|struct|enum|trait)\b/;
// Método de classe JS/TS sem keyword de tipo: `foo(args) {` / `async foo(args): T {`.
// O negative-lookahead barra blocos de CONTROLE de FLUXO (`if (…) {`, `for (…) {`,
// `while (…) {`, `switch (…) {`, `catch (…) {` …): eles casam a forma `nome(args) {`
// mas NÃO são uma assinatura de função — anchorar neles isolaria o bloco errado.
const METHOD_RE =
  /^\s*(?!(?:if|for|while|switch|catch|do|with|return|else|await|yield|typeof|delete|void|in|of|new)\b)(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|\*\s*)*[\w$]+\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/;
// Campo arrow: `foo = (args) => {` / `private foo = async (args): T => {`
const ARROW_FIELD_RE =
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*[\w$]+\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{?\s*$/;

function isSignatureLine(line: string): boolean {
  return SIGNATURE_RE.test(line) || METHOD_RE.test(line) || ARROW_FIELD_RE.test(line);
}

/**
 * Acha a linha (0-based) que FECHA o bloco aberto a partir de `fromLine`, contando
 * chaves balanceadas e ignorando `{`/`}` dentro de string/char/comentário. Scanner
 * simples char-a-char. Retorna -1 se não fechar (deixa o caller abortar = null).
 */
function findBlockEnd(lines: string[], fromLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = fromLine; i < lines.length; i++) {
    const line = lines[i];
    let quote: string | null = null;
    let j = 0;
    while (j < line.length) {
      const c = line[j];
      const c2 = j + 1 < line.length ? line[j + 1] : '';
      if (quote) {
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) quote = null;
        j++;
        continue;
      }
      // comentários de linha (//, #) — resto da linha é ignorado
      if ((c === '/' && c2 === '/') || c === '#') break;
      // comentário de bloco /* ... */
      if (c === '/' && c2 === '*') {
        const close = line.indexOf('*/', j + 2);
        j = close === -1 ? line.length : close + 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        j++;
        continue;
      }
      if (c === '{') {
        depth++;
        started = true;
      } else if (c === '}') {
        depth--;
        if (started && depth === 0) return i;
        if (depth < 0) return -1; // desbalanceado — aborta seguro
      }
      j++;
    }
  }
  return -1;
}

/**
 * Acha o span [startLine,endLine] (1-based) do bloco que CONTÉM a âncora (0-based),
 * pras duas estratégias (chaves / indentação). Sem guardas de tamanho — o caller
 * aplica. null quando não há assinatura acima ou o bloco não fecha/não cobre a âncora.
 */
function spanForAnchor(
  lines: string[],
  total: number,
  anchor0: number,
  kind: 'brace' | 'indent',
): { startLine: number; endLine: number } | null {
  if (kind === 'brace') {
    // Sobe da âncora até a linha de ASSINATURA do bloco que a contém.
    let sig = -1;
    for (let i = anchor0; i >= 0 && anchor0 - i < 400; i--) {
      if (isSignatureLine(lines[i])) {
        sig = i;
        break;
      }
    }
    if (sig === -1) return null;
    const end = findBlockEnd(lines, sig);
    if (end === -1 || end < anchor0) return null; // não fechou ou âncora fora do bloco
    return { startLine: sig + 1, endLine: end + 1 };
  }
  // INDENT (Python/Ruby): acha def/class na ou acima da âncora; fim = última linha
  // consecutiva mais indentada (blank no meio conta como dentro).
  const DEF_RE = /^(\s*)(?:async\s+)?(?:def|class)\b/;
  let sig = -1;
  let baseIndent = 0;
  for (let i = anchor0; i >= 0; i--) {
    const m = DEF_RE.exec(lines[i]);
    if (m) {
      sig = i;
      baseIndent = m[1].length;
      break;
    }
  }
  if (sig === -1) return null;
  let end = sig;
  for (let i = sig + 1; i < total; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      end = i;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent > baseIndent) end = i;
    else break;
  }
  while (end > sig && lines[end].trim() === '') end--; // tira blanks finais
  if (end < anchor0) return null;
  return { startLine: sig + 1, endLine: end + 1 };
}

/**
 * Menor bloco `{ … }` BALANCEADO que contém a âncora (0-based). Varredura única pra
 * frente com pilha de aberturas, ignorando chaves dentro de string/char/comentário
 * (mesma tokenização do findBlockEnd). NÃO depende de assinatura de função: pega o
 * container IMEDIATO (callback, bloco JSX `{…}`, objeto literal, `if`/`.map(...)`),
 * que é o caminho confiável pro modelo pequeno num componente React — uma função
 * gigante de JSX onde a região por assinatura seria o componente INTEIRO (grande
 * demais → rejeitada → bloqueio). Retorna o MENOR span que cobre a âncora e cabe em
 * REGION_MAX_LINES, ou null. Determinístico e puro.
 */
function smallestBraceBlock(
  lines: string[],
  anchor0: number,
): { startLine: number; endLine: number } | null {
  const stack: number[] = []; // linhas (0-based) de cada '{' ainda aberto
  let best: { startLine: number; endLine: number } | null = null;
  let quote: string | null = null;
  let blockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let j = 0;
    while (j < line.length) {
      const c = line[j];
      const c2 = j + 1 < line.length ? line[j + 1] : '';
      if (blockComment) {
        if (c === '*' && c2 === '/') {
          blockComment = false;
          j += 2;
          continue;
        }
        j++;
        continue;
      }
      if (quote) {
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) quote = null;
        j++;
        continue;
      }
      if ((c === '/' && c2 === '/') || c === '#') break; // resto da linha é comentário
      if (c === '/' && c2 === '*') {
        blockComment = true;
        j += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        j++;
        continue;
      }
      if (c === '{') {
        stack.push(i);
      } else if (c === '}') {
        const open = stack.pop();
        if (open !== undefined && open <= anchor0 && i >= anchor0) {
          const len = i - open + 1;
          if (len <= REGION_MAX_LINES && (!best || len < best.endLine - best.startLine + 1)) {
            best = { startLine: open + 1, endLine: i + 1 };
          }
        }
      }
      j++;
    }
  }
  return best;
}

/**
 * Isola a MENOR região editável que contém alguma das linhas-foco. `focusLines`
 * (1-based) são as linhas relevantes (findRelevantLines/warpgrep); a ordem delas NÃO
 * é confiável como ranking (o warpgrep reordena por nº de linha), então tentamos
 * CADA uma como âncora e ficamos com a menor região VÁLIDA — a mais específica, e
 * order-independent. Retorna null quando nenhuma âncora isola algo seguro (sem
 * assinatura, região grande demais, linguagem desconhecida) — aí o caller usa o
 * fallback (nada é gravado sem snapshot+validação+rollback).
 */
export function extractEditableRegion(
  content: string,
  focusLines: number[],
  filePath: string,
): Region | null {
  const kind = detectLangKind(filePath);
  if (!kind) return null;
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const total = lines.length;
  if (total === 0 || focusLines.length === 0) return null;

  const fits = (span: { startLine: number; endLine: number }): boolean => {
    const len = span.endLine - span.startLine + 1;
    // Cap absoluto: região grande demais pro modelo pequeno reproduzir bem.
    if (len > REGION_MAX_LINES) return false;
    // Ratio só vale em arquivo SUBSTANCIAL: num arquivo grande, uma "região" que é
    // >40% dele provavelmente é detecção falha (engoliu quase tudo). Em arquivo
    // pequeno (a maioria), isolar a função é seguro mesmo sendo % alta do total.
    if (total > 60 && len > total * REGION_MAX_FILE_RATIO) return false;
    return true;
  };

  // PASS 1 — região por ASSINATURA de função (comportamento original, ótimo pra
  // método de backend). Mantém intacto o caso que já funcionava.
  let best: { startLine: number; endLine: number } | null = null;
  for (const focus of focusLines) {
    const anchor0 = focus - 1; // 1-based → 0-based
    if (anchor0 < 0 || anchor0 >= total) continue;
    const span = spanForAnchor(lines, total, anchor0, kind);
    if (
      span &&
      fits(span) &&
      (!best || span.endLine - span.startLine < best.endLine - best.startLine)
    )
      best = span;
  }

  // PASS 2 (RESGATE, só se a assinatura não isolou nada) — MENOR bloco `{…}` que
  // contém o foco. É o único caminho dentro do JSX de um componente React: a
  // assinatura ali seria o componente INTEIRO (grande demais → null no pass 1),
  // então sem isto o edit de frontend cai no rewrite-inteiro e BLOQUEIA.
  if (!best && kind === 'brace') {
    for (const focus of focusLines) {
      const anchor0 = focus - 1;
      if (anchor0 < 0 || anchor0 >= total) continue;
      const span = smallestBraceBlock(lines, anchor0);
      if (
        span &&
        fits(span) &&
        (!best || span.endLine - span.startLine < best.endLine - best.startLine)
      )
        best = span;
    }
  }
  if (!best) return null;
  const { startLine, endLine } = best;
  return { startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n'), kind };
}

/**
 * Funde a região editada de volta no arquivo, substituindo APENAS o span
 * [startLine..endLine] e mantendo o conteúdo de before/after intacto. Normaliza
 * todo o arquivo pro EOL DOMINANTE (mesma política do applyWholeFile) — num arquivo
 * de EOL misto (raro), linhas fora da região passam pro EOL dominante; o conteúdo
 * das linhas não muda. Pra EOL uniforme (o normal) o resultado é byte-a-byte.
 */
export function spliceRegion(content: string, region: Region, newRegionText: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const before = lines.slice(0, region.startLine - 1);
  const after = lines.slice(region.endLine);
  const middle = newRegionText.replace(/\r\n/g, '\n').split('\n');
  return [...before, ...middle, ...after].join(eol);
}
