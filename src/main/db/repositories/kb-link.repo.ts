import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { kbLinks, kbPages, type KbLinkRow } from '../schema';
import type { KbBacklink, KbLink, KbLinkTargetKind } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToLink(row: KbLinkRow): KbLink {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourcePageId: row.sourcePageId,
    targetKind: row.targetKind as KbLinkTargetKind,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    targetUrl: row.targetUrl,
    strength: row.strength,
    createdAt: row.createdAt,
  };
}

export class KbLinkRepository {
  /** Substitui TODOS os links de uma página (sync após save do editor). */
  setLinksForPage(
    workspaceId: string,
    sourcePageId: string,
    links: Array<{
      targetKind: KbLinkTargetKind;
      targetId?: string | null;
      targetLabel?: string | null;
      targetUrl?: string | null;
      strength?: number;
    }>,
  ): void {
    const db = getDatabase();
    db.delete(kbLinks).where(eq(kbLinks.sourcePageId, sourcePageId)).run();
    if (links.length === 0) return;
    const now = nowIso();
    // Dedup por (kind, id||label||url) pra não estourar PK
    const seen = new Set<string>();
    for (const l of links) {
      const key = `${l.targetKind}|${l.targetId ?? ''}|${l.targetLabel ?? ''}|${l.targetUrl ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      db.insert(kbLinks)
        .values({
          id: randomUUID(),
          workspaceId,
          sourcePageId,
          targetKind: l.targetKind,
          targetId: l.targetId ?? null,
          targetLabel: l.targetLabel ?? null,
          targetUrl: l.targetUrl ?? null,
          strength: l.strength ?? 1,
          createdAt: now,
        })
        .run();
    }
  }

  listForPage(sourcePageId: string): KbLink[] {
    const db = getDatabase();
    return db
      .select()
      .from(kbLinks)
      .where(eq(kbLinks.sourcePageId, sourcePageId))
      .all()
      .map(rowToLink);
  }

  /** Backlinks: páginas que apontam pra essa. */
  backlinksToPage(targetPageId: string): KbBacklink[] {
    const db = getDatabase();
    const rows = db
      .select({
        sourcePageId: kbLinks.sourcePageId,
        targetLabel: kbLinks.targetLabel,
        title: kbPages.title,
        slug: kbPages.slug,
      })
      .from(kbLinks)
      .innerJoin(kbPages, eq(kbPages.id, kbLinks.sourcePageId))
      .where(and(eq(kbLinks.targetKind, 'page'), eq(kbLinks.targetId, targetPageId)))
      .all();
    return rows.map((r) => ({
      sourcePageId: r.sourcePageId,
      sourcePageTitle: r.title,
      sourcePageSlug: r.slug,
      label: r.targetLabel,
    }));
  }

  /** Todos os links no workspace (pro graph). */
  listByWorkspace(workspaceId: string): KbLink[] {
    const db = getDatabase();
    return db
      .select()
      .from(kbLinks)
      .where(eq(kbLinks.workspaceId, workspaceId))
      .all()
      .map(rowToLink);
  }
}
