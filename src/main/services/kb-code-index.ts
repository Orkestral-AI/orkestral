/**
 * Indexação do CÓDIGO-FONTE real de um source pra retrieval.
 *
 * A análise da KB (kb-repo-analyzer) só indexa PÁGINAS escritas pela IA — então o
 * agente recupera "o que a KB diz sobre o código", nunca o código em si. Este
 * serviço fecha esse gap: varre os arquivos de código do source, fatia cada um em
 * chunks por símbolo/tamanho (com provenance file:line), e indexa no BM25 de código
 * (kb_code_token_index) tagueado como source-kind 'code', distinto das páginas KB.
 *
 * Garantias:
 *   - Respeita .gitignore (parser leve, sem dependência) + blacklist de dirs.
 *   - Pula binários e arquivos grandes (cap por arquivo + cap de total).
 *   - INCREMENTAL: pula arquivo cujos chunks (por content-hash) já estão indexados.
 *   - Bounded: cap duro de arquivos/bytes pra não travar o main thread.
 *
 * FOUNDATION: indexa o caminho BM25 (sempre disponível; o semantic já cai pra BM25
 * quando embeddings faltam). Paridade de vetores semânticos sobre os chunks de
 * código fica como próximo passo (ver residual).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { trace } from './log-bus';
import { tokenize } from './kb-search';
import { sha256Short } from '../db/repositories/kb-embedding.repo';
import {
  kbCodeChunkRepo,
  type CodeChunkInput,
  type CodeChunkTokenSet,
} from '../db/repositories/kb-code-chunk.repo';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.vscode',
  '.idea',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

// Linguagens cobertas pela FOUNDATION. Mantido alinhado ao analyzer; a heurística
// de símbolo é mais forte pra família TS/JS (ver extractSymbolForLine).
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
};

const MAX_FILE_BYTES = 256 * 1024; // pula arquivos individuais maiores
const MAX_FILES = 1500; // cap duro de arquivos varridos
const MAX_CHUNKS_PER_FILE = 60; // cap de chunks por arquivo (arquivo gigante)
const MAX_CHUNK_LINES = 120; // alvo de tamanho de chunk em linhas
const MIN_CHUNK_CHARS = 8; // pula chunk vazio/trivial

interface WalkedCodeFile {
  absPath: string;
  relPath: string;
  ext: string;
}

// -------- .gitignore (parser leve, sem dependência) --------

interface GitignoreRule {
  negate: boolean;
  dirOnly: boolean;
  /** Casa contra o caminho relativo POSIX (sem `/` inicial). */
  test: (relPosix: string, isDir: boolean) => boolean;
}

function globToRegExp(pattern: string): RegExp {
  // Tradução mínima de glob → regex: `*` (qualquer, exceto `/`), `**` (qualquer),
  // `?` (um char). Escapa o resto. Suficiente pra padrões comuns de .gitignore.
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

function parseGitignoreLines(raw: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const lineRaw of raw.split('\n')) {
    let line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    const hasSlash = line.includes('/');
    const regex = globToRegExp(line);
    rules.push({
      negate,
      dirOnly,
      test: (relPosix, isDir) => {
        if (dirOnly && !isDir) return false;
        if (anchored || hasSlash) {
          // Padrão com caminho: casa contra o relPosix inteiro ou seus prefixos.
          if (regex.test(relPosix)) return true;
          return relPosix.startsWith(line + '/');
        }
        // Padrão de basename: casa contra QUALQUER segmento do caminho.
        return relPosix.split('/').some((seg) => regex.test(seg));
      },
    });
  }
  return rules;
}

function parseGitignore(root: string): GitignoreRule[] {
  const path = join(root, '.gitignore');
  if (!existsSync(path)) return [];
  try {
    return parseGitignoreLines(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

/** Aplica as regras em ordem (a última que casa vence — semântica do git). */
function isIgnored(rules: GitignoreRule[], relPosix: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.test(relPosix, isDir)) ignored = !rule.negate;
  }
  return ignored;
}

// -------- detecção de binário --------

/** Heurística barata: NUL byte nos primeiros 8KB ⇒ binário. */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// -------- walk --------

function walkCodeFiles(root: string, rules: GitignoreRule[]): WalkedCodeFile[] {
  const out: WalkedCodeFile[] = [];
  const visit = (dir: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_FILES) return;
      if (IGNORED_DIRS.has(name)) continue;
      // Dotfiles/dirs ocultos pulados (exceto exemplos úteis de env já filtrados
      // por extensão de qualquer forma) — mesma convenção do analyzer/warpgrep.
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      const relPath = relative(root, full);
      const relPosix = relPath.split(sep).join('/');
      if (stat.isDirectory()) {
        if (isIgnored(rules, relPosix, true)) continue;
        visit(full);
      } else if (stat.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!LANG_BY_EXT[ext]) continue;
        if (stat.size > MAX_FILE_BYTES) continue;
        if (isIgnored(rules, relPosix, false)) continue;
        out.push({ absPath: full, relPath, ext });
      }
    }
  };
  visit(root);
  return out;
}

// -------- chunking por símbolo/tamanho --------

/**
 * Detecta o símbolo top-level de uma linha (declaração). Heurística regex,
 * alinhada à extractCodeSymbols do analyzer mas pra UMA linha. Forte em TS/JS;
 * cobre py/go também. Retorna null se a linha não declara um símbolo top-level.
 */
function symbolForLine(line: string, ext: string): string | null {
  const trimmed = line.trimStart();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const m =
      /^export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(
        trimmed,
      ) ??
      /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(trimmed) ??
      /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    return m?.[1] ?? null;
  }
  if (ext === '.py') {
    const m = /^(?:async\s+)?(?:class|def)\s+([A-Za-z_]\w*)/.exec(trimmed);
    return m?.[1] ?? null;
  }
  if (ext === '.go') {
    const m = /^(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(trimmed);
    return m?.[1] ?? null;
  }
  if (['.rs', '.java', '.php', '.rb'].includes(ext)) {
    const m =
      /^(?:pub\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:fn|func|function|class|struct|trait|interface|def|enum)\s+([A-Za-z_]\w*)/.exec(
        trimmed,
      );
    return m?.[1] ?? null;
  }
  return null;
}

interface RawChunk {
  symbol: string | null;
  startLine: number; // 1-based
  endLine: number; // 1-based
  text: string;
}

/**
 * Fatia o conteúdo de um arquivo em chunks com provenance file:line. Quebra em
 * fronteiras de símbolo top-level; cada chunk fica abaixo de MAX_CHUNK_LINES. O
 * 1º bloco antes do 1º símbolo (imports/header) também vira um chunk.
 */
function chunkFile(content: string, ext: string): RawChunk[] {
  const lines = content.split('\n');
  const boundaries: Array<{ line: number; symbol: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const sym = symbolForLine(lines[i], ext);
    if (sym) boundaries.push({ line: i, symbol: sym });
  }

  const chunks: RawChunk[] = [];
  const push = (symbol: string | null, startIdx: number, endIdx: number): void => {
    const slice = lines.slice(startIdx, endIdx + 1).join('\n');
    if (slice.trim().length < MIN_CHUNK_CHARS) return;
    chunks.push({
      symbol,
      startLine: startIdx + 1,
      endLine: endIdx + 1,
      text: slice,
    });
  };

  if (boundaries.length === 0) {
    // Sem símbolos detectados (config, scripts soltos) → janela por tamanho.
    for (let start = 0; start < lines.length; start += MAX_CHUNK_LINES) {
      push(null, start, Math.min(lines.length - 1, start + MAX_CHUNK_LINES - 1));
      if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
    }
    return chunks;
  }

  // Header (antes do 1º símbolo).
  if (boundaries[0].line > 0) push(null, 0, boundaries[0].line - 1);

  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b].line;
    const hardEnd = b + 1 < boundaries.length ? boundaries[b + 1].line - 1 : lines.length - 1;
    // Sub-fatiamento se o símbolo for grande demais (mantém provenance correta).
    for (let s = start; s <= hardEnd; s += MAX_CHUNK_LINES) {
      const e = Math.min(hardEnd, s + MAX_CHUNK_LINES - 1);
      push(boundaries[b].symbol, s, e);
      if (chunks.length >= MAX_CHUNKS_PER_FILE) return chunks;
    }
  }
  return chunks;
}

function tokenSetFor(symbol: string | null, text: string): CodeChunkTokenSet {
  const symbolTokens = new Map<string, number>();
  if (symbol) {
    for (const t of tokenize(symbol)) symbolTokens.set(t, (symbolTokens.get(t) ?? 0) + 1);
  }
  const bodyTokens = new Map<string, number>();
  for (const t of tokenize(text)) bodyTokens.set(t, (bodyTokens.get(t) ?? 0) + 1);
  return { symbol: symbolTokens, body: bodyTokens };
}

export interface CodeIndexResult {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number; // pulados por hash inalterado
  chunksIndexed: number;
}

/**
 * Indexa (incremental) o código-fonte de um source. Síncrono e bounded — pensado
 * pra rodar após a varredura da análise. Cancelável via `aborted`.
 */
export function indexSourceCode(input: {
  workspaceId: string;
  sourceId: string;
  rootPath: string;
  sourceLabel?: string;
  aborted?: { aborted: boolean };
}): CodeIndexResult {
  const { workspaceId, sourceId, rootPath } = input;
  const aborted = input.aborted ?? { aborted: false };
  const result: CodeIndexResult = {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksIndexed: 0,
  };
  if (!existsSync(rootPath)) return result;

  const rules = parseGitignore(rootPath);
  const files = walkCodeFiles(rootPath, rules);
  result.filesScanned = files.length;

  const seenPaths = new Set<string>();
  for (const file of files) {
    if (aborted.aborted) break;
    const relPosix = file.relPath.split(sep).join('/');
    seenPaths.add(relPosix);

    let buf: Buffer;
    try {
      buf = readFileSync(file.absPath);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const content = buf.toString('utf-8');

    const rawChunks = chunkFile(content, file.ext);
    if (rawChunks.length === 0) continue;

    const chunkInputs: CodeChunkInput[] = rawChunks.map((rc) => ({
      filePath: relPosix,
      lang: LANG_BY_EXT[file.ext] ?? null,
      symbol: rc.symbol,
      startLine: rc.startLine,
      endLine: rc.endLine,
      content: rc.text,
      contentHash: sha256Short(`${rc.startLine}:${rc.endLine}\n${rc.text}`),
      tokens: tokenSetFor(rc.symbol, rc.text),
    }));

    // Skip incremental: se o conjunto de content-hashes do arquivo bate com o já
    // indexado, nada mudou → não re-tokeniza nem re-grava.
    const existingHashes = kbCodeChunkRepo.hashesForFile(workspaceId, sourceId, relPosix);
    const newHashes = new Set(chunkInputs.map((c) => c.contentHash));
    const unchanged =
      existingHashes.size === newHashes.size && [...newHashes].every((h) => existingHashes.has(h));
    if (unchanged) {
      result.filesSkipped++;
      continue;
    }

    kbCodeChunkRepo.replaceFileChunks({
      workspaceId,
      sourceId,
      filePath: relPosix,
      chunks: chunkInputs,
    });
    result.filesIndexed++;
    result.chunksIndexed += chunkInputs.length;
  }

  // Poda arquivos que sumiram do source (deletados/movidos/recém-ignorados).
  if (!aborted.aborted) {
    for (const indexed of kbCodeChunkRepo.indexedFilePaths(workspaceId, sourceId)) {
      if (!seenPaths.has(indexed)) {
        kbCodeChunkRepo.deleteFile(workspaceId, sourceId, indexed);
      }
    }
  }

  trace({
    level: 'success',
    source: 'system',
    scope: 'analysis',
    workspaceId,
    message: `código-fonte indexado · ${input.sourceLabel ?? sourceId} · ${result.filesIndexed} arquivo(s) novos/alterados, ${result.filesSkipped} inalterados, ${result.chunksIndexed} chunks`,
  });

  return result;
}

/**
 * Internals exportados SÓ pra teste unitário (a indexação completa toca o DB
 * singleton com ABI do Electron, que não roda no vitest — então testamos a
 * lógica pura de chunking/gitignore/binário/tokenização aqui).
 */
export const __test__ = {
  chunkFile,
  symbolForLine,
  parseGitignoreLines,
  isIgnored,
  looksBinary,
  tokenSetFor,
};
