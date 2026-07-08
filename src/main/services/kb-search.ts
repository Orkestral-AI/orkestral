/**
 * Indexação e busca da KB via BM25 simples implementado direto em SQL.
 *
 * Estratégia:
 *   - Tokens: palavras minúsculas com 2+ chars, sem stopwords PT/EN.
 *   - Field boost: título tem peso 3x, body 1x, tag 2x.
 *   - BM25 com k1=1.5 / b=0.75 (clássicos).
 *
 * Pra cada página, salvamos cada token único na tabela `kb_token_index` com
 * sua frequência. Na busca, calculamos IDF on-the-fly, somamos contribuições
 * por documento, e retornamos top-K.
 */

import { eq, sql } from 'drizzle-orm';
import { getDatabase, getSqlite } from '../db/connection';
import { kbPages, kbTokenIndex } from '../db/schema';
import { sha256Short } from '../db/repositories/kb-embedding.repo';
import { kbCodeChunkRepo } from '../db/repositories/kb-code-chunk.repo';
import { expandKeywords } from './smart-exec/warpgrep';
import type { KbPageKind, KbSearchHit } from '../../shared/types';

const STOPWORDS = new Set([
  'a',
  'o',
  'os',
  'as',
  'um',
  'uma',
  'uns',
  'umas',
  'de',
  'do',
  'da',
  'dos',
  'das',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'por',
  'para',
  'pra',
  'com',
  'sem',
  'que',
  'e',
  'ou',
  'mas',
  'se',
  'é',
  'ser',
  'tem',
  'ter',
  'foi',
  'são',
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
]);

const K1 = 1.5;
const B = 0.75;

// Gate de relevância: páginas cujo BM25 fica abaixo desta fração do TOP hit são
// descartadas. expandKeywords injeta sinônimos/sub-tokens de domínio, então uma
// página que casa só um sinônimo fraco entrava no candidate set e diluía o
// grounding (e podia expulsar hits semânticos genuínos da janela `limit`).
const BM25_RELATIVE_FLOOR = 0.12;

/** Tokenização simples: split por não-alfanum, lowercase, sem stopwords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Re-indexa todas as páginas de um workspace. Caro (linear no número de
 * páginas), mas idempotente — pode chamar depois de qualquer batch de update.
 */
export function reindexWorkspace(workspaceId: string): void {
  const db = getDatabase();
  const pages = db.select().from(kbPages).where(eq(kbPages.workspaceId, workspaceId)).all();
  // Limpa o índice atual e reconstrói tudo numa única transação — um rebuild
  // completo é (páginas × tokens) escritas; sem isso seriam N commits no WAL
  // compartilhado. indexPage limpa por página antes de reinserir, então é
  // seguro chamar dentro da mesma transação.
  getSqlite().transaction(() => {
    db.delete(kbTokenIndex).where(eq(kbTokenIndex.workspaceId, workspaceId)).run();
    for (const p of pages) {
      indexPage(workspaceId, p.id, p.title, p.contentMd ?? '');
    }
  })();
}

/** Indexa (insere) uma página individual. Usado por re-index batch. */
export function indexPage(workspaceId: string, pageId: string, title: string, body: string): void {
  const db = getDatabase();

  // Pula o rebuild quando o conteúdo (title+body) não mudou desde a última
  // indexação — o índice BM25 da página já está atualizado. Linhas antigas têm
  // content_hash NULL (pré-migration) → tratadas como "mudou" e reindexadas.
  const contentHash = sha256Short(`${title}\n${body}`);
  const existing = db
    .select({ contentHash: kbTokenIndex.contentHash })
    .from(kbTokenIndex)
    .where(eq(kbTokenIndex.pageId, pageId))
    .limit(1)
    .get();
  if (existing && existing.contentHash === contentHash) return;

  // Conta tokens por field
  const titleCounts = new Map<string, number>();
  for (const t of tokenize(title)) {
    titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
  }
  const bodyCounts = new Map<string, number>();
  for (const t of tokenize(body)) {
    bodyCounts.set(t, (bodyCounts.get(t) ?? 0) + 1);
  }

  const inserts: Array<{ token: string; tf: number; field: 'title' | 'body' }> = [];
  for (const [token, tf] of titleCounts) {
    inserts.push({ token, tf, field: 'title' });
  }
  for (const [token, tf] of bodyCounts) {
    inserts.push({ token, tf, field: 'body' });
  }

  // Delete + per-token inserts numa única transação: evita N commits
  // auto-committados no WAL compartilhado (contenção de busy_timeout com o core
  // MCP). Página sem tokens (inserts vazio) ainda limpa o índice antigo.
  getSqlite().transaction(() => {
    db.delete(kbTokenIndex).where(eq(kbTokenIndex.pageId, pageId)).run();
    for (const ins of inserts) {
      db.insert(kbTokenIndex)
        .values({
          workspaceId,
          pageId,
          token: ins.token,
          tf: ins.tf,
          field: ins.field,
          contentHash,
        })
        .run();
    }
  })();
}

/** Busca BM25 — retorna top-K páginas mais relevantes. */
export function search(workspaceId: string, query: string, limit = 20): KbSearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const db = getDatabase();

  // Expansão de query: além dos tokens crus, busca por sinônimos de domínio e
  // sub-tokens (camel/snake) — assim uma issue em PT casa páginas indexadas em EN
  // ("validar" ↔ "validation", "autenticação" ↔ "auth") e vice-versa. Tokens que
  // não existem no índice contribuem 0 (df=0 é pulado), então só aumenta recall.
  const { terms } = expandKeywords(tokens);
  const searchTokens = [...new Set([...tokens, ...terms])].filter((t) => t.length >= 2);

  // 1. Estatísticas globais
  const totalDocsRow = db
    .select({ count: sql<number>`count(distinct page_id)` })
    .from(kbTokenIndex)
    .where(eq(kbTokenIndex.workspaceId, workspaceId))
    .get();
  const totalDocs = totalDocsRow?.count ?? 0;
  if (totalDocs === 0) return [];

  // Avg doc length (em tokens body únicos — proxy barato)
  const avgLenRow = db
    .select({ avg: sql<number>`avg(cnt)` })
    .from(
      sql`(SELECT count(*) AS cnt FROM kb_token_index WHERE workspace_id = ${workspaceId} AND field = 'body' GROUP BY page_id)`,
    )
    .get();
  const avgDocLen = avgLenRow?.avg ?? 1;

  // 2. Contribuição BM25 agregada por página — set-based. Antes isso fazia
  // 3 queries POR token expandido (DF + TF + doc-length), serial; expandKeywords
  // multiplica o nº de tokens, então o custo dominava cada busca. Agora: 1 query
  // pra todas as linhas de TF dos tokens + 1 query pros doc-lengths das páginas
  // candidatas, com DF/TF/BM25 computados em JS.
  const tokenList = searchTokens.map((t) => `'${t.replace(/'/g, "''")}'`).join(',') || "''";
  const tfRows = db
    .select({
      pageId: kbTokenIndex.pageId,
      token: kbTokenIndex.token,
      tf: kbTokenIndex.tf,
      field: kbTokenIndex.field,
    })
    .from(kbTokenIndex)
    .where(sql`workspace_id = ${workspaceId} AND token IN (${sql.raw(tokenList)})`)
    .all();
  if (tfRows.length === 0) return [];

  // DF por token = nº de páginas distintas em que o token aparece.
  const dfByToken = new Map<string, Set<string>>();
  const candidatePages = new Set<string>();
  for (const row of tfRows) {
    candidatePages.add(row.pageId);
    let pages = dfByToken.get(row.token);
    if (!pages) {
      pages = new Set();
      dfByToken.set(row.token, pages);
    }
    pages.add(row.pageId);
  }

  // Doc length (tokens body por página) só pras páginas candidatas — 1 query.
  const candidateList =
    [...candidatePages].map((id) => `'${id.replace(/'/g, "''")}'`).join(',') || "''";
  const docLenRows = db
    .select({
      pageId: kbTokenIndex.pageId,
      len: sql<number>`count(*)`,
    })
    .from(kbTokenIndex)
    .where(
      sql`workspace_id = ${workspaceId} AND field = 'body' AND page_id IN (${sql.raw(candidateList)})`,
    )
    .groupBy(kbTokenIndex.pageId)
    .all();
  const lenMap = new Map<string, number>();
  for (const row of docLenRows) lenMap.set(row.pageId, row.len);

  const idfByToken = new Map<string, number>();
  for (const [token, pages] of dfByToken) {
    const df = pages.size;
    idfByToken.set(token, Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5)));
  }

  const scores = new Map<string, number>();
  for (const tfRow of tfRows) {
    const idf = idfByToken.get(tfRow.token) ?? 0;
    if (idf === 0) continue;
    const boost = tfRow.field === 'title' ? 3 : tfRow.field === 'tag' ? 2 : 1;
    const tf = tfRow.tf * boost;
    const docLen = lenMap.get(tfRow.pageId) ?? avgDocLen;
    const norm = 1 - B + B * (docLen / Math.max(1, avgDocLen));
    const contribution = (idf * (tf * (K1 + 1))) / (tf + K1 * norm);
    scores.set(tfRow.pageId, (scores.get(tfRow.pageId) ?? 0) + contribution);
  }

  if (scores.size === 0) return [];

  // 3. Aplica o gate de relevância (relativo ao top hit) ANTES do top-K, depois
  // carrega title/excerpt. Mantém ao menos o top hit mesmo se o floor zerar.
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const topScore = ranked[0]?.[1] ?? 0;
  const floor = topScore * BM25_RELATIVE_FLOOR;
  const gated = ranked.filter(([, score], index) => index === 0 || score >= floor);
  const sorted = gated.slice(0, limit);
  const ids = sorted.map(([id]) => id);
  const idList = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',') || "''";
  const pages = db
    .select()
    .from(kbPages)
    .where(sql`workspace_id = ${workspaceId} AND id IN (${sql.raw(idList)})`)
    .all();

  if (ids.length > 0) {
    db.run(
      sql`UPDATE kb_pages SET retrieval_count = retrieval_count + 1 WHERE workspace_id = ${workspaceId} AND id IN (${sql.raw(idList)})`,
    );
  }

  return sorted
    .map(([pageId, score]) => {
      const page = pages.find((p) => p.id === pageId);
      if (!page) return null;
      const body = page.contentMd ?? '';
      const excerpt = buildExcerpt(body, tokens, 200);
      return {
        pageId: page.id,
        title: page.title,
        slug: page.slug,
        excerpt,
        score,
        parentId: page.parentId,
        kind: page.kind as KbPageKind,
        sourceId: page.sourceId,
      };
    })
    .filter((x): x is KbSearchHit => x !== null);
}

/** Excerpt centralizado no primeiro hit dos tokens. */
function buildExcerpt(body: string, tokens: string[], maxLen: number): string {
  if (!body) return '';
  const lower = body.toLowerCase();
  let bestPos = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0) {
      bestPos = idx;
      break;
    }
  }
  if (bestPos < 0) {
    return body.slice(0, maxLen) + (body.length > maxLen ? '…' : '');
  }
  const start = Math.max(0, bestPos - 60);
  const end = Math.min(body.length, start + maxLen);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return prefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

/**
 * Busca BM25 sobre o CÓDIGO-FONTE indexado (kb_code_chunks), separado do corpus de
 * páginas. Mesma matemática BM25 do `search()` das páginas (K1/B, IDF on-the-fly,
 * field boost: símbolo 4x), mas devolve trechos REAIS com provenance file:line.
 * Retorna KbSearchHit tagueado com `sourceKind:'code'` — o `pageId` é sintético
 * (`code:<chunkId>`) pra não colidir com páginas. NUNCA usa kb_pages.
 */
export function searchCode(workspaceId: string, query: string, limit = 10): KbSearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const { terms } = expandKeywords(tokens);
  const searchTokens = [...new Set([...tokens, ...terms])].filter((t) => t.length >= 2);
  if (searchTokens.length === 0) return [];

  const totalDocs = kbCodeChunkRepo.totalDocs(workspaceId);
  if (totalDocs === 0) return [];
  const avgDocLen = kbCodeChunkRepo.avgDocLen(workspaceId) || 1;

  const tfRows = kbCodeChunkRepo.tfRowsForTokens(workspaceId, searchTokens);
  if (tfRows.length === 0) return [];

  const dfByToken = new Map<string, Set<string>>();
  const candidateChunks = new Set<string>();
  for (const row of tfRows) {
    candidateChunks.add(row.chunkId);
    let pages = dfByToken.get(row.token);
    if (!pages) {
      pages = new Set();
      dfByToken.set(row.token, pages);
    }
    pages.add(row.chunkId);
  }

  const lenMap = kbCodeChunkRepo.docLengths(workspaceId, [...candidateChunks]);

  const idfByToken = new Map<string, number>();
  for (const [token, chunks] of dfByToken) {
    const df = chunks.size;
    idfByToken.set(token, Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5)));
  }

  const scores = new Map<string, number>();
  for (const tfRow of tfRows) {
    const idf = idfByToken.get(tfRow.token) ?? 0;
    if (idf === 0) continue;
    // Símbolo (nome de função/classe/export) é o sinal mais forte de alvo no
    // código — pesa 4x, acima do título de página (3x).
    const boost = tfRow.field === 'symbol' ? 4 : 1;
    const tf = tfRow.tf * boost;
    const docLen = lenMap.get(tfRow.chunkId) ?? avgDocLen;
    const norm = 1 - B + B * (docLen / Math.max(1, avgDocLen));
    const contribution = (idf * (tf * (K1 + 1))) / (tf + K1 * norm);
    scores.set(tfRow.chunkId, (scores.get(tfRow.chunkId) ?? 0) + contribution);
  }
  if (scores.size === 0) return [];

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const topScore = ranked[0]?.[1] ?? 0;
  const floor = topScore * BM25_RELATIVE_FLOOR;
  const gated = ranked.filter(([, score], index) => index === 0 || score >= floor);
  const sorted = gated.slice(0, limit);
  const chunkById = kbCodeChunkRepo.byIds(sorted.map(([id]) => id));

  return sorted
    .map(([chunkId, score]) => {
      const chunk = chunkById.get(chunkId);
      if (!chunk) return null;
      const provenance = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
      const title = chunk.symbol ? `${chunk.symbol} — ${provenance}` : provenance;
      const hit: KbSearchHit = {
        pageId: `code:${chunk.id}`,
        title,
        slug: provenance,
        excerpt: buildExcerpt(chunk.content, tokens, 240),
        score,
        sourceKind: 'code',
        file: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        retrievalMode: 'lexical',
        parentId: null,
        kind: 'doc',
        sourceId: chunk.sourceId,
        citation: {
          pageId: `code:${chunk.id}`,
          title,
          slug: provenance,
          snippet: chunk.content.slice(0, 600),
        },
      };
      return hit;
    })
    .filter((x): x is KbSearchHit => x !== null);
}
