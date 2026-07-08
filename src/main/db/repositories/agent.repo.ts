import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { agents } from '../schema';
import type { Agent, AdapterType } from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    role: row.role,
    title: row.title,
    adapterType: (row.adapterType as AdapterType | null) ?? null,
    adapterConfig: row.adapterConfig ?? {},
    model: row.model,
    status: row.status,
    isOrchestrator: row.isOrchestrator,
    canCreateAgents: row.canCreateAgents,
    canAssignTasks: row.canAssignTasks,
    canEditFiles: row.canEditFiles,
    canRunCommands: row.canRunCommands,
    systemPrompt: row.systemPrompt,
    reportsTo: row.reportsTo,
    capabilities: row.capabilities,
    avatarSeed: row.avatarSeed,
    runtimeConfig: row.runtimeConfig ?? {},
    pauseReason: row.pauseReason,
    pausedAt: row.pausedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    heartbeatEnabled: row.heartbeatEnabled,
    heartbeatIntervalMinutes: row.heartbeatIntervalMinutes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class AgentRepository {
  listByWorkspace(workspaceId: string): Agent[] {
    const db = getDatabase();
    const rows = db.select().from(agents).where(eq(agents.workspaceId, workspaceId)).all();
    return rows.map(rowToAgent).sort((a, b) => {
      if (a.isOrchestrator && !b.isOrchestrator) return -1;
      if (!a.isOrchestrator && b.isOrchestrator) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  get(id: string): Agent | null {
    const db = getDatabase();
    const row = db.select().from(agents).where(eq(agents.id, id)).get();
    return row ? rowToAgent(row) : null;
  }

  getOrchestrator(workspaceId: string): Agent | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.isOrchestrator, true)))
      .get();
    return row ? rowToAgent(row) : null;
  }

  create(input: {
    workspaceId: string;
    name: string;
    role?: string;
    title?: string | null;
    adapterType: AdapterType;
    adapterConfig?: Record<string, unknown>;
    model?: string | null;
    systemPrompt?: string;
    capabilities?: string | null;
    reportsTo?: string | null;
    avatarSeed?: string | null;
    canCreateAgents?: boolean;
    canAssignTasks?: boolean;
    canEditFiles?: boolean;
    canRunCommands?: boolean;
    runtimeConfig?: Record<string, unknown>;
  }): Agent {
    const db = getDatabase();
    const now = nowIso();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      role: input.role ?? 'specialist',
      title: input.title ?? null,
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig ?? {},
      provider: input.adapterType,
      model: input.model ?? null,
      effort: 'medium',
      systemPrompt: input.systemPrompt ?? '',
      status: 'idle' as const,
      isOrchestrator: false,
      canCreateAgents: input.canCreateAgents ?? false,
      canAssignTasks: input.canAssignTasks ?? false,
      canEditFiles: input.canEditFiles ?? true,
      canRunCommands: input.canRunCommands ?? false,
      reportsTo: input.reportsTo ?? null,
      capabilities: input.capabilities ?? null,
      avatarSeed: input.avatarSeed ?? null,
      runtimeConfig: input.runtimeConfig ?? ({} as Record<string, unknown>),
      pauseReason: null,
      pausedAt: null,
      lastHeartbeatAt: null,
      heartbeatEnabled: false,
      heartbeatIntervalMinutes: 30,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(agents).values(row).run();
    return rowToAgent(row as typeof agents.$inferSelect);
  }

  /**
   * Atualiza campos editáveis do agente. Mantém imutável: id, workspaceId,
   * isOrchestrator, createdAt. Tudo o mais é editável via UI de Configuração.
   */
  update(
    id: string,
    patch: {
      name?: string;
      title?: string | null;
      role?: string;
      adapterType?: AdapterType;
      adapterConfig?: Record<string, unknown>;
      model?: string | null;
      capabilities?: string | null;
      reportsTo?: string | null;
      avatarSeed?: string | null;
      runtimeConfig?: Record<string, unknown>;
      canCreateAgents?: boolean;
      canAssignTasks?: boolean;
      canEditFiles?: boolean;
      canRunCommands?: boolean;
      heartbeatEnabled?: boolean;
      heartbeatIntervalMinutes?: number;
    },
  ): Agent {
    const db = getDatabase();
    const existing = this.get(id);
    if (!existing) throw new Error(`Agente ${id} não encontrado`);

    const now = nowIso();
    const setPayload: Record<string, unknown> = { updatedAt: now };
    if (patch.name !== undefined) setPayload.name = patch.name.trim();
    if (patch.title !== undefined) setPayload.title = patch.title;
    if (patch.role !== undefined) setPayload.role = patch.role;
    if (patch.adapterType !== undefined) {
      setPayload.adapterType = patch.adapterType;
      setPayload.provider = patch.adapterType;
    }
    if (patch.adapterConfig !== undefined) setPayload.adapterConfig = patch.adapterConfig;
    if (patch.model !== undefined) setPayload.model = patch.model;
    if (patch.capabilities !== undefined) setPayload.capabilities = patch.capabilities;
    if (patch.reportsTo !== undefined) setPayload.reportsTo = patch.reportsTo;
    if (patch.avatarSeed !== undefined) setPayload.avatarSeed = patch.avatarSeed;
    if (patch.runtimeConfig !== undefined) setPayload.runtimeConfig = patch.runtimeConfig;
    if (patch.canCreateAgents !== undefined) setPayload.canCreateAgents = patch.canCreateAgents;
    if (patch.canAssignTasks !== undefined) setPayload.canAssignTasks = patch.canAssignTasks;
    if (patch.canEditFiles !== undefined) setPayload.canEditFiles = patch.canEditFiles;
    if (patch.canRunCommands !== undefined) setPayload.canRunCommands = patch.canRunCommands;
    if (patch.heartbeatEnabled !== undefined) setPayload.heartbeatEnabled = patch.heartbeatEnabled;
    if (patch.heartbeatIntervalMinutes !== undefined)
      setPayload.heartbeatIntervalMinutes = patch.heartbeatIntervalMinutes;

    db.update(agents).set(setPayload).where(eq(agents.id, id)).run();
    return this.get(id)!;
  }

  /** Pausa o agente. Spawn é bloqueado enquanto paused. */
  pause(id: string, reason: string = 'manual'): Agent {
    const db = getDatabase();
    const now = nowIso();
    db.update(agents)
      .set({
        status: 'paused',
        pauseReason: reason,
        pausedAt: now,
        updatedAt: now,
      })
      .where(eq(agents.id, id))
      .run();
    const updated = this.get(id);
    if (!updated) throw new Error(`Agente ${id} não encontrado após pause`);
    return updated;
  }

  /** Retoma o agente — volta pra status idle. */
  resume(id: string): Agent {
    const db = getDatabase();
    const now = nowIso();
    db.update(agents)
      .set({
        status: 'idle',
        pauseReason: null,
        pausedAt: null,
        updatedAt: now,
      })
      .where(eq(agents.id, id))
      .run();
    const updated = this.get(id);
    if (!updated) throw new Error(`Agente ${id} não encontrado após resume`);
    return updated;
  }

  /** Atualiza lastHeartbeatAt — chamado quando uma run de heartbeat conclui. */
  touchHeartbeat(id: string): void {
    const db = getDatabase();
    const now = nowIso();
    db.update(agents).set({ lastHeartbeatAt: now, updatedAt: now }).where(eq(agents.id, id)).run();
  }

  /** Lista agentes elegíveis pra heartbeat agendado (enabled + não pausados). */
  listHeartbeatEnabled(): Agent[] {
    const db = getDatabase();
    const rows = db.select().from(agents).all();
    return rows
      .map(rowToAgent)
      .filter((a) => a.heartbeatEnabled && a.status !== 'paused' && a.adapterType);
  }

  delete(id: string): void {
    const db = getDatabase();
    db.delete(agents).where(eq(agents.id, id)).run();
  }
}
