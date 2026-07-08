import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import { getDatabase, getSqlite } from '../connection';
import {
  embeddingModels,
  kbEmbeddingItems,
  kbEmbeddings,
  type EmbeddingModelRow,
  type KbEmbeddingItemRow,
  type KbEmbeddingRow,
} from '../schema';

function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Short(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

export function vectorToBuffer(vector: readonly number[]): Buffer {
  const buf = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    buf.writeFloatLE(vector[i] ?? 0, i * 4);
  }
  return buf;
}

export function bufferToVector(buffer: Buffer, dimension: number): Float32Array {
  const out = new Float32Array(dimension);
  const max = Math.min(dimension, Math.floor(buffer.length / 4));
  for (let i = 0; i < max; i++) {
    out[i] = buffer.readFloatLE(i * 4);
  }
  return out;
}

export function vectorNorm(vector: readonly number[]): number {
  let sum = 0;
  for (const v of vector) sum += v * v;
  return Math.sqrt(sum);
}

export class KbEmbeddingRepository {
  upsertModel(input: {
    id: string;
    modelPath: string;
    modelHash: string;
    dimension: number;
    contextTokens: number;
  }): EmbeddingModelRow {
    const db = getDatabase();
    const existing = db
      .select()
      .from(embeddingModels)
      .where(eq(embeddingModels.id, input.id))
      .get();
    const now = nowIso();
    if (existing) {
      db.update(embeddingModels)
        .set({
          modelPath: input.modelPath,
          modelHash: input.modelHash,
          dimension: input.dimension,
          contextTokens: input.contextTokens,
          isRequired: 1,
          isActive: 1,
          updatedAt: now,
        })
        .where(eq(embeddingModels.id, input.id))
        .run();
      return db.select().from(embeddingModels).where(eq(embeddingModels.id, input.id)).get()!;
    }
    // Novo embedder (hash/dimensão diferentes) → apaga os modelos ANTERIORES. O FK
    // kbEmbeddings.modelId → embeddingModels.id (ON DELETE CASCADE) limpa os vetores órfãos
    // do embedder antigo, que de toda forma são inúteis (dimensão diferente). Sem isto a
    // tabela cresce sem fim a cada troca de embedder (ex.: Forge↔0.6B), só ocupando disco.
    db.delete(embeddingModels).where(ne(embeddingModels.id, input.id)).run();
    const row = {
      id: input.id,
      provider: 'local-gguf',
      family: 'orkestral-embedding',
      modelPath: input.modelPath,
      modelHash: input.modelHash,
      dimension: input.dimension,
      contextTokens: input.contextTokens,
      isRequired: 1,
      isActive: 1,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(embeddingModels).values(row).run();
    return row;
  }

  activeModel(): EmbeddingModelRow | null {
    const db = getDatabase();
    return (
      db
        .select()
        .from(embeddingModels)
        .where(eq(embeddingModels.isActive, 1))
        .orderBy(desc(embeddingModels.updatedAt))
        .get() ?? null
    );
  }

  upsertPageItem(input: { workspaceId: string; pageId: string; title: string; text: string }): {
    item: KbEmbeddingItemRow;
    changed: boolean;
  } {
    const db = getDatabase();
    const sourceHash = sha256Short(input.text);
    const now = nowIso();
    const existing = db
      .select()
      .from(kbEmbeddingItems)
      .where(
        and(
          eq(kbEmbeddingItems.workspaceId, input.workspaceId),
          eq(kbEmbeddingItems.pageId, input.pageId),
          eq(kbEmbeddingItems.itemKind, 'page'),
        ),
      )
      .get();
    const preview = input.text.replace(/\s+/g, ' ').trim().slice(0, 500);
    const tokenCount = Math.ceil(input.text.length / 4);
    if (existing) {
      const changed = existing.sourceHash !== sourceHash || existing.title !== input.title;
      db.update(kbEmbeddingItems)
        .set({
          sourceHash,
          title: input.title,
          textPreview: preview,
          tokenCount,
          updatedAt: now,
        })
        .where(eq(kbEmbeddingItems.id, existing.id))
        .run();
      return {
        item: db.select().from(kbEmbeddingItems).where(eq(kbEmbeddingItems.id, existing.id)).get()!,
        changed,
      };
    }
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      pageId: input.pageId,
      chunkId: null,
      itemKind: 'page' as const,
      sourceHash,
      title: input.title,
      textPreview: preview,
      tokenCount,
      createdAt: now,
      updatedAt: now,
    };
    try {
      db.insert(kbEmbeddingItems).values(row).run();
      return { item: row, changed: true };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const conflicted = db
        .select()
        .from(kbEmbeddingItems)
        .where(
          and(
            eq(kbEmbeddingItems.workspaceId, input.workspaceId),
            eq(kbEmbeddingItems.pageId, input.pageId),
            eq(kbEmbeddingItems.itemKind, 'page'),
          ),
        )
        .get();
      if (!conflicted) throw err;
      const changed = conflicted.sourceHash !== sourceHash || conflicted.title !== input.title;
      db.update(kbEmbeddingItems)
        .set({
          sourceHash,
          title: input.title,
          textPreview: preview,
          tokenCount,
          updatedAt: now,
        })
        .where(eq(kbEmbeddingItems.id, conflicted.id))
        .run();
      return {
        item: db
          .select()
          .from(kbEmbeddingItems)
          .where(eq(kbEmbeddingItems.id, conflicted.id))
          .get()!,
        changed,
      };
    }
  }

  replacePageChunkItems(input: {
    workspaceId: string;
    pageId: string;
    chunks: Array<{ title: string; text: string }>;
  }): Array<{ item: KbEmbeddingItemRow; changed: boolean }> {
    const db = getDatabase();
    const existing = db
      .select()
      .from(kbEmbeddingItems)
      .where(
        and(
          eq(kbEmbeddingItems.workspaceId, input.workspaceId),
          eq(kbEmbeddingItems.pageId, input.pageId),
          eq(kbEmbeddingItems.itemKind, 'chunk'),
        ),
      )
      .all();
    const existingByHash = new Map(existing.map((item) => [item.sourceHash, item]));
    const wantedHashes = new Set<string>();
    const now = nowIso();
    const out: Array<{ item: KbEmbeddingItemRow; changed: boolean }> = [];

    for (const chunk of input.chunks) {
      const sourceHash = sha256Short(chunk.text);
      wantedHashes.add(sourceHash);
      const preview = chunk.text.replace(/\s+/g, ' ').trim().slice(0, 500);
      const tokenCount = Math.ceil(chunk.text.length / 4);
      const current = existingByHash.get(sourceHash);
      if (current) {
        const changed = current.title !== chunk.title || current.textPreview !== preview;
        db.update(kbEmbeddingItems)
          .set({
            title: chunk.title,
            textPreview: preview,
            tokenCount,
            updatedAt: now,
          })
          .where(eq(kbEmbeddingItems.id, current.id))
          .run();
        out.push({
          item: db
            .select()
            .from(kbEmbeddingItems)
            .where(eq(kbEmbeddingItems.id, current.id))
            .get()!,
          changed,
        });
        continue;
      }
      const row = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        pageId: input.pageId,
        chunkId: null,
        itemKind: 'chunk' as const,
        sourceHash,
        title: chunk.title,
        textPreview: preview,
        tokenCount,
        createdAt: now,
        updatedAt: now,
      };
      try {
        db.insert(kbEmbeddingItems).values(row).run();
        out.push({ item: row, changed: true });
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        const conflicted = db
          .select()
          .from(kbEmbeddingItems)
          .where(
            and(
              eq(kbEmbeddingItems.workspaceId, input.workspaceId),
              eq(kbEmbeddingItems.pageId, input.pageId),
              eq(kbEmbeddingItems.itemKind, 'chunk'),
              eq(kbEmbeddingItems.sourceHash, sourceHash),
            ),
          )
          .get();
        const fallback =
          conflicted ??
          db
            .select()
            .from(kbEmbeddingItems)
            .where(
              and(
                eq(kbEmbeddingItems.workspaceId, input.workspaceId),
                eq(kbEmbeddingItems.pageId, input.pageId),
                eq(kbEmbeddingItems.itemKind, 'chunk'),
              ),
            )
            .get();
        if (!fallback) throw err;
        const changed =
          fallback.sourceHash !== sourceHash ||
          fallback.title !== chunk.title ||
          fallback.textPreview !== preview;
        db.update(kbEmbeddingItems)
          .set({
            sourceHash,
            title: chunk.title,
            textPreview: preview,
            tokenCount,
            updatedAt: now,
          })
          .where(eq(kbEmbeddingItems.id, fallback.id))
          .run();
        out.push({
          item: db
            .select()
            .from(kbEmbeddingItems)
            .where(eq(kbEmbeddingItems.id, fallback.id))
            .get()!,
          changed,
        });
      }
    }

    for (const stale of existing) {
      if (wantedHashes.has(stale.sourceHash)) continue;
      db.delete(kbEmbeddingItems).where(eq(kbEmbeddingItems.id, stale.id)).run();
    }

    return out;
  }

  hasEmbedding(itemId: string, modelId: string, sourceHash: string): boolean {
    const db = getDatabase();
    const row = db
      .select({ id: kbEmbeddings.id })
      .from(kbEmbeddings)
      .innerJoin(kbEmbeddingItems, eq(kbEmbeddings.itemId, kbEmbeddingItems.id))
      .where(
        and(
          eq(kbEmbeddings.itemId, itemId),
          eq(kbEmbeddings.modelId, modelId),
          eq(kbEmbeddingItems.sourceHash, sourceHash),
        ),
      )
      .get();
    return !!row;
  }

  /**
   * Página está totalmente indexada para `modelId` no `pageSourceHash` atual?
   * Verdadeiro só quando o item `page` casa o hash do conteúdo corrente E tem
   * vetor persistido, E TODO item `chunk` da página também tem vetor. Isso prova
   * que um `indexPageEmbedding` anterior rodou até o fim para o conteúdo atual —
   * a fila usa isso para PULAR páginas inalteradas sem re-walk/re-embed (mantém o
   * reuse por-item como rede de segurança quando esta checagem é falsa).
   */
  isPageFullyEmbedded(input: {
    workspaceId: string;
    pageId: string;
    modelId: string;
    pageSourceHash: string;
  }): boolean {
    const sqlite = getSqlite();
    const pageRow = sqlite
      .prepare(
        `SELECT 1
           FROM kb_embedding_items i
           JOIN kb_embeddings e ON e.item_id = i.id AND e.model_id = ?
          WHERE i.workspace_id = ? AND i.page_id = ?
            AND i.item_kind = 'page' AND i.source_hash = ?
          LIMIT 1`,
      )
      .get(input.modelId, input.workspaceId, input.pageId, input.pageSourceHash);
    if (!pageRow) return false;
    // Algum chunk da página sem vetor para este modelo ⇒ índice incompleto.
    const missingChunk = sqlite
      .prepare(
        `SELECT 1
           FROM kb_embedding_items i
          WHERE i.workspace_id = ? AND i.page_id = ? AND i.item_kind = 'chunk'
            AND NOT EXISTS (
              SELECT 1 FROM kb_embeddings e
               WHERE e.item_id = i.id AND e.model_id = ?
            )
          LIMIT 1`,
      )
      .get(input.workspaceId, input.pageId, input.modelId);
    return !missingChunk;
  }

  copyEmbeddingFromSourceHash(input: {
    workspaceId: string;
    itemId: string;
    modelId: string;
    sourceHash: string;
  }): KbEmbeddingRow | null {
    const db = getDatabase();
    const reusable = db
      .select({ embedding: kbEmbeddings })
      .from(kbEmbeddings)
      .innerJoin(kbEmbeddingItems, eq(kbEmbeddings.itemId, kbEmbeddingItems.id))
      .where(
        and(
          eq(kbEmbeddings.modelId, input.modelId),
          eq(kbEmbeddingItems.sourceHash, input.sourceHash),
          ne(kbEmbeddings.itemId, input.itemId),
        ),
      )
      .orderBy(desc(kbEmbeddings.updatedAt))
      .get();
    if (!reusable) return null;

    const now = nowIso();
    const vector = Buffer.from(reusable.embedding.vector as Buffer);
    const existing = db
      .select()
      .from(kbEmbeddings)
      .where(and(eq(kbEmbeddings.itemId, input.itemId), eq(kbEmbeddings.modelId, input.modelId)))
      .get();
    if (existing) {
      db.update(kbEmbeddings)
        .set({
          workspaceId: input.workspaceId,
          dimension: reusable.embedding.dimension,
          vector,
          norm: reusable.embedding.norm,
          updatedAt: now,
        })
        .where(eq(kbEmbeddings.id, existing.id))
        .run();
      return db.select().from(kbEmbeddings).where(eq(kbEmbeddings.id, existing.id)).get()!;
    }

    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      itemId: input.itemId,
      modelId: input.modelId,
      dimension: reusable.embedding.dimension,
      vector,
      norm: reusable.embedding.norm,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(kbEmbeddings).values(row).run();
    return row;
  }

  upsertEmbedding(input: {
    workspaceId: string;
    itemId: string;
    modelId: string;
    vector: readonly number[];
  }): KbEmbeddingRow {
    const db = getDatabase();
    const now = nowIso();
    const existing = db
      .select()
      .from(kbEmbeddings)
      .where(and(eq(kbEmbeddings.itemId, input.itemId), eq(kbEmbeddings.modelId, input.modelId)))
      .get();
    const dimension = input.vector.length;
    const vector = vectorToBuffer(input.vector);
    const norm = vectorNorm(input.vector);
    if (existing) {
      db.update(kbEmbeddings)
        .set({ dimension, vector, norm, updatedAt: now })
        .where(eq(kbEmbeddings.id, existing.id))
        .run();
      return db.select().from(kbEmbeddings).where(eq(kbEmbeddings.id, existing.id)).get()!;
    }
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      itemId: input.itemId,
      modelId: input.modelId,
      dimension,
      vector,
      norm,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(kbEmbeddings).values(row).run();
    return row;
  }

  listVectors(
    workspaceId: string,
    modelId: string,
    limit = 5000,
  ): Array<{
    item: KbEmbeddingItemRow;
    embedding: KbEmbeddingRow;
  }> {
    const db = getDatabase();
    const rows = db
      .select({ item: kbEmbeddingItems, embedding: kbEmbeddings })
      .from(kbEmbeddings)
      .innerJoin(kbEmbeddingItems, eq(kbEmbeddings.itemId, kbEmbeddingItems.id))
      .where(and(eq(kbEmbeddings.workspaceId, workspaceId), eq(kbEmbeddings.modelId, modelId)))
      // Ordem determinística antes do corte: sem ela, qual subconjunto de `limit`
      // vetores é pontuado fica a critério do plano do SQLite (não-determinístico).
      // Prefere itens mais recentes (createdAt DESC) e desempata por id, então a
      // perda de recall na truncagem é estável e previsível entre execuções.
      .orderBy(desc(kbEmbeddingItems.createdAt), kbEmbeddingItems.id)
      .limit(limit)
      .all();
    return rows;
  }

  /**
   * Conta segmentos (chunks) REALMENTE indexados por página — só conta o chunk
   * que tem vetor persistido (join com kb_embeddings). Alimenta o `chunkCount`
   * dos nós do grafo e a "Massa de conhecimento" da HUD (antes lia um campo que
   * nunca era escrito → mostrava 0 mesmo com embeddings prontos).
   */
  chunkCountsByPage(workspaceId: string): Map<string, number> {
    const sqlite = getSqlite();
    const rows = sqlite
      .prepare(
        // COUNT(DISTINCT i.id): um chunk pode ter mais de um vetor (1 por modelo
        // de embedding); contamos o segmento uma vez só, não por modelo.
        `SELECT i.page_id AS pageId, COUNT(DISTINCT i.id) AS c
           FROM kb_embedding_items i
           JOIN kb_embeddings e ON e.item_id = i.id
          WHERE i.workspace_id = ? AND i.item_kind = 'chunk' AND i.page_id IS NOT NULL
          GROUP BY i.page_id`,
      )
      .all(workspaceId) as Array<{ pageId: string; c: number }>;
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.pageId, row.c);
    return map;
  }

  deleteOrphanVectors(workspaceId: string): number {
    const sqlite = getSqlite();
    const info = sqlite
      .prepare(
        `
      DELETE FROM kb_embeddings
      WHERE workspace_id = ?
        AND item_id NOT IN (SELECT id FROM kb_embedding_items WHERE workspace_id = ?)
    `,
      )
      .run(workspaceId, workspaceId);
    return info.changes ?? 0;
  }
}

export const kbEmbeddingRepo = new KbEmbeddingRepository();

function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}
