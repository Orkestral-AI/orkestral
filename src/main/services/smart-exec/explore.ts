/**
 * Exploração de repositório (sem IA, determinística) pro executor local.
 *
 * Quando o plano/título não traz arquivos-alvo concretos, em vez de escalar pro
 * premium, o Forge EXPLORA o repo: deriva keywords da issue (título+descrição) e
 * faz um grep leve sobre arquivos de código, rankeando candidatos por nº de
 * matches. Bounded por padrão (cap de arquivos lidos e de tamanho) pra não
 * estourar tempo/memória.
 *
 * Retorna caminhos RELATIVOS ao repoPath, prontos pro plano local.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

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

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'add',
  'fix',
  'update',
  'change',
  'remove',
  'create',
  'que',
  'com',
  'para',
  'uma',
  'dos',
  'das',
  'adicionar',
  'corrigir',
  'atualizar',
  'mudar',
  'remover',
  'criar',
  'novo',
  'nova',
  'issue',
  'task',
  'tela',
  'page',
]);

export interface ExploreOptions {
  maxFilesScanned?: number;
  maxFileBytes?: number;
  maxResults?: number;
}

/** Extrai keywords significativas do texto da issue (>=3 chars, sem stopwords). */
export function deriveKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Tira acentos ANTES de tokenizar — senão "autenticação" quebra em "autentica"
  // + "o" (ç/ã viram delimitadores) e perde o casamento PT↔EN.
  const normalized = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const tok of normalized.split(/[^a-z0-9_]+/)) {
    if (tok.length < 3 || STOPWORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= 12) break;
  }
  return out;
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
    if (name.startsWith('.') && name !== '.env.example') {
      // pula dotfiles/dotdirs (exceto exemplos), evita custo e áreas sensíveis
      if (IGNORE_DIRS.has(name) || name.startsWith('.')) continue;
    }
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full, depth + 1);
    } else if (CODE_EXT.has(extname(name))) {
      yield full;
    }
  }
}

/**
 * Explora o repo e devolve candidatos rankeados (caminhos relativos) cujo
 * conteúdo/nome casa mais com as keywords da issue.
 */
export function exploreRepo(
  repoPath: string,
  issueText: string,
  opts: ExploreOptions = {},
): { files: string[]; keywords: string[]; scanned: number } {
  const maxFilesScanned = opts.maxFilesScanned ?? 1500;
  const maxFileBytes = opts.maxFileBytes ?? 200_000;
  const maxResults = opts.maxResults ?? 5;

  const keywords = deriveKeywords(issueText);
  if (keywords.length === 0 || !existsSync(repoPath)) {
    return { files: [], keywords, scanned: 0 };
  }

  // Prefere src/ se existir (reduz ruído).
  const root = existsSync(join(repoPath, 'src')) ? join(repoPath, 'src') : repoPath;

  const scores = new Map<string, number>();
  let scanned = 0;

  for (const full of walk(root, 0)) {
    if (scanned >= maxFilesScanned) break;
    scanned++;
    const rel = relative(repoPath, full);
    const relLower = rel.toLowerCase();

    let score = 0;
    // Match no caminho/nome do arquivo conta mais (sinal forte de alvo).
    for (const kw of keywords) {
      if (relLower.includes(kw)) score += 5;
    }

    let content = '';
    try {
      const st = statSync(full);
      if (st.size <= maxFileBytes) content = readFileSync(full, 'utf-8').toLowerCase();
    } catch {
      /* ignora arquivo ilegível */
    }
    if (content) {
      for (const kw of keywords) {
        let from = 0;
        let hits = 0;
        for (;;) {
          const idx = content.indexOf(kw, from);
          if (idx === -1 || hits >= 10) break;
          hits++;
          from = idx + kw.length;
        }
        score += hits;
      }
    }

    if (score > 0) scores.set(rel, score);
  }

  const files = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([rel]) => rel);

  return { files, keywords, scanned };
}
