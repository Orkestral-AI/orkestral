import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDatabase } from '../connection';
import {
  cleanupSuggestions,
  knowledgeUsageStats,
  type CleanupSuggestionRow,
  type KnowledgeUsageStatsRow,
} from '../schema';

function nowIso(): string {
  return new Date().toISOString();
}

export type KnowledgeTargetKind = 'page' | 'chunk' | 'embedding_item' | 'source';

export class KnowledgeUsageRepository {
  recordHit(input: {
    workspaceId: string;
    targetKind: KnowledgeTargetKind;
    targetId: string;
    sourceId?: string | null;
    hitCount?: number;
  }): KnowledgeUsageStatsRow {
    const db = getDatabase();
    const now = nowIso();
    const existing = db
      .select()
      .from(knowledgeUsageStats)
      .where(
        and(
          eq(knowledgeUsageStats.workspaceId, input.workspaceId),
          eq(knowledgeUsageStats.targetKind, input.targetKind),
          eq(knowledgeUsageStats.targetId, input.targetId),
        ),
      )
      .get();
    if (existing) {
      db.update(knowledgeUsageStats)
        .set({
          sourceId: input.sourceId ?? existing.sourceId,
          useCount: existing.useCount + 1,
          hitCount: existing.hitCount + (input.hitCount ?? 1),
          firstUsedAt: existing.firstUsedAt ?? now,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(eq(knowledgeUsageStats.id, existing.id))
        .run();
      return db
        .select()
        .from(knowledgeUsageStats)
        .where(eq(knowledgeUsageStats.id, existing.id))
        .get()!;
    }
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      sourceId: input.sourceId ?? null,
      useCount: 1,
      hitCount: input.hitCount ?? 1,
      firstUsedAt: now,
      lastUsedAt: now,
      updatedAt: now,
    };
    db.insert(knowledgeUsageStats).values(row).run();
    return row;
  }

  statsForPages(workspaceId: string, pageIds: string[]): Map<string, KnowledgeUsageStatsRow> {
    if (pageIds.length === 0) return new Map();
    const db = getDatabase();
    const rows = db
      .select()
      .from(knowledgeUsageStats)
      .where(
        and(
          eq(knowledgeUsageStats.workspaceId, workspaceId),
          eq(knowledgeUsageStats.targetKind, 'page'),
          inArray(knowledgeUsageStats.targetId, pageIds),
        ),
      )
      .all();
    return new Map(rows.map((r) => [r.targetId, r]));
  }
}

export class CleanupSuggestionRepository {
  upsertOpen(input: {
    workspaceId: string;
    kind: CleanupSuggestionRow['kind'];
    title: string;
    summary: string;
    reason: string;
    payload: unknown;
    estimatedBytes: number;
    itemCount: number;
  }): CleanupSuggestionRow {
    const db = getDatabase();
    const now = nowIso();
    const existing = db
      .select()
      .from(cleanupSuggestions)
      .where(
        and(
          eq(cleanupSuggestions.workspaceId, input.workspaceId),
          eq(cleanupSuggestions.kind, input.kind),
          eq(cleanupSuggestions.status, 'open'),
          eq(cleanupSuggestions.title, input.title),
        ),
      )
      .get();
    const payloadJson = JSON.stringify(input.payload ?? null);
    if (existing) {
      db.update(cleanupSuggestions)
        .set({
          title: input.title,
          summary: input.summary,
          reason: input.reason,
          payloadJson,
          estimatedBytes: Math.max(0, Math.round(input.estimatedBytes)),
          itemCount: input.itemCount,
          updatedAt: now,
        })
        .where(eq(cleanupSuggestions.id, existing.id))
        .run();
      return db
        .select()
        .from(cleanupSuggestions)
        .where(eq(cleanupSuggestions.id, existing.id))
        .get()!;
    }
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      kind: input.kind,
      status: 'open' as const,
      title: input.title,
      summary: input.summary,
      reason: input.reason,
      payloadJson,
      estimatedBytes: Math.max(0, Math.round(input.estimatedBytes)),
      itemCount: input.itemCount,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      appliedAt: null,
    };
    db.insert(cleanupSuggestions).values(row).run();
    return row;
  }

  listOpen(workspaceId: string): CleanupSuggestionRow[] {
    const db = getDatabase();
    return db
      .select()
      .from(cleanupSuggestions)
      .where(
        and(eq(cleanupSuggestions.workspaceId, workspaceId), eq(cleanupSuggestions.status, 'open')),
      )
      .orderBy(sql`${cleanupSuggestions.estimatedBytes} DESC`)
      .all();
  }
}

export const knowledgeUsageRepo = new KnowledgeUsageRepository();
export const cleanupSuggestionRepo = new CleanupSuggestionRepository();
