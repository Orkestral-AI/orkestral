import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { kbEntities, kbRelations, type KbEntityRow, type KbRelationRow } from '../schema';
import type { KbEntity, KbEntityKind, KbRelation } from '../../../shared/types';
import { slugify } from './kb-page.repo';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToEntity(row: KbEntityRow): KbEntity {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as KbEntityKind,
    name: row.name,
    slug: row.slug,
    description: row.description,
    mentionCount: row.mentionCount,
    lastMentionedAt: row.lastMentionedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToRelation(row: KbRelationRow): KbRelation {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceEntityId: row.sourceEntityId,
    targetEntityId: row.targetEntityId,
    relationType: row.relationType,
    weight: row.weight,
    createdAt: row.createdAt,
  };
}

export class KbEntityRepository {
  /** Idempotente: encontra por slug ou cria. Incrementa mentionCount sempre. */
  findOrCreate(input: {
    workspaceId: string;
    kind: KbEntityKind;
    name: string;
    description?: string | null;
  }): KbEntity {
    const db = getDatabase();
    const slug = slugify(input.name);
    const existing = db
      .select()
      .from(kbEntities)
      .where(
        and(
          eq(kbEntities.workspaceId, input.workspaceId),
          eq(kbEntities.kind, input.kind),
          eq(kbEntities.slug, slug),
        ),
      )
      .get();
    const now = nowIso();
    if (existing) {
      db.update(kbEntities)
        .set({
          mentionCount: existing.mentionCount + 1,
          lastMentionedAt: now,
          // Preenche descrição se ainda vazia e veio uma nova.
          description: existing.description ?? input.description ?? null,
          updatedAt: now,
        })
        .where(eq(kbEntities.id, existing.id))
        .run();
      return rowToEntity({
        ...existing,
        mentionCount: existing.mentionCount + 1,
        lastMentionedAt: now,
        description: existing.description ?? input.description ?? null,
        updatedAt: now,
      });
    }
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      kind: input.kind,
      name: input.name.trim(),
      slug,
      description: input.description ?? null,
      mentionCount: 1,
      lastMentionedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(kbEntities).values(row).run();
    return rowToEntity(row as KbEntityRow);
  }

  listByWorkspace(workspaceId: string, limit = 500): KbEntity[] {
    const db = getDatabase();
    return db
      .select()
      .from(kbEntities)
      .where(eq(kbEntities.workspaceId, workspaceId))
      .orderBy(sql`mention_count DESC, name ASC`)
      .limit(limit)
      .all()
      .map(rowToEntity);
  }

  /** Cria relação tipada idempotente. */
  addRelation(input: {
    workspaceId: string;
    sourceEntityId: string;
    targetEntityId: string;
    relationType: string;
    weight?: number;
  }): KbRelation {
    const db = getDatabase();
    const existing = db
      .select()
      .from(kbRelations)
      .where(
        and(
          eq(kbRelations.workspaceId, input.workspaceId),
          eq(kbRelations.sourceEntityId, input.sourceEntityId),
          eq(kbRelations.targetEntityId, input.targetEntityId),
          eq(kbRelations.relationType, input.relationType),
        ),
      )
      .get();
    if (existing) {
      const newWeight = Math.max(existing.weight, input.weight ?? 1);
      db.update(kbRelations)
        .set({ weight: newWeight })
        .where(eq(kbRelations.id, existing.id))
        .run();
      return rowToRelation({ ...existing, weight: newWeight });
    }
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId,
      relationType: input.relationType,
      weight: input.weight ?? 1,
      createdAt: nowIso(),
    };
    db.insert(kbRelations).values(row).run();
    return rowToRelation(row as KbRelationRow);
  }

  listRelations(workspaceId: string): KbRelation[] {
    const db = getDatabase();
    return db
      .select()
      .from(kbRelations)
      .where(eq(kbRelations.workspaceId, workspaceId))
      .all()
      .map(rowToRelation);
  }

  /**
   * Apaga TODAS as entidades do workspace que não têm relação com outra
   * entidade nem são referenciadas por nenhuma página via kb_links. Usado
   * quando o usuário limpa a KB e queremos eliminar lixo órfão.
   */
  deleteOrphans(workspaceId: string): number {
    const db = getDatabase();
    const result = db.delete(kbEntities).where(eq(kbEntities.workspaceId, workspaceId)).run();
    // Como a tabela de relações tem FK ON DELETE CASCADE, elas vão junto.
    return result.changes ?? 0;
  }
}
