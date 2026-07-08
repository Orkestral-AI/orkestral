import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { eq, isNull, isNotNull } from 'drizzle-orm';
import { getDatabase, getSqlite, ORKESTRAL_WORKSPACES_DIR } from '../connection';
import { workspaces } from '../schema';
import type { Workspace } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

export class WorkspaceRepository {
  /** Lista só workspaces ativos (não arquivados). */
  list(): Workspace[] {
    const db = getDatabase();
    return db.select().from(workspaces).where(isNull(workspaces.archivedAt)).all() as Workspace[];
  }

  /** Lista todos, incluindo arquivados — usado em Settings. */
  listAll(): Workspace[] {
    const db = getDatabase();
    return db.select().from(workspaces).all() as Workspace[];
  }

  /** Lista só os arquivados. */
  listArchived(): Workspace[] {
    const db = getDatabase();
    return db
      .select()
      .from(workspaces)
      .where(isNotNull(workspaces.archivedAt))
      .all() as Workspace[];
  }

  create(input: {
    name: string;
    icon?: string;
    color?: string;
    planMode?: 'local' | 'team';
    companyName?: string;
    mission?: string;
    objectives?: string[];
    path?: string;
    gitRemote?: string;
    provider?: 'local' | 'github' | 'azure';
  }): Workspace {
    const db = getDatabase();
    const id = randomUUID();
    const now = nowIso();
    const row: Workspace = {
      id,
      name: input.name,
      companyName: input.companyName ?? input.name,
      mission: input.mission ?? null,
      objectives: input.objectives ?? [],
      path: input.path ?? null,
      gitRemote: input.gitRemote ?? null,
      provider: input.provider ?? null,
      icon: input.icon ?? null,
      color: input.color ?? null,
      planMode: input.planMode ?? 'local',
      activeProjectId: null,
      userProfile: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(workspaces).values(row).run();
    return row;
  }

  switch(workspaceId: string): Workspace {
    const db = getDatabase();
    const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    if (!row) throw new Error(`Workspace ${workspaceId} não encontrado.`);
    return row as Workspace;
  }

  /**
   * Atualiza metadados visuais/identidade do workspace (nome, cor, ícone).
   * Usado pela edição de "cor principal" por workspace nas configs.
   */
  updateMeta(
    workspaceId: string,
    patch: { name?: string; color?: string | null; icon?: string | null },
  ): Workspace {
    const db = getDatabase();
    const now = nowIso();
    const set: Record<string, unknown> = { updatedAt: now };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.color !== undefined) set.color = patch.color;
    if (patch.icon !== undefined) set.icon = patch.icon;
    db.update(workspaces).set(set).where(eq(workspaces.id, workspaceId)).run();
    const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    if (!row) throw new Error(`Workspace ${workspaceId} não encontrado.`);
    return row as Workspace;
  }

  /** Atualiza o path local do workspace — usado após clonar o repo GitHub. */
  setPath(workspaceId: string, path: string): Workspace {
    const db = getDatabase();
    const now = nowIso();
    db.update(workspaces).set({ path, updatedAt: now }).where(eq(workspaces.id, workspaceId)).run();
    const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    if (!row) throw new Error(`Workspace ${workspaceId} não encontrado.`);
    return row as Workspace;
  }

  /** Atualiza o perfil persistente do usuário neste workspace (estilo USER.md). */
  setUserProfile(workspaceId: string, userProfile: string): Workspace {
    const db = getDatabase();
    db.update(workspaces)
      .set({ userProfile, updatedAt: nowIso() })
      .where(eq(workspaces.id, workspaceId))
      .run();
    const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    if (!row) throw new Error(`Workspace ${workspaceId} não encontrado.`);
    return row as Workspace;
  }

  /** Marca workspace como arquivado (some do switcher, mas dados preservados). */
  archive(workspaceId: string): Workspace {
    const db = getDatabase();
    const now = nowIso();
    db.update(workspaces)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(workspaces.id, workspaceId))
      .run();
    const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    if (!row) throw new Error(`Workspace ${workspaceId} não encontrado.`);
    return row as Workspace;
  }

  /** Desarquiva um workspace. */
  unarchive(workspaceId: string): Workspace {
    const db = getDatabase();
    const now = nowIso();
    db.update(workspaces)
      .set({ archivedAt: null, updatedAt: now })
      .where(eq(workspaces.id, workspaceId))
      .run();
    const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    if (!row) throw new Error(`Workspace ${workspaceId} não encontrado.`);
    return row as Workspace;
  }

  /**
   * Exclusão permanente. Cascade: agentes, sessões, mensagens e runs já têm
   * ON DELETE CASCADE no schema. Também limpamos tabelas auxiliares sem FK
   * rígida e apagamos o diretório interno ~/.orkestral/workspaces/<id>/.
   * Pastas locais externas escolhidas pelo usuário não são removidas.
   */
  delete(workspaceId: string): void {
    const sqlite = getSqlite();
    const internalDir = join(ORKESTRAL_WORKSPACES_DIR, workspaceId);

    sqlite.transaction(() => {
      for (const table of [
        'messages_fts',
        'agent_trace_events',
        'trace_logs',
        'task_executions',
        'issue_dependencies',
        // workspace_id sem FK cascade → apagado manualmente aqui (senão fica órfão no delete).
        'forge_edit_examples',
      ]) {
        sqlite.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
      }
      sqlite
        .prepare(
          `DELETE FROM issue_reviewers
         WHERE issue_id IN (SELECT id FROM issues WHERE workspace_id = ?)`,
        )
        .run(workspaceId);
      sqlite.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    })();

    if (existsSync(internalDir)) {
      rmSync(internalDir, { recursive: true, force: true });
    }
  }
}
