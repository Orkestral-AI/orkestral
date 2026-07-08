import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { skills, agentSkills } from '../schema';
import type { Skill, SkillKind } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToSkill(row: typeof skills.$inferSelect): Skill {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    name: row.name,
    kind: row.kind as SkillKind,
    description: row.description,
    content: row.content,
    config: row.config ?? {},
    createdBy: (row.createdBy as 'user' | 'agent') ?? 'user',
    useCount: row.useCount ?? 0,
    lastUsedAt: row.lastUsedAt ?? null,
    state: (row.state as 'active' | 'archived') ?? 'active',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export class SkillRepository {
  listByWorkspace(workspaceId: string): Skill[] {
    const db = getDatabase();
    const rows = db.select().from(skills).where(eq(skills.workspaceId, workspaceId)).all();
    return rows.map(rowToSkill).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  get(id: string): Skill | null {
    const db = getDatabase();
    const row = db.select().from(skills).where(eq(skills.id, id)).get();
    return row ? rowToSkill(row) : null;
  }

  create(input: {
    workspaceId: string;
    name: string;
    kind?: SkillKind;
    description?: string | null;
    content?: string;
    config?: Record<string, unknown>;
    createdBy?: 'user' | 'agent';
  }): Skill {
    const db = getDatabase();
    const id = randomUUID();
    const now = nowIso();
    let slug = slugify(input.name) || 'skill';
    // Garante unicidade do slug dentro do workspace
    let attempt = slug;
    let suffix = 2;
    while (
      db
        .select()
        .from(skills)
        .where(and(eq(skills.workspaceId, input.workspaceId), eq(skills.slug, attempt)))
        .get()
    ) {
      attempt = `${slug}-${suffix++}`;
    }
    slug = attempt;
    const row = {
      id,
      workspaceId: input.workspaceId,
      slug,
      name: input.name.trim(),
      kind: input.kind ?? 'instruction',
      description: input.description ?? null,
      content: input.content ?? '',
      config: input.config ?? {},
      createdBy: input.createdBy ?? 'user',
      useCount: 0,
      lastUsedAt: null,
      state: 'active' as const,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(skills).values(row).run();
    return rowToSkill(row as typeof skills.$inferSelect);
  }

  /** Incrementa o contador de uso + carimba lastUsedAt (telemetria de skill). */
  bumpUse(id: string): void {
    const db = getDatabase();
    const cur = db.select().from(skills).where(eq(skills.id, id)).get();
    if (!cur) return;
    db.update(skills)
      .set({ useCount: (cur.useCount ?? 0) + 1, lastUsedAt: nowIso() })
      .where(eq(skills.id, id))
      .run();
  }

  /** Arquiva/reativa uma skill (ciclo de vida). */
  setState(id: string, state: 'active' | 'archived'): void {
    const db = getDatabase();
    db.update(skills).set({ state, updatedAt: nowIso() }).where(eq(skills.id, id)).run();
  }

  update(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      content?: string;
      kind?: SkillKind;
      config?: Record<string, unknown>;
    },
  ): Skill {
    const db = getDatabase();
    const now = nowIso();
    const setPayload: Record<string, unknown> = { updatedAt: now };
    if (patch.name !== undefined) setPayload.name = patch.name.trim();
    if (patch.description !== undefined) setPayload.description = patch.description;
    if (patch.content !== undefined) setPayload.content = patch.content;
    if (patch.kind !== undefined) setPayload.kind = patch.kind;
    if (patch.config !== undefined) setPayload.config = patch.config;
    db.update(skills).set(setPayload).where(eq(skills.id, id)).run();
    return this.get(id)!;
  }

  delete(id: string): void {
    const db = getDatabase();
    db.delete(skills).where(eq(skills.id, id)).run();
  }

  // -----  Linkagem agent ↔ skill  -----

  listByAgent(agentId: string): Skill[] {
    const db = getDatabase();
    const rows = db
      .select({
        skill: skills,
      })
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(eq(agentSkills.agentId, agentId))
      .all();
    return rows.map((r) => rowToSkill(r.skill)).sort((a, b) => a.name.localeCompare(b.name));
  }

  attach(agentId: string, skillId: string): void {
    const db = getDatabase();
    const existing = db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)))
      .get();
    if (existing) return;
    db.insert(agentSkills).values({ agentId, skillId, addedAt: nowIso() }).run();
  }

  detach(agentId: string, skillId: string): void {
    const db = getDatabase();
    db.delete(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)))
      .run();
  }
}
