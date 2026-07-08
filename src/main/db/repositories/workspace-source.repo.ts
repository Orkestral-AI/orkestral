import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { workspaceSources } from '../schema';
import type {
  WorkspaceSource,
  WorkspaceSourceFreshnessStatus,
  WorkspaceSourceKind,
  WorkspaceSourceRole,
} from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToSource(row: typeof workspaceSources.$inferSelect): WorkspaceSource {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as WorkspaceSourceKind,
    path: row.path,
    repoFullName: row.repoFullName,
    label: row.label,
    role: (row.role as WorkspaceSourceRole | null) ?? null,
    isPrimary: !!row.isPrimary,
    displayOrder: row.displayOrder,
    lastIndexedFingerprint: row.lastIndexedFingerprint ?? null,
    lastSyncedFingerprint: row.lastSyncedFingerprint ?? null,
    freshnessStatus: (row.freshnessStatus as WorkspaceSourceFreshnessStatus | null) ?? null,
    lastSyncAt: row.lastSyncAt ?? null,
    syncDetails: row.syncDetailsJson ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateWorkspaceSourceInput {
  workspaceId: string;
  kind: WorkspaceSourceKind;
  path?: string | null;
  repoFullName?: string | null;
  label: string;
  role?: WorkspaceSourceRole | null;
  isPrimary?: boolean;
}

export class WorkspaceSourceRepository {
  listByWorkspace(workspaceId: string): WorkspaceSource[] {
    const db = getDatabase();
    return db
      .select()
      .from(workspaceSources)
      .where(eq(workspaceSources.workspaceId, workspaceId))
      .orderBy(asc(workspaceSources.displayOrder), asc(workspaceSources.createdAt))
      .all()
      .map(rowToSource);
  }

  get(id: string): WorkspaceSource | null {
    const db = getDatabase();
    const row = db.select().from(workspaceSources).where(eq(workspaceSources.id, id)).get();
    return row ? rowToSource(row) : null;
  }

  create(input: CreateWorkspaceSourceInput): WorkspaceSource {
    const db = getDatabase();
    const id = randomUUID();
    const now = nowIso();
    const existing = this.listByWorkspace(input.workspaceId);
    const nextOrder = existing.length;
    // Se for marcado como primary, desmarca os outros
    if (input.isPrimary) {
      db.update(workspaceSources)
        .set({ isPrimary: false, updatedAt: now })
        .where(eq(workspaceSources.workspaceId, input.workspaceId))
        .run();
    }
    db.insert(workspaceSources)
      .values({
        id,
        workspaceId: input.workspaceId,
        kind: input.kind,
        path: input.path ?? null,
        repoFullName: input.repoFullName ?? null,
        label: input.label,
        role: input.role ?? null,
        isPrimary: input.isPrimary ?? existing.length === 0,
        displayOrder: nextOrder,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(id)!;
  }

  update(
    id: string,
    patch: Partial<{
      label: string;
      role: WorkspaceSourceRole | null;
      kind: WorkspaceSourceKind;
      path: string | null;
      repoFullName: string | null;
      displayOrder: number;
      lastIndexedFingerprint: string | null;
      lastSyncedFingerprint: string | null;
      freshnessStatus: WorkspaceSourceFreshnessStatus | null;
      lastSyncAt: string | null;
      syncDetails: Record<string, unknown> | null;
    }>,
  ): WorkspaceSource {
    const db = getDatabase();
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.path !== undefined) set.path = patch.path;
    if (patch.repoFullName !== undefined) set.repoFullName = patch.repoFullName;
    if (patch.displayOrder !== undefined) set.displayOrder = patch.displayOrder;
    if (patch.lastIndexedFingerprint !== undefined)
      set.lastIndexedFingerprint = patch.lastIndexedFingerprint;
    if (patch.lastSyncedFingerprint !== undefined)
      set.lastSyncedFingerprint = patch.lastSyncedFingerprint;
    if (patch.freshnessStatus !== undefined) set.freshnessStatus = patch.freshnessStatus;
    if (patch.lastSyncAt !== undefined) set.lastSyncAt = patch.lastSyncAt;
    if (patch.syncDetails !== undefined) set.syncDetailsJson = patch.syncDetails;
    db.update(workspaceSources).set(set).where(eq(workspaceSources.id, id)).run();
    return this.get(id)!;
  }

  /** Faz o source ser o primary. Desmarca os outros do mesmo workspace. */
  setPrimary(id: string): WorkspaceSource {
    const db = getDatabase();
    const source = this.get(id);
    if (!source) throw new Error('Source não encontrado');
    const now = nowIso();
    db.update(workspaceSources)
      .set({ isPrimary: false, updatedAt: now })
      .where(eq(workspaceSources.workspaceId, source.workspaceId))
      .run();
    db.update(workspaceSources)
      .set({ isPrimary: true, updatedAt: now })
      .where(eq(workspaceSources.id, id))
      .run();
    return this.get(id)!;
  }

  delete(id: string): void {
    const db = getDatabase();
    const source = this.get(id);
    if (!source) return;
    db.delete(workspaceSources).where(eq(workspaceSources.id, id)).run();
    // Se o que foi deletado era primary e ainda há outros, promove o primeiro
    if (source.isPrimary) {
      const remaining = this.listByWorkspace(source.workspaceId);
      if (remaining.length > 0) {
        this.setPrimary(remaining[0].id);
      }
    }
  }

  /** Retorna os repos GitHub do workspace (úteis pra listar PRs de múltiplos repos). */
  listGithubRepos(workspaceId: string): WorkspaceSource[] {
    return this.listByWorkspace(workspaceId).filter(
      (s) => s.kind === 'github_repo' && s.repoFullName,
    );
  }

  /** Pega o source primary. Útil pra back-compat com workspace.gitRemote/path. */
  getPrimary(workspaceId: string): WorkspaceSource | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(workspaceSources)
      .where(
        and(eq(workspaceSources.workspaceId, workspaceId), eq(workspaceSources.isPrimary, true)),
      )
      .get();
    return row ? rowToSource(row) : null;
  }
}
