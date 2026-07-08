import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { projects } from '../schema';
import type { Project } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    path: row.path,
    gitRemote: row.gitRemote,
    provider: (row.provider as 'local' | 'github' | 'azure' | null) ?? null,
    description: row.description,
    knowledgeBaseStatus: row.knowledgeBaseStatus as Project['knowledgeBaseStatus'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ProjectRepository {
  listByWorkspace(workspaceId: string): Project[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId))
      .orderBy(asc(projects.createdAt))
      .all();
    return rows.map(rowToProject);
  }

  get(id: string): Project | null {
    const db = getDatabase();
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    return row ? rowToProject(row) : null;
  }

  create(input: {
    workspaceId: string;
    name: string;
    path?: string | null;
    gitRemote?: string | null;
    provider?: 'local' | 'github' | 'azure' | null;
    description?: string | null;
  }): Project {
    const db = getDatabase();
    const now = nowIso();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      path: input.path ?? null,
      gitRemote: input.gitRemote ?? null,
      provider: input.provider ?? 'local',
      description: input.description ?? null,
      knowledgeBaseStatus: 'not_started' as const,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(projects).values(row).run();
    return rowToProject(row as typeof projects.$inferSelect);
  }

  delete(id: string): void {
    const db = getDatabase();
    db.delete(projects).where(eq(projects.id, id)).run();
  }
}
