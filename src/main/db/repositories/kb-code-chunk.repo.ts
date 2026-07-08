import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDatabase, getSqlite } from '../connection';
import { kbCodeChunks, kbCodeTokenIndex, type KbCodeChunkRow } from '../schema';

function nowIso(): string {
  return new Date().toISOString();
}

/** Tokens BM25 de um chunk de código, contados por field (symbol|body). */
export interface CodeChunkTokenSet {
  symbol: Map<string, number>;
  body: Map<string, number>;
}

/** Entrada pra indexar UM chunk de código (já tokenizado pelo serviço). */
export interface CodeChunkInput {
  filePath: string;
  lang: string | null;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  tokens: CodeChunkTokenSet;
}

export class KbCodeChunkRepository {
  /** Hashes (content_hash) já indexados de UM arquivo — alimenta o skip incremental. */
  hashesForFile(workspaceId: string, sourceId: string, filePath: string): Set<string> {
    const db = getDatabase();
    const rows = db
      .select({ contentHash: kbCodeChunks.contentHash })
      .from(kbCodeChunks)
      .where(
        and(
          eq(kbCodeChunks.workspaceId, workspaceId),
          eq(kbCodeChunks.sourceId, sourceId),
          eq(kbCodeChunks.filePath, filePath),
        ),
      )
      .all();
    return new Set(rows.map((r) => r.contentHash));
  }

  /**
   * Substitui TODOS os chunks de um arquivo pelos novos (replace-by-file): deleta
   * os antigos (cascade limpa o token-index) e insere os novos + suas linhas de
   * token, tudo numa única transação SYNC (sem await dentro — better-sqlite3).
   */
  replaceFileChunks(input: {
    workspaceId: string;
    sourceId: string;
    filePath: string;
    chunks: CodeChunkInput[];
  }): void {
    const db = getDatabase();
    const now = nowIso();
    getSqlite().transaction(() => {
      const stale = db
        .select({ id: kbCodeChunks.id })
        .from(kbCodeChunks)
        .where(
          and(
            eq(kbCodeChunks.workspaceId, input.workspaceId),
            eq(kbCodeChunks.sourceId, input.sourceId),
            eq(kbCodeChunks.filePath, input.filePath),
          ),
        )
        .all();
      for (const row of stale) {
        // ON DELETE CASCADE de kb_code_token_index limpa os tokens deste chunk.
        db.delete(kbCodeChunks).where(eq(kbCodeChunks.id, row.id)).run();
      }
      for (const chunk of input.chunks) {
        const id = randomUUID();
        db.insert(kbCodeChunks)
          .values({
            id,
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            filePath: chunk.filePath,
            lang: chunk.lang,
            symbol: chunk.symbol,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content,
            contentHash: chunk.contentHash,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        const inserts: Array<{ token: string; tf: number; field: 'symbol' | 'body' }> = [];
        for (const [token, tf] of chunk.tokens.symbol) inserts.push({ token, tf, field: 'symbol' });
        for (const [token, tf] of chunk.tokens.body) inserts.push({ token, tf, field: 'body' });
        for (const ins of inserts) {
          db.insert(kbCodeTokenIndex)
            .values({
              workspaceId: input.workspaceId,
              chunkId: id,
              token: ins.token,
              tf: ins.tf,
              field: ins.field,
            })
            .run();
        }
      }
    })();
  }

  /** Caminhos de arquivo atualmente indexados pra um source — pra podar deletados. */
  indexedFilePaths(workspaceId: string, sourceId: string): Set<string> {
    const db = getDatabase();
    const rows = db
      .selectDistinct({ filePath: kbCodeChunks.filePath })
      .from(kbCodeChunks)
      .where(and(eq(kbCodeChunks.workspaceId, workspaceId), eq(kbCodeChunks.sourceId, sourceId)))
      .all();
    return new Set(rows.map((r) => r.filePath));
  }

  /** Remove todos os chunks de UM arquivo (arquivo deletado/movido no source). */
  deleteFile(workspaceId: string, sourceId: string, filePath: string): void {
    const db = getDatabase();
    db.delete(kbCodeChunks)
      .where(
        and(
          eq(kbCodeChunks.workspaceId, workspaceId),
          eq(kbCodeChunks.sourceId, sourceId),
          eq(kbCodeChunks.filePath, filePath),
        ),
      )
      .run();
  }

  /** Remove TODOS os chunks de um source. Usado ao deletar o source da workspace. */
  deleteBySourceId(workspaceId: string, sourceId: string): number {
    const db = getDatabase();
    const info = db
      .delete(kbCodeChunks)
      .where(and(eq(kbCodeChunks.workspaceId, workspaceId), eq(kbCodeChunks.sourceId, sourceId)))
      .run();
    return info.changes ?? 0;
  }

  countForSource(workspaceId: string, sourceId: string): number {
    const sqlite = getSqlite();
    const row = sqlite
      .prepare('SELECT COUNT(*) AS c FROM kb_code_chunks WHERE workspace_id = ? AND source_id = ?')
      .get(workspaceId, sourceId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  getById(chunkId: string): KbCodeChunkRow | null {
    const db = getDatabase();
    return db.select().from(kbCodeChunks).where(eq(kbCodeChunks.id, chunkId)).get() ?? null;
  }

  /**
   * Linhas de TF cruas dos tokens de busca (1 query), + metadados dos chunks
   * candidatos. O cálculo BM25 (DF/IDF/doc-length) fica no serviço, espelhando
   * a busca de páginas em kb-search.ts.
   */
  tfRowsForTokens(
    workspaceId: string,
    tokens: string[],
  ): Array<{ chunkId: string; token: string; tf: number; field: string }> {
    if (tokens.length === 0) return [];
    const sqlite = getSqlite();
    const placeholders = tokens.map(() => '?').join(',');
    const rows = sqlite
      .prepare(
        `SELECT chunk_id AS chunkId, token, tf, field
           FROM kb_code_token_index
          WHERE workspace_id = ? AND token IN (${placeholders})`,
      )
      .all(workspaceId, ...tokens) as Array<{
      chunkId: string;
      token: string;
      tf: number;
      field: string;
    }>;
    return rows;
  }

  /** Doc-length (nº de tokens body) dos chunks candidatos — 1 query. */
  docLengths(workspaceId: string, chunkIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (chunkIds.length === 0) return out;
    const sqlite = getSqlite();
    const placeholders = chunkIds.map(() => '?').join(',');
    const rows = sqlite
      .prepare(
        `SELECT chunk_id AS chunkId, COUNT(*) AS len
           FROM kb_code_token_index
          WHERE workspace_id = ? AND field = 'body' AND chunk_id IN (${placeholders})
          GROUP BY chunk_id`,
      )
      .all(workspaceId, ...chunkIds) as Array<{ chunkId: string; len: number }>;
    for (const row of rows) out.set(row.chunkId, row.len);
    return out;
  }

  /** Total de chunks com tokens body (denominador de avg doc length). */
  totalDocs(workspaceId: string): number {
    const sqlite = getSqlite();
    const row = sqlite
      .prepare(
        'SELECT COUNT(DISTINCT chunk_id) AS c FROM kb_code_token_index WHERE workspace_id = ?',
      )
      .get(workspaceId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  avgDocLen(workspaceId: string): number {
    const sqlite = getSqlite();
    const row = sqlite
      .prepare(
        `SELECT AVG(cnt) AS avg FROM (
           SELECT COUNT(*) AS cnt FROM kb_code_token_index
            WHERE workspace_id = ? AND field = 'body' GROUP BY chunk_id
         )`,
      )
      .get(workspaceId) as { avg: number | null } | undefined;
    return row?.avg ?? 1;
  }

  /** Hidrata os metadados de um conjunto de chunks (após o ranking BM25). */
  byIds(chunkIds: string[]): Map<string, KbCodeChunkRow> {
    const out = new Map<string, KbCodeChunkRow>();
    if (chunkIds.length === 0) return out;
    const sqlite = getSqlite();
    const placeholders = chunkIds.map(() => '?').join(',');
    const rows = sqlite
      .prepare(`SELECT * FROM kb_code_chunks WHERE id IN (${placeholders})`)
      .all(...chunkIds) as KbCodeChunkRow[];
    for (const row of rows) out.set(row.id, row);
    return out;
  }
}

export const kbCodeChunkRepo = new KbCodeChunkRepository();
