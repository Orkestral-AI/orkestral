/**
 * Orkestral MCP Morph — executa regras lógicas de diff de código.
 *
 * Applier determinístico e SEM dependências de edits no formato SEARCH/REPLACE
 * (estilo Aider/Cline). O modelo local (Forge) emite blocos; este módulo os
 * parseia e os aplica ao conteúdo original de forma reversível pelo orquestrador.
 *
 * Formato do bloco (cercas obrigatórias):
 *
 *   <<<<<<< SEARCH
 *   <linhas existentes EXATAS>
 *   =======
 *   <linhas novas>
 *   >>>>>>> REPLACE
 *
 * Regras:
 *  - vários blocos por arquivo são permitidos;
 *  - SEARCH vazio  → inserção/criação (prepend do REPLACE);
 *  - REPLACE vazio → deleção do trecho SEARCH;
 *  - cada bloco deve casar EXATAMENTE uma vez (1) match exato; (2) match com
 *    normalização de espaços/trailing; (3) senão, falha o bloco com motivo
 *    claro — NÃO tentamos adivinhar (fuzzy perigoso). Se o SEARCH aparece mais
 *    de uma vez, exige mais contexto ou falha.
 *
 * Determinístico: quem aplica é SEMPRE o app, nunca o modelo. O modelo só
 * produz o TEXTO dos blocos.
 *
 * O Fast Apply do Orkestral é PRÓPRIO e local: o Forge emite um lazy edit e o
 * applier determinístico abaixo (parseEditBlocks/applyEditBlocks) o funde no
 * arquivo SEM serviço externo nem API paga — é 100% próprio. Quando o merge não
 * casa as âncoras, o orquestrador re-ensina o Forge localmente (rewrite do
 * arquivo inteiro); JAMAIS escala pra um modelo premium. Economia é o pilar.
 */

export interface EditBlock {
  /** Texto exato a localizar no original. Vazio = inserção/criação. */
  search: string;
  /** Texto que substitui o SEARCH. Vazio = deleção. */
  replace: string;
}

/**
 * Limiar de similaridade do 3º tier (fuzzy ANCORADO e seguro). Só aplicamos
 * quando existe EXATAMENTE UMA janela com similaridade ≥ este valor. Abaixo
 * disso, ou se houver empate (≥1 janela acima do limiar), REJEITAMOS — nunca
 * adivinhamos (cai pro premium). 0.92 cobre near-misses de espaços/aspas sem
 * abrir margem pra escrever conteúdo errado. NÃO baixar nem permitir multi-match.
 */
export const FUZZY_SIMILARITY_THRESHOLD = 0.92;

const SEARCH_MARK = /^<{5,9} SEARCH\s*$/;
const DIVIDER_MARK = /^={5,9}\s*$/;
const REPLACE_MARK = /^>{5,9} REPLACE\s*$/;

/**
 * Parseia todos os blocos SEARCH/REPLACE de uma saída do modelo, tolerando
 * prosa ao redor (o modelo pequeno às vezes adiciona texto). Cercas markdown
 * (```) são ignoradas. Blocos malformados (sem divider/replace) são descartados.
 */
export function parseEditBlocks(raw: string): EditBlock[] {
  const lines = raw.split('\n');
  const blocks: EditBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!SEARCH_MARK.test(lines[i].trim())) {
      i++;
      continue;
    }
    // Início de um bloco: coleta SEARCH até o divider.
    i++;
    const searchLines: string[] = [];
    let foundDivider = false;
    while (i < lines.length) {
      if (DIVIDER_MARK.test(lines[i].trim())) {
        foundDivider = true;
        i++;
        break;
      }
      searchLines.push(lines[i]);
      i++;
    }
    if (!foundDivider) break; // bloco truncado — abandona

    // Coleta REPLACE até o marcador de fim.
    const replaceLines: string[] = [];
    let foundEnd = false;
    while (i < lines.length) {
      if (REPLACE_MARK.test(lines[i].trim())) {
        foundEnd = true;
        i++;
        break;
      }
      replaceLines.push(lines[i]);
      i++;
    }
    if (!foundEnd) break; // bloco truncado — abandona

    blocks.push({
      search: stripTrailingFence(searchLines).join('\n'),
      replace: stripTrailingFence(replaceLines).join('\n'),
    });
  }

  return blocks;
}

/** Remove uma linha de cerca markdown solta (``` ou ```lang) no fim do bloco. */
function stripTrailingFence(arr: string[]): string[] {
  const out = [...arr];
  while (out.length > 0 && /^```/.test(out[out.length - 1].trim())) out.pop();
  while (out.length > 0 && /^```/.test(out[0].trim())) out.shift();
  return out;
}

function normalizeWs(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Conta ocorrências não sobrepostas de `needle` em `hay`. */
function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    n++;
    from = idx + needle.length;
  }
  return n;
}

export type ApplyResult =
  | { ok: true; content: string; applied: number }
  | { ok: false; reason: string };

/**
 * Aplica os blocos sequencialmente. Cada SEARCH precisa casar EXATAMENTE uma
 * vez (regras lógicas: exato → normalizado por espaços → falha). SEARCH vazio
 * faz prepend/criação. Retorna o conteúdo final mesclado ou um motivo de falha.
 */
export function applyEditBlocks(original: string, blocks: EditBlock[]): ApplyResult {
  if (blocks.length === 0) return { ok: false, reason: 'nenhum bloco SEARCH/REPLACE encontrado' };

  let content = original;
  let applied = 0;

  for (let b = 0; b < blocks.length; b++) {
    const { search, replace } = blocks[b];

    // SEARCH vazio → inserção (prepend) ou criação de arquivo novo.
    if (search.trim() === '') {
      content = content.length === 0 ? replace : `${replace}\n${content}`;
      applied++;
      continue;
    }

    // 1) match exato.
    const exact = countOccurrences(content, search);
    if (exact === 1) {
      content = content.replace(search, () => replace);
      applied++;
      continue;
    }
    if (exact > 1) {
      return {
        ok: false,
        reason: `bloco #${b + 1}: SEARCH casa ${exact}× (ambíguo) — precisa de mais contexto`,
      };
    }

    // 2) match normalizado por espaços/trailing, alinhando por janelas de linhas.
    const matched = applyNormalized(content, search, replace);
    if (matched.ok) {
      content = matched.content;
      applied++;
      continue;
    }

    // 3) fuzzy ANCORADO e seguro: similaridade por janela de mesmo nº de linhas.
    // Só aplica se houver EXATAMENTE UMA janela com sim ≥ FUZZY_SIMILARITY_THRESHOLD.
    // Cobre near-misses (espaços/aspas) que escaparam do tier normalizado, sem
    // jamais adivinhar: 0 ou >1 janelas acima do limiar → falha (premium).
    const fuzzy = applyAnchoredFuzzy(content, search, replace);
    if (fuzzy.ok) {
      content = fuzzy.content;
      applied++;
      continue;
    }

    // 4) falha clara — não adivinha.
    return {
      ok: false,
      reason: `bloco #${b + 1}: SEARCH não encontrado no arquivo (nem exato, nem por espaços, nem fuzzy ≥${FUZZY_SIMILARITY_THRESHOLD})`,
    };
  }

  return { ok: true, content, applied };
}

/**
 * Tenta casar `search` por janela de linhas com normalização de espaços. Casa
 * apenas se houver EXATAMENTE uma janela equivalente; senão falha (sem fuzzy).
 */
function applyNormalized(
  content: string,
  search: string,
  replace: string,
): { ok: true; content: string } | { ok: false } {
  const contentLines = content.split('\n');
  const searchLines = search.split('\n');
  const win = searchLines.length;
  if (win === 0 || win > contentLines.length) return { ok: false };

  const target = normalizeWs(search);
  const matches: number[] = [];
  for (let i = 0; i + win <= contentLines.length; i++) {
    const window = contentLines.slice(i, i + win).join('\n');
    if (normalizeWs(window) === target) matches.push(i);
  }
  if (matches.length !== 1) return { ok: false };

  const start = matches[0];
  const before = contentLines.slice(0, start);
  const after = contentLines.slice(start + win);
  const replaceLines = replace === '' ? [] : replace.split('\n');
  const merged = [...before, ...replaceLines, ...after].join('\n');
  return { ok: true, content: merged };
}

/**
 * Distância de Levenshtein (clássica, O(n·m) em espaço O(min)). Pura/testável.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Garante que `b` seja o menor pra usar menos memória na linha do DP.
  if (a.length < b.length) [a, b] = [b, a];
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Similaridade normalizada (0..1) = 1 - lev / max(len). Antes de comparar,
 * normaliza CADA linha removendo espaços de borda e colapsando espaços internos
 * — assim diferenças só de whitespace/aspas-vizinhas viram alta similaridade,
 * mas mudanças reais de conteúdo derrubam o score. Pura/testável.
 */
export function lineSetSimilarity(a: string, b: string): number {
  const norm = (s: string): string =>
    s
      .split('\n')
      .map((l) => l.trim().replace(/\s+/g, ' '))
      .join('\n');
  const na = norm(a);
  const nb = norm(b);
  if (na.length === 0 && nb.length === 0) return 1;
  const max = Math.max(na.length, nb.length);
  if (max === 0) return 1;
  return 1 - levenshtein(na, nb) / max;
}

/** Linhas de import/use de TOPO de um arquivo (JS/TS `import`, Python `from..import`,
 *  PHP `use`). Normalizadas pra comparação. */
function topLevelImports(src: string): Set<string> {
  const out = new Set<string>();
  for (const raw of src.split('\n')) {
    const l = raw.trim().replace(/\s+/g, ' ');
    if (
      /^import\b/.test(l) ||
      /^from\s+\S+\s+import\b/.test(l) ||
      /^use\s+[\w\\]/.test(l) ||
      /^(?:const|let|var)\s+[\w{},\s]+=\s*require\(/.test(l)
    ) {
      out.add(l);
    }
  }
  return out;
}

/**
 * Guard de fast-apply/merge (inspirado no opencode-morph-fast-apply, MIT): rejeita um
 * resultado que SILENCIOSAMENTE removeu um import/use do topo que existia no original.
 * Um modelo pequeno às vezes "esquece" imports ao reescrever — escrever isso quebraria
 * o build. Retorna true quando algum import do original sumiu no merge.
 */
export function droppedTopLevelImports(original: string, merged: string): boolean {
  const before = topLevelImports(original);
  if (before.size === 0) return false;
  const after = topLevelImports(merged);
  for (const imp of before) if (!after.has(imp)) return true;
  return false;
}

/**
 * 3º tier: casa `search` contra janelas de MESMO nº de linhas em `content` por
 * similaridade. Aplica SOMENTE se houver EXATAMENTE UMA janela com
 * sim ≥ FUZZY_SIMILARITY_THRESHOLD. Zero ou múltiplas (≥1 acima do limiar) →
 * falha (sem palpite perigoso → premium). Mantido puro o quanto possível.
 */
function applyAnchoredFuzzy(
  content: string,
  search: string,
  replace: string,
): { ok: true; content: string } | { ok: false } {
  const contentLines = content.split('\n');
  const searchLines = search.split('\n');
  const win = searchLines.length;
  if (win === 0 || win > contentLines.length) return { ok: false };

  const anchors: number[] = [];
  for (let i = 0; i + win <= contentLines.length; i++) {
    const window = contentLines.slice(i, i + win).join('\n');
    if (lineSetSimilarity(window, search) >= FUZZY_SIMILARITY_THRESHOLD) anchors.push(i);
  }
  // Ambíguo (>1) ou nenhum (<limiar) → rejeita. Só aplica com âncora única.
  if (anchors.length !== 1) return { ok: false };

  const start = anchors[0];
  const before = contentLines.slice(0, start);
  const after = contentLines.slice(start + win);
  const replaceLines = replace === '' ? [] : replace.split('\n');
  const merged = [...before, ...replaceLines, ...after].join('\n');
  return { ok: true, content: merged };
}

// ============================================================================
// LAZY EDIT (estilo Morph fast-apply, porém com merge DETERMINÍSTICO local)
//
// Em vez de exigir que o modelo pequeno reproduza um bloco SEARCH verbatim (o
// que ele erra o tempo todo → escalava), ele emite só o TRECHO que muda,
// mantendo poucas linhas reais ao redor como ÂNCORA e marcando o resto com
// `// ... existing code ...`. O merge é sequencial e determinístico: para cada
// trecho, acha a 1ª e a última linha-âncora (que EXISTEM no original) e
// substitui o span entre elas. O modelo só precisa acertar 2 linhas por trecho.
// ============================================================================

/** Linha marcadora de "código não alterado". Aceita comentário de várias langs. */
const LAZY_ELLIPSIS_RE =
  /^\s*(?:\/\/|#|--|\/\*|\{\s*\/\*|<!--|;)?\s*\.{2,}\s*(?:existing code|c[óo]digo existente|unchanged|resto|rest)\s*\.{2,}\s*(?:\*\/\s*\}?|-->)?\s*$/i;

export function isLazyEllipsis(line: string): boolean {
  return LAZY_ELLIPSIS_RE.test(line);
}

/** Há marcadores de elipse no texto? (heurística pra escolher o applier lazy.) */
export function hasLazyMarkers(text: string): boolean {
  return text.split('\n').some(isLazyEllipsis);
}

/**
 * Razão máxima span/segLen tolerada para um update SEM marcadores de elipse (um
 * único trecho verbatim, sem `// ... existing code ...`). Sem marcadores, o trecho
 * É a região contígua de substituição: o span entre âncoras deve ficar ~igual ao
 * tamanho do trecho. Quando o span é MUITO maior (âncoras curtas/comuns — ex.: `}`
 * ou `};` — casando longe uma da outra e engolindo um bloco inteiro entre elas),
 * trata-se de um match espúrio que gravaria conteúdo mutilado. Rejeitamos (o caller
 * cai pra outro tier ou erra) em vez de escrever. O `+ SLACK` dá folga p/ trechos
 * minúsculos legítimos (poucas linhas) sem liberar a engolida catastrófica. NÃO
 * confiar só no piso de 40% do arquivo inteiro: um span espúrio pode não encolher
 * o arquivo no total. Lazy edits de verdade (com marcadores) NÃO passam por aqui.
 */
export const LAZY_SINGLE_SEGMENT_SPAN_RATIO = 2;
const LAZY_SINGLE_SEGMENT_SPAN_SLACK = 2;

/**
 * Comprimento mínimo (após trim) de uma linha-âncora para ela ser considerada
 * "estruturalmente única". Âncoras curtas/comuns (`}`, `});`, `return;`) podem
 * casar longe uma da outra e engolir um bloco — é o caso que a guarda de span
 * protege. Já um par de âncoras LONGAS e que aparecem UMA única vez no arquivo é
 * um match confiável: um encolhimento/deleção deliberado entre elas é legítimo e
 * NÃO deve ser rejeitado (custaria um retry/escalonamento à toa).
 */
const LAZY_STRONG_ANCHOR_MIN_LEN = 12;

/** A linha é uma âncora "forte" (longa) E aparece exatamente uma vez no arquivo? */
function isStrongUniqueAnchor(origLines: string[], anchor: string): boolean {
  const trimmed = anchor.trim();
  if (trimmed.length < LAZY_STRONG_ANCHOR_MIN_LEN) return false;
  let count = 0;
  for (const line of origLines) {
    if (line.trim() === trimmed) {
      count++;
      if (count > 1) return false;
    }
  }
  return count === 1;
}

/**
 * Normaliza uma linha pra comparação tolerante de âncora: trim, colapsa espaços
 * e REMOVE espaço ao redor de pontuação (`( x )`≈`(x)`, `a , b`≈`a,b`, `) {`≈`){`).
 * Cobre o reformat de espaçamento que o modelo pequeno faz nas âncoras sem fundir
 * linhas de conteúdo diferente (só whitespace muda).
 */
function normAnchor(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(){}[\],;:<>])\s*/g, '$1');
}

/**
 * Normalização TOLERANTE para o fallback de âncora ÚNICA. Além do normAnchor,
 * neutraliza variações que o modelo pequeno faz SEM mudar a identidade da linha:
 * chaves de destructuring (`import { create }` ≈ `import create`) viram espaço, e o
 * estilo de aspas (`'a'`≈`"a"`≈`` `a` ``) é unificado. Só é usada quando há EXATAMENTE
 * UMA linha que casa — nunca adivinha em empate. Pega o caso clássico que escalava
 * pro premium ("import create from 'zustand'" vs "import { create } from 'zustand'").
 */
function normAnchorLoose(s: string): string {
  return s
    .trim()
    .replace(/['"`]/g, "'")
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([()[\],;:<>])\s*/g, '$1')
    .trim();
}

/**
 * Chave estrutural para âncoras JS/TS comuns. Modelos pequenos frequentemente
 * esquecem detalhes da assinatura (`export default function` → `export function`)
 * mas ainda preservam a entidade certa. Só usamos quando a chave é única no
 * arquivo; a linha real do arquivo continua sendo preservada no merge.
 */
function semanticAnchorKey(line: string): string | null {
  const compact = line.trim().replace(/\s+/g, ' ');
  const fn = compact.match(
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,
  );
  if (fn) return `fn:${fn[1]}`;
  const decl = compact.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
  if (decl) return `var:${decl[1]}`;
  const cls = compact.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
  if (cls) return `class:${cls[1]}`;
  return null;
}

/**
 * Acha TODAS as posições em `lines[from..]` que casam com `target` no MELHOR tier
 * disponível, do mais preciso ao mais tolerante: (1) exato (sem trailing space),
 * (2) trim, (3) whitespace interno normalizado. Retorna o primeiro tier não-vazio
 * — assim um match exato nunca é diluído por matches normalizados. Fuzzy de linha
 * única fica fora daqui (resolvido só quando ÚNICO, em anchorPositions).
 */
function matchPositions(lines: string[], target: string, from: number): number[] {
  const exact = target.replace(/\s+$/g, '');
  const trimmed = target.trim();
  const norm = normAnchor(target);
  const tiers: Array<(l: string) => boolean> = [
    (l) => l.replace(/\s+$/g, '') === exact,
    (l) => trimmed.length > 0 && l.trim() === trimmed,
    (l) => norm.length > 0 && normAnchor(l) === norm,
  ];
  for (const test of tiers) {
    const hits: number[] = [];
    for (let i = from; i < lines.length; i++) if (test(lines[i])) hits.push(i);
    if (hits.length > 0) return hits;
  }
  return [];
}

/**
 * Posições candidatas pra uma linha-âncora a partir de `from`. Tenta os tiers
 * exatos/normalizados; se nada casar, cai num fuzzy por linha SOMENTE quando há
 * exatamente UMA linha acima do limiar (≥0.95) — nunca adivinha em empate. Mantém
 * a garantia: a âncora precisa EXISTIR (literal ou quase) no arquivo.
 */
function anchorPositions(lines: string[], target: string, from: number): number[] {
  const direct = matchPositions(lines, target, from);
  if (direct.length > 0) return direct;
  // Tier TOLERANTE (único): casa âncoras quase-iguais que o modelo varia sem mudar a
  // identidade — chaves de import/destructuring e estilo de aspas. SÓ quando há
  // EXATAMENTE UMA linha que casa (sem adivinhar em empate). Antes do semântico
  // (nome-only) porque é mais preciso. Mata a escalação por "âncora não encontrada".
  const loose = normAnchorLoose(target);
  if (loose.length >= 4) {
    const hits: number[] = [];
    for (let i = from; i < lines.length; i++) {
      if (normAnchorLoose(lines[i]) === loose) hits.push(i);
    }
    if (hits.length === 1) return hits;
  }
  const key = semanticAnchorKey(target);
  if (key) {
    const semantic: number[] = [];
    for (let i = from; i < lines.length; i++) {
      if (semanticAnchorKey(lines[i]) === key) semantic.push(i);
    }
    if (semantic.length === 1) return semantic;
  }
  const t = target.trim();
  if (t.length < 4) return []; // linha curta demais pra fuzzy seguro (ex.: "}", ")")
  const fuzzy: number[] = [];
  for (let i = from; i < lines.length; i++) {
    if (lineSetSimilarity(lines[i], target) >= 0.95) fuzzy.push(i);
  }
  return fuzzy.length === 1 ? fuzzy : [];
}

/**
 * Aplica um EDIT PREGUIÇOSO (lazy) ao conteúdo original, de forma determinística.
 *
 * O `update` é o conteúdo só-com-mudanças: trechos de código separados por linhas
 * `// ... existing code ...`. Cada trecho DEVE começar e terminar com uma linha
 * inalterada que existe no original (a âncora). Merge sequencial:
 *  - preserva o original no "gap" antes de cada trecho (head/região entre trechos);
 *  - substitui original[âncoraInício..âncoraFim] pelo trecho inteiro;
 *  - preserva o tail do original após o último trecho.
 *
 * NUNCA descarta conteúdo fora dos spans cobertos. Se uma âncora não casa,
 * FALHA com motivo claro (caller escala) — não adivinha.
 */
export function mergeLazyEdit(original: string, update: string): ApplyResult {
  const origLines = original.replace(/\r\n/g, '\n').split('\n');
  const updateLines = update.replace(/\r\n/g, '\n').split('\n');

  // Sem marcadores de elipse, o update é um ÚNICO trecho verbatim (snippet inteiro)
  // — não um lazy edit de verdade. Nesse caso aplicamos a guarda span/segLen abaixo,
  // pois âncoras curtas/comuns podem casar um span enorme e gravar conteúdo errado.
  const hasMarkers = hasLazyMarkers(update);

  // Segmenta o update em trechos contíguos, separados pelas elipses.
  const segments: string[][] = [];
  let cur: string[] = [];
  for (const ln of updateLines) {
    if (isLazyEllipsis(ln)) {
      if (cur.length) {
        segments.push(cur);
        cur = [];
      }
      continue;
    }
    cur.push(ln);
  }
  if (cur.length) segments.push(cur);

  if (segments.length === 0) return { ok: false, reason: 'lazy edit vazio (sem trechos)' };

  const out: string[] = [];
  let oi = 0;
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    // Âncoras = 1ª e última linha NÃO-vazia do trecho (linhas em branco nas bordas
    // não servem de âncora — casariam em qualquer branco).
    let aStart = 0;
    while (aStart < seg.length && seg[aStart].trim() === '') aStart++;
    let aEnd = seg.length - 1;
    while (aEnd >= 0 && seg[aEnd].trim() === '') aEnd--;
    if (aStart > aEnd) continue; // trecho só com brancos — ignora

    const segLen = aEnd - aStart + 1; // nº de linhas do trecho (âncora→âncora)
    const startCands = anchorPositions(origLines, seg[aStart], oi);
    if (startCands.length === 0) {
      return {
        ok: false,
        reason: `trecho #${s + 1}: âncora de início não encontrada no arquivo: "${seg[aStart].trim().slice(0, 80)}"`,
      };
    }

    // Escolhe o par (início, fim) cujo comprimento de span fica MAIS PRÓXIMO do
    // tamanho do trecho. Isso evita casar uma âncora de fim cedo demais (ex.: o
    // 1º `}` aninhado em vez do `}` da função) — bug clássico do merge ingênuo.
    let best: { start: number; end: number; delta: number } | null = null;
    for (const start of startCands) {
      const endCands = anchorPositions(origLines, seg[aEnd], start);
      for (const end of endCands) {
        if (end < start) continue;
        // Escolhe o span MAIS PRÓXIMO do tamanho do trecho. Não rejeitamos spans
        // grandes (uma deleção legítima mostra 2 âncoras p/ um bloco grande) — a
        // guarda anti-encolhimento no fim cobre o caso catastrófico.
        const delta = Math.abs(end - start + 1 - segLen);
        if (!best || delta < best.delta) best = { start, end, delta };
      }
    }
    if (!best) {
      return {
        ok: false,
        reason: `trecho #${s + 1}: âncora de fim não encontrada após a de início: "${seg[aEnd].trim().slice(0, 80)}"`,
      };
    }
    // Guarda anti-engolida para update SEM marcadores (trecho verbatim único): o
    // span entre âncoras precisa ficar ~do tamanho do trecho. Se o span é muito
    // maior, as âncoras casaram linhas curtas/comuns longe uma da outra e o merge
    // gravaria conteúdo mutilado — rejeita (caller cai pra outro tier ou erra) em
    // vez de escrever. Não confia só no piso de 40% do arquivo (um span espúrio
    // pode não encolher o total).
    if (!hasMarkers) {
      const span = best.end - best.start + 1;
      // Relaxa a guarda quando AMBAS as âncoras são longas e únicas no arquivo: aí
      // o span grande é um encolhimento/deleção DELIBERADO entre âncoras confiáveis,
      // não um match espúrio de linhas curtas/comuns. Sem isso, um collapse legítimo
      // era rejeitado e custava um retry/escalonamento premium desnecessário.
      const strongAnchors =
        isStrongUniqueAnchor(origLines, seg[aStart]) && isStrongUniqueAnchor(origLines, seg[aEnd]);
      if (
        !strongAnchors &&
        span > segLen * LAZY_SINGLE_SEGMENT_SPAN_RATIO + LAZY_SINGLE_SEGMENT_SPAN_SLACK
      ) {
        return {
          ok: false,
          reason: `trecho #${s + 1}: span de ${span} linhas entre âncoras curtas/comuns supera o trecho de ${segLen} linhas (match suspeito, sem marcadores) — rejeitado`,
        };
      }
    }
    // Preserva o original entre o ponto atual e a âncora de início (head/gaps).
    out.push(...origLines.slice(oi, best.start));
    // Emite o trecho inteiro (substitui original[best.start..best.end]).
    const safeSeg = [...seg];
    safeSeg[aStart] = origLines[best.start];
    safeSeg[aEnd] = origLines[best.end];
    out.push(...safeSeg);
    oi = best.end + 1;
  }
  // Preserva o tail do original.
  out.push(...origLines.slice(oi));

  // Guarda final: um lazy edit NUNCA deveria encolher o arquivo drasticamente
  // (ele preserva head/gaps/tail). Se o resultado perdeu mais de 40% das linhas de
  // um arquivo não-trivial, alguma âncora resolveu errado / o modelo dropou código
  // (era o controller perdendo 300 linhas) → rejeita (o caller bloqueia/pede ajuda)
  // em vez de gravar um arquivo mutilado. Apertado de 0.4→0.6: deleção em massa não
  // pedida é quase sempre erro do modelo pequeno; melhor bloquear que destruir.
  if (origLines.length > 30 && out.length < origLines.length * 0.6) {
    return {
      ok: false,
      reason: `merge encolheu o arquivo de ${origLines.length} p/ ${out.length} linhas (âncora suspeita) — rejeitado`,
    };
  }

  return { ok: true, content: out.join('\n'), applied: segments.length };
}
