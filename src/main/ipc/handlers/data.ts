import { dialog, BrowserWindow } from '../../platform/electron';
import { appInfo } from '../../platform/host';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql, eq } from 'drizzle-orm';
import type { SQLiteTable, TableConfig } from 'drizzle-orm/sqlite-core';
import { registerHandler } from '../register';
import {
  getDatabase,
  getSqlite,
  ORKESTRAL_INSTANCE_DIR,
  ORKESTRAL_DB_DIR,
} from '../../db/connection';
import { openPathSafe } from '../../utils/safe-shell';
import {
  workspaces,
  agents,
  chatSessions,
  messages,
  issues,
  kbPages,
  kbChunks,
  kbTokenIndex,
  kbEmbeddingItems,
  kbEmbeddings,
  cleanupSuggestions,
  taskExecutions,
  issueRuns,
  traceLogs,
  agentTraceEvents,
  aiTrainingExamples,
  ragEvaluationRuns,
  multiAgentRuns,
  multiAgentSteps,
} from '../../db/schema';
import { previewDataCleanup, runDataCleanup } from '../../services/data-cleanup';

/** Caminho absoluto do arquivo SQLite principal. */
function dbFilePath(): string {
  return join(ORKESTRAL_DB_DIR, 'orkestral.db');
}

/** Conta as linhas de uma tabela via `select count(*)`. Seguro: 0 se vazio. */
function countRows(table: SQLiteTable<TableConfig>): number {
  const db = getDatabase();
  const rows = db
    .select({ value: sql<number>`count(*)` })
    .from(table)
    .all();
  return rows[0]?.value ?? 0;
}

/**
 * Conta linhas de uma tabela que tem coluna `workspace_id`, filtrando pelo
 * workspace. Se `workspaceId` for indefinido, conta global (todas as linhas).
 */
function countByWorkspace(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  workspaceId: string | undefined,
): number {
  if (!workspaceId) return countRows(table as SQLiteTable<TableConfig>);
  const db = getDatabase();
  const rows = db
    .select({ value: sql<number>`count(*)` })
    .from(table)
    .where(eq(table.workspaceId, workspaceId))
    .all();
  return rows[0]?.value ?? 0;
}

/**
 * Mensagens não têm `workspace_id` — pertencem a uma sessão. Conta as
 * mensagens cujas sessões são do workspace; global se sem `workspaceId`.
 */
function countMessagesByWorkspace(workspaceId: string | undefined): number {
  if (!workspaceId) return countRows(messages as SQLiteTable<TableConfig>);
  const db = getDatabase();
  const rows = db
    .select({ value: sql<number>`count(*)` })
    .from(messages)
    .where(
      sql`${messages.sessionId} in (select ${chatSessions.id} from ${chatSessions} where ${chatSessions.workspaceId} = ${workspaceId})`,
    )
    .all();
  return rows[0]?.value ?? 0;
}

export function registerDataHandlers(): void {
  // Estatísticas: tamanho do .db + contagem das tabelas principais.
  registerHandler('data:stats', (req) => {
    const workspaceId = req?.workspaceId;
    const path = dbFilePath();
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(path).size;
    } catch {
      dbSizeBytes = 0;
    }
    return {
      dbPath: path,
      dbSizeBytes,
      counts: {
        // Global: total de workspaces no app (não escopa por workspace).
        workspaces: countRows(workspaces as SQLiteTable<TableConfig>),
        // Escopados ao workspace ativo quando `workspaceId` é informado.
        agents: countByWorkspace(agents, workspaceId),
        sessions: countByWorkspace(chatSessions, workspaceId),
        messages: countMessagesByWorkspace(workspaceId),
        issues: countByWorkspace(issues, workspaceId),
        kbPages: countByWorkspace(kbPages, workspaceId),
        kbChunks: countByWorkspace(kbChunks, workspaceId),
        kbTokenIndex: countRows(kbTokenIndex as SQLiteTable<TableConfig>),
        kbEmbeddingItems: countRows(kbEmbeddingItems as SQLiteTable<TableConfig>),
        kbEmbeddings: countByWorkspace(kbEmbeddings, workspaceId),
        cleanupSuggestions: countRows(cleanupSuggestions as SQLiteTable<TableConfig>),
        taskExecutions: countRows(taskExecutions as SQLiteTable<TableConfig>),
        issueRuns: countRows(issueRuns as SQLiteTable<TableConfig>),
        traceLogs: countRows(traceLogs as SQLiteTable<TableConfig>),
        agentTraceEvents: countByWorkspace(agentTraceEvents, workspaceId),
        aiTrainingExamples: countRows(aiTrainingExamples as SQLiteTable<TableConfig>),
        ragEvaluationRuns: countRows(ragEvaluationRuns as SQLiteTable<TableConfig>),
        multiAgentRuns: countRows(multiAgentRuns as SQLiteTable<TableConfig>),
        multiAgentSteps: countRows(multiAgentSteps as SQLiteTable<TableConfig>),
      },
    };
  });

  // Exporta um snapshot JSON dos dados principais pra um diretório escolhido.
  registerHandler('data:export', async () => {
    if (!dialog) throw new Error('Exportação com seletor disponível apenas no app desktop.');
    const result = await dialog.showOpenDialog({
      title: 'Escolha onde salvar a exportação',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false as const, cancelled: true as const };
    }
    const db = getDatabase();
    const workspacesRows = db.select().from(workspaces).all();
    const agentsRows = db.select().from(agents).all();
    const sessionsRows = db.select().from(chatSessions).all();
    const messagesRows = db.select().from(messages).all();
    const issuesRows = db.select().from(issues).all();
    const kbPagesRows = db.select().from(kbPages).all();
    const payload = {
      exportedAt: new Date().toISOString(),
      appVersion: appInfo.version(),
      workspaces: workspacesRows,
      agents: agentsRows,
      sessions: sessionsRows,
      messages: messagesRows,
      issues: issuesRows,
      kbPages: kbPagesRows,
    };
    const counts: Record<string, number> = {
      workspaces: countRows(workspaces as SQLiteTable<TableConfig>),
      agents: countRows(agents as SQLiteTable<TableConfig>),
      sessions: countRows(chatSessions as SQLiteTable<TableConfig>),
      messages: countRows(messages as SQLiteTable<TableConfig>),
      issues: countRows(issues as SQLiteTable<TableConfig>),
      kbPages: countRows(kbPages as SQLiteTable<TableConfig>),
      kbChunks: countRows(kbChunks as SQLiteTable<TableConfig>),
      kbEmbeddings: countRows(kbEmbeddings as SQLiteTable<TableConfig>),
      agentTraceEvents: countRows(agentTraceEvents as SQLiteTable<TableConfig>),
    };
    const fileName = `orkestral-export-${new Date().toISOString().slice(0, 10)}.json`;
    const outPath = join(result.filePaths[0], fileName);
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true as const, path: outPath, counts };
  });

  // Abre a pasta de dados no gerenciador de arquivos do SO.
  registerHandler('data:reveal', async () => {
    await openPathSafe(ORKESTRAL_INSTANCE_DIR);
    return { ok: true } as const;
  });

  // Limpa cache de rede/sessão do webContents — não toca no banco. Headless
  // não tem webContents/cache de sessão — no-op ok.
  registerHandler('data:clear-cache', async () => {
    const win = BrowserWindow?.getAllWindows()[0];
    if (win) {
      await win.webContents.session.clearCache();
    }
    return { ok: true } as const;
  });

  registerHandler('data:cleanup-preview', ({ workspaceId }) => {
    return previewDataCleanup(workspaceId);
  });

  registerHandler('data:cleanup-run', ({ workspaceId, suggestionIds }) => {
    const result = runDataCleanup({ workspaceId, suggestionIds });
    try {
      getSqlite().pragma('optimize');
    } catch {
      /* best-effort */
    }
    return result;
  });

  // Apaga TODO o histórico de chat (sessões + mensagens) do workspace.
  // `messages` não tem workspaceId — vinculam à sessão; contamos via join e
  // deixamos as mensagens caírem por ON DELETE CASCADE ao deletar as sessões.
  registerHandler('data:clear-chat-history', ({ workspaceId }) => {
    const db = getDatabase();
    const sessionRows = db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.workspaceId, workspaceId))
      .all();
    const msgRows = db
      .select({ value: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(chatSessions, eq(messages.sessionId, chatSessions.id))
      .where(eq(chatSessions.workspaceId, workspaceId))
      .all();
    const deletedMessages = msgRows[0]?.value ?? 0;
    db.delete(chatSessions).where(eq(chatSessions.workspaceId, workspaceId)).run();
    return { deletedSessions: sessionRows.length, deletedMessages };
  });
}
