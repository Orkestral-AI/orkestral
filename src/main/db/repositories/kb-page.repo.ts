import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { kbPages, type KbPageRow } from '../schema';
import type { KbPage, KbPageKind, KbPageNode } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToPage(row: KbPageRow): KbPage {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    title: row.title,
    slug: row.slug,
    kind: row.kind as KbPageKind,
    contentJson: row.contentJson,
    contentMd: row.contentMd,
    icon: row.icon,
    sortOrder: row.sortOrder,
    isPinned: row.isPinned === 1,
    isArchived: row.isArchived === 1,
    sourceId: row.sourceId,
    createdByAgentId: row.createdByAgentId,
    retrievalCount: row.retrievalCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Slug pra wikilinks case-insensitive. Mantém letras unicode/numbers, troca
 * o resto por '-'. Limita 80 chars. Para colisão usa sufixo numérico via
 * `ensureUniqueSlug`.
 */
export function slugify(title: string): string {
  return (
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'page'
  );
}

export class KbPageRepository {
  /** Lista flat de páginas (ordem por sort + título). */
  listByWorkspace(workspaceId: string, includeArchived = false): KbPage[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(kbPages)
      .where(eq(kbPages.workspaceId, workspaceId))
      .orderBy(asc(kbPages.sortOrder), asc(kbPages.title))
      .all();
    return rows.map(rowToPage).filter((p) => includeArchived || !p.isArchived);
  }

  /** Árvore — apenas raízes recursivamente populadas. */
  tree(workspaceId: string): KbPageNode[] {
    const all = this.listByWorkspace(workspaceId, false);
    const byParent = new Map<string | null, KbPage[]>();
    for (const p of all) {
      const key = p.parentId ?? null;
      const arr = byParent.get(key) ?? [];
      arr.push(p);
      byParent.set(key, arr);
    }
    function build(parentId: string | null): KbPageNode[] {
      const children = byParent.get(parentId) ?? [];
      return children.map((c) => {
        const childNodes = build(c.id);
        let descendantCount = childNodes.length;
        for (const cn of childNodes) descendantCount += cn.descendantCount;
        return { ...c, children: childNodes, descendantCount };
      });
    }
    return build(null);
  }

  get(id: string): KbPage | null {
    const db = getDatabase();
    const row = db.select().from(kbPages).where(eq(kbPages.id, id)).get();
    return row ? rowToPage(row) : null;
  }

  /**
   * Como `get`, mas só retorna a página se ela pertencer ao workspace dado.
   * Usado pelas MCP tools pra impedir um agente do workspace A de ler/escrever
   * páginas do workspace B só passando o UUID delas (cross-workspace access).
   */
  getScoped(workspaceId: string, id: string): KbPage | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(kbPages)
      .where(and(eq(kbPages.id, id), eq(kbPages.workspaceId, workspaceId)))
      .get();
    return row ? rowToPage(row) : null;
  }

  getBySlug(workspaceId: string, slug: string): KbPage | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(kbPages)
      .where(and(eq(kbPages.workspaceId, workspaceId), eq(kbPages.slug, slug)))
      .get();
    return row ? rowToPage(row) : null;
  }

  /** Resolve [[título]] → page. Tenta slug match case-insensitive. */
  resolveWikilink(workspaceId: string, label: string): KbPage | null {
    const slug = slugify(label);
    const exact = this.getBySlug(workspaceId, slug);
    if (exact) return exact;
    // Fallback: procura por título parcial
    const all = this.listByWorkspace(workspaceId, false);
    const lowered = label.toLowerCase().trim();
    return (
      all.find((p) => p.title.toLowerCase() === lowered) ??
      all.find((p) => p.title.toLowerCase().includes(lowered)) ??
      null
    );
  }

  /** Encontra próximo slug livre (dedup com sufixo numérico). */
  private ensureUniqueSlug(workspaceId: string, baseSlug: string): string {
    let slug = baseSlug;
    let i = 1;
    while (this.getBySlug(workspaceId, slug)) {
      i++;
      slug = `${baseSlug}-${i}`;
      if (i > 1000) throw new Error('Não foi possível gerar slug único');
    }
    return slug;
  }

  /** Cria página nova. Calcula slug auto se não vier explicitamente. */
  create(input: {
    workspaceId: string;
    title: string;
    parentId?: string | null;
    kind?: KbPageKind;
    contentJson?: string | null;
    contentMd?: string | null;
    icon?: string | null;
    sourceId?: string | null;
    createdByAgentId?: string | null;
    sortOrder?: number;
  }): KbPage {
    const db = getDatabase();
    const id = randomUUID();
    const now = nowIso();
    const slug = this.ensureUniqueSlug(input.workspaceId, slugify(input.title));
    const sortOrder =
      input.sortOrder ?? this.nextSortOrder(input.workspaceId, input.parentId ?? null);
    const row = {
      id,
      workspaceId: input.workspaceId,
      parentId: input.parentId ?? null,
      title: input.title.trim() || 'Sem título',
      slug,
      kind: (input.kind ?? 'doc') as KbPageKind,
      contentJson: input.contentJson ?? null,
      contentMd: input.contentMd ?? null,
      icon: input.icon ?? null,
      sortOrder,
      isPinned: 0,
      isArchived: 0,
      sourceId: input.sourceId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      retrievalCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(kbPages).values(row).run();
    return rowToPage(row as KbPageRow);
  }

  /** Idempotente — se já existe slug, retorna existente (não atualiza). */
  findOrCreate(input: {
    workspaceId: string;
    title: string;
    parentId?: string | null;
    kind?: KbPageKind;
    contentMd?: string | null;
    sourceId?: string | null;
  }): { page: KbPage; created: boolean } {
    const slug = slugify(input.title);
    const existing = this.getBySlug(input.workspaceId, slug);
    if (existing) return { page: existing, created: false };
    return { page: this.create(input), created: true };
  }

  /**
   * Remove TODAS as páginas ligadas a um sourceId. Usado antes de re-analisar
   * um source: limpa o estado anterior pra evitar duplicatas e órfãos como
   * "Repo: X com 'Análise em andamento'" que ficou pra trás.
   *
   * Retorna a quantidade de páginas removidas (pra log).
   */
  deleteBySourceId(workspaceId: string, sourceId: string): number {
    const db = getDatabase();
    const rows = db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(and(eq(kbPages.workspaceId, workspaceId), eq(kbPages.sourceId, sourceId)))
      .all();
    for (const r of rows) {
      db.delete(kbPages).where(eq(kbPages.id, r.id)).run();
    }
    return rows.length;
  }

  update(
    id: string,
    patch: Partial<{
      title: string;
      parentId: string | null;
      contentJson: string | null;
      contentMd: string | null;
      icon: string | null;
      sortOrder: number;
      isPinned: boolean;
      isArchived: boolean;
      sourceId: string | null;
    }>,
  ): KbPage | null {
    const db = getDatabase();
    const setPayload: Partial<KbPageRow> = { updatedAt: nowIso() };
    if (patch.title !== undefined) {
      const current = this.get(id);
      // Página sumiu (race: um job concorrente de análise/limpeza deletou enquanto
      // este update estava em voo). Não é erro fatal — devolve null e o chamador segue.
      if (!current) return null;
      setPayload.title = patch.title.trim() || 'Sem título';
      // Re-slug apenas se o título mudou e o slug atual era baseado no título antigo
      const oldSlugFromTitle = slugify(current.title);
      if (current.slug === oldSlugFromTitle) {
        setPayload.slug = this.ensureUniqueSlug(current.workspaceId, slugify(setPayload.title));
      }
    }
    if (patch.parentId !== undefined) setPayload.parentId = patch.parentId;
    if (patch.contentJson !== undefined) setPayload.contentJson = patch.contentJson;
    if (patch.contentMd !== undefined) setPayload.contentMd = patch.contentMd;
    if (patch.icon !== undefined) setPayload.icon = patch.icon;
    if (patch.sortOrder !== undefined) setPayload.sortOrder = patch.sortOrder;
    if (patch.isPinned !== undefined) setPayload.isPinned = patch.isPinned ? 1 : 0;
    if (patch.isArchived !== undefined) setPayload.isArchived = patch.isArchived ? 1 : 0;
    if (patch.sourceId !== undefined) setPayload.sourceId = patch.sourceId;
    db.update(kbPages).set(setPayload).where(eq(kbPages.id, id)).run();
    const row = db.select().from(kbPages).where(eq(kbPages.id, id)).get();
    // TOCTOU: a página pode ter sido deletada por um job concorrente entre o UPDATE
    // e o SELECT (ou já não existia). Antes isto LANÇAVA "não encontrada após update"
    // e quebrava a análise inteira (toast "Análise falhou"). Agora tolera: null e segue.
    if (!row) {
      console.warn(
        `[kb-page] update: página ${id} sumiu (deletada por job concorrente) — ignorando`,
      );
      return null;
    }
    return rowToPage(row);
  }

  delete(id: string): void {
    const db = getDatabase();
    db.delete(kbPages).where(eq(kbPages.id, id)).run();
  }

  /** Próximo sort_order para inserir no fim de uma pasta. */
  private nextSortOrder(workspaceId: string, parentId: string | null): number {
    const db = getDatabase();
    const filter = parentId
      ? and(eq(kbPages.workspaceId, workspaceId), eq(kbPages.parentId, parentId))
      : and(eq(kbPages.workspaceId, workspaceId), isNull(kbPages.parentId));
    const rows = db
      .select()
      .from(kbPages)
      .where(filter)
      .orderBy(desc(kbPages.sortOrder))
      .limit(1)
      .all();
    return rows.length === 0 ? 0 : rows[0].sortOrder + 1;
  }

  /** Atualiza recentemente-mencionada — usado pelo agente quando lê. */
  touch(id: string): void {
    const db = getDatabase();
    db.update(kbPages).set({ updatedAt: nowIso() }).where(eq(kbPages.id, id)).run();
  }
}
