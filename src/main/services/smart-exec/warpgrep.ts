/**
 * WarpGrep — busca de código por linguagem natural, PRÓPRIA do Orkestral,
 * determinística e sem dependência externa.
 *
 * O `exploreRepo` original casava substrings cruas das keywords da issue. Isso
 * erra muito: "authentication" não casa "auth", "validar" não casa "validation",
 * e um match num comentário pesa igual a um match no nome de uma função. Resultado:
 * o executor local edita o arquivo errado → escala. O WarpGrep melhora a PRECISÃO
 * (e barateia o contexto do modelo local) com:
 *
 *  1. Enriquecimento de keywords: split de identificadores (camelCase/snake_case),
 *     stemming PT/EN (sufixos comuns) e um mapa pequeno de sinônimos de domínio.
 *  2. Ranking ESTRUTURAL: match no NOME de função/classe/export/const pesa muito
 *     mais que match em comentário/string; match no caminho do arquivo pesa mais
 *     ainda (sinal forte de alvo).
 *  3. Snippets: devolve as linhas casadas (contexto focado) por arquivo, pra dar
 *     ao modelo local só o trecho relevante em vez do arquivo inteiro.
 *
 * Continua bounded/determinístico (cap de arquivos/tamanho). Caminhos RELATIVOS.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { deriveKeywords } from './explore';

const CODE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.php',
]);

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'coverage',
  '.turbo',
  'resources',
  '.cache',
  'vendor',
]);

/**
 * Sinônimos de domínio (PT↔EN e variações). Mapeia uma keyword pra um conjunto de
 * termos de busca equivalentes. Pequeno de propósito — cobre os domínios mais
 * comuns; o stemming cobre o resto morfologicamente.
 */
const SYNONYMS: Record<string, string[]> = {
  auth: ['auth', 'authentication', 'authenticate', 'login', 'signin', 'autentic'],
  login: ['login', 'signin', 'auth', 'entrar', 'session'],
  logout: ['logout', 'signout', 'session'],
  payment: ['payment', 'pay', 'checkout', 'billing', 'pagament', 'cobranc'],
  billing: ['billing', 'invoice', 'subscription', 'cobranc', 'fatur'],
  user: ['user', 'usuario', 'account', 'conta', 'profile', 'perfil', 'member'],
  message: ['message', 'mensagem', 'chat', 'msg'],
  phone: ['phone', 'telefone', 'whatsapp', 'zapi', 'msisdn', 'celular', 'number', 'numero'],
  number: ['number', 'numero', 'phone', 'telefone', 'digit'],
  validate: ['validate', 'validation', 'validar', 'validac', 'verify', 'verificar', 'check'],
  email: ['email', 'mail', 'smtp'],
  upload: ['upload', 'file', 'arquivo', 'attachment', 'anexo'],
  search: ['search', 'busca', 'buscar', 'query', 'filter', 'filtro'],
  notification: ['notification', 'notificac', 'notify', 'alert', 'toast'],
  setting: ['setting', 'config', 'configurac', 'preference', 'ajuste'],
  webhook: ['webhook', 'callback', 'hook', 'event'],
  api: ['api', 'endpoint', 'route', 'rota', 'controller', 'handler'],
};

/** Sufixos PT/EN removidos no stemming leve (do mais longo ao mais curto). */
const SUFFIXES = [
  'ation',
  'ization',
  'izing',
  'ing',
  'tion',
  'ção',
  'cao',
  'mento',
  'ment',
  'able',
  'ível',
  'ivel',
  'less',
  'ness',
  'ade',
  'ar',
  'er',
  'ir',
  'ed',
  's',
];

/** Reduz uma palavra ao "stem" removendo um sufixo comum (≥4 chars de raiz). */
function stem(word: string): string {
  const w = word.toLowerCase();
  for (const suf of SUFFIXES) {
    if (w.length - suf.length >= 4 && w.endsWith(suf)) return w.slice(0, w.length - suf.length);
  }
  return w;
}

/** Quebra um identificador camelCase/snake_case/kebab em tokens minúsculos. */
function splitIdentifier(tok: string): string[] {
  return tok
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Expande as keywords da issue num conjunto de termos de busca: a própria, seus
 * sub-tokens (camel/snake), o stem e os sinônimos de domínio. Tudo em minúsculas.
 */
/** Um termo casa um grupo de sinônimos se ele (ou o grupo) é prefixo do outro,
 *  com a parte menor >= 4 chars. Captura variação morfológica PT↔EN: "autenticacao"
 *  ↔ "autentic" → grupo auth; "validation" ↔ "validate"; etc. */
function synonymsFor(word: string): string[] {
  const w = word.toLowerCase();
  const out: string[] = [];
  for (const [key, group] of Object.entries(SYNONYMS)) {
    const hit = [key, ...group].some((g) => {
      const short = g.length <= w.length ? g : w;
      const long = g.length <= w.length ? w : g;
      return short.length >= 4 && long.startsWith(short);
    });
    if (hit) out.push(...group);
  }
  return out;
}

export function expandKeywords(keywords: string[]): { terms: Set<string>; stems: Set<string> } {
  const terms = new Set<string>();
  const stems = new Set<string>();
  for (const kw of keywords) {
    for (const part of [kw, ...splitIdentifier(kw)]) {
      if (part.length < 3) continue;
      terms.add(part);
      const st = stem(part);
      stems.add(st);
      terms.add(st); // o stem ("sessions"→"session") casa por substring no código
      for (const s of synonymsFor(part)) terms.add(s);
      if (st !== part) for (const s of synonymsFor(st)) terms.add(s);
    }
  }
  return { terms, stems };
}

/**
 * Linhas de UM arquivo relevantes pra uma query (1-based, ordenadas). Pra dar ao
 * modelo local um "foco" — onde no arquivo está o trecho a mexer — sem precisar
 * varrer o repo. Pesa match estrutural (nome de símbolo) acima de menção solta.
 */
export function findRelevantLines(content: string, query: string, max = 12): number[] {
  const { terms } = expandKeywords(deriveKeywords(query));
  const termList = [...terms].filter((t) => t.length >= 3);
  if (termList.length === 0 || !content) return [];
  const lines = content.split('\n');
  const scored: Array<{ line: number; score: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let s = 0;
    for (const term of termList) {
      if (!lower.includes(term)) continue;
      s += isStructuralHit(lower, term) ? 4 : 1;
    }
    if (s > 0) scored.push({ line: i + 1, score: s });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.line)
    .sort((a, b) => a - b);
}

function* walk(dir: string, depth: number): Generator<string> {
  if (depth > 8) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name) || (name.startsWith('.') && name !== '.env.example')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full, depth + 1);
    else if (CODE_EXT.has(extname(name))) yield full;
  }
}

/** Uma linha casada num arquivo (1-based) + a linha em si (trimada). */
export interface CodeMatch {
  line: number;
  text: string;
}

export interface FileHit {
  file: string;
  score: number;
  matches: CodeMatch[];
}

export interface WarpGrepResult {
  files: string[];
  hits: FileHit[];
  keywords: string[];
  scanned: number;
}

export interface WarpGrepOptions {
  maxFilesScanned?: number;
  maxFileBytes?: number;
  maxResults?: number;
  maxMatchesPerFile?: number;
}

/** Escapa metacaracteres de regex (defensivo — termos vêm de tokens, mas garante). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Um termo aparece como NOME (declaração/uso estrutural) nesta linha? */
function isStructuralHit(lineLower: string, term: string): boolean {
  // term logo após uma palavra-chave de declaração, ou antes de ( / = / : .
  const t = escapeRe(term);
  return (
    new RegExp(
      `\\b(function|const|let|var|class|interface|type|export|def|func|fn|public|private|async)\\b[^\\n]{0,20}\\b${t}\\b`,
    ).test(lineLower) || new RegExp(`\\b${t}\\b\\s*[(=:]`).test(lineLower)
  );
}

/**
 * Busca o repo e devolve arquivos rankeados + snippets das linhas casadas.
 * Score por arquivo: caminho (forte) + estrutural (nome de símbolo) + conteúdo.
 */
export function warpGrepSearch(
  repoPath: string,
  query: string,
  opts: WarpGrepOptions = {},
): WarpGrepResult {
  const maxFilesScanned = opts.maxFilesScanned ?? 2000;
  const maxFileBytes = opts.maxFileBytes ?? 220_000;
  const maxResults = opts.maxResults ?? 6;
  const maxMatchesPerFile = opts.maxMatchesPerFile ?? 8;

  const keywords = deriveKeywords(query);
  if (keywords.length === 0 || !existsSync(repoPath)) {
    return { files: [], hits: [], keywords, scanned: 0 };
  }
  const { terms } = expandKeywords(keywords);
  const termList = [...terms].filter((t) => t.length >= 3);
  if (termList.length === 0) return { files: [], hits: [], keywords, scanned: 0 };

  const root = existsSync(join(repoPath, 'src')) ? join(repoPath, 'src') : repoPath;
  const hits: FileHit[] = [];
  let scanned = 0;

  for (const full of walk(root, 0)) {
    if (scanned >= maxFilesScanned) break;
    scanned++;
    const rel = relative(repoPath, full);
    const relLower = rel.toLowerCase();

    // Match no caminho/nome do arquivo = sinal FORTE de alvo (um arquivo chamado
    // session-search é o alvo óbvio de "session search").
    const pathTerms = termList.filter((t) => relLower.includes(t));

    let content = '';
    try {
      const st = statSync(full);
      if (st.size <= maxFileBytes) content = readFileSync(full, 'utf-8');
    } catch {
      /* ilegível — ignora */
    }

    // Contribuição de conteúdo COM CAP POR TERMO — senão um arquivo gigante (UI com
    // 50 menções a "search") domina o ranking por tamanho, não por relevância.
    const perTerm = new Map<string, number>();
    const matchedTerms = new Set<string>();
    const matches: CodeMatch[] = [];
    if (content) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        let lineScore = 0;
        for (const term of termList) {
          if (!lower.includes(term)) continue;
          matchedTerms.add(term);
          const add = isStructuralHit(lower, term) ? 4 : 1;
          perTerm.set(term, (perTerm.get(term) ?? 0) + add);
          lineScore += add;
        }
        if (lineScore > 0 && matches.length < maxMatchesPerFile) {
          matches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }

    let contentScore = 0;
    for (const v of perTerm.values()) contentScore += Math.min(v, 10); // cap/termo
    // Bônus de COBERTURA: relevância tópica (quantos termos distintos casam) pesa
    // mais que repetir um único termo. + path. Assim o arquivo realmente sobre o
    // assunto vence o arquivo grande que menciona uma palavra muitas vezes.
    const coverageBonus = (matchedTerms.size + pathTerms.length) * 5;
    const score = pathTerms.length * 8 + contentScore + coverageBonus;

    if (score > 0) hits.push({ file: rel, score, matches });
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, maxResults);
  return { files: top.map((h) => h.file), hits: top, keywords, scanned };
}
