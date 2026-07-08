/**
 * Busca full-text nas conversas passadas (estilo Hermes session_search).
 *
 * O texto das mensagens vive em `messages.parts` (JSON), fora do alcance de
 * triggers SQL — então mantemos o índice FTS5 (`messages_fts`) em JS, com
 * REBUILD LAZY: a cada busca, se a contagem indexada do workspace diverge da
 * contagem real de mensagens, reconstruímos as linhas daquele workspace. Assim
 * não tocamos no caminho quente de persistência e o índice nunca fica velho.
 *
 * Dá ao agente memória entre sessões: "o que já conversamos sobre X".
 */
import { getSqlite } from '../db/connection';
import type { MessagePart } from '../../shared/types';

export interface SessionSearchHit {
  sessionId: string;
  title: string;
  role: string;
  createdAt: string;
  snippet: string;
}

/** Extrai o texto puro (partes 'text') de uma mensagem serializada. */
function extractText(partsJson: string): string {
  try {
    const parts = JSON.parse(partsJson) as MessagePart[];
    return parts
      .filter(
        (p): p is { type: 'text'; text: string } =>
          p.type === 'text' && typeof (p as { text?: unknown }).text === 'string',
      )
      .map((p) => p.text)
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}

function indexedCount(workspaceId: string): number {
  const row = getSqlite()
    .prepare('SELECT count(*) AS c FROM messages_fts WHERE workspace_id = ?')
    .get(workspaceId) as { c: number } | undefined;
  return row?.c ?? 0;
}

function sourceCount(workspaceId: string): number {
  const row = getSqlite()
    .prepare(
      `SELECT count(*) AS c FROM messages m
       JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.workspace_id = ? AND m.role IN ('user','assistant') AND m.status = 'done'`,
    )
    .get(workspaceId) as { c: number } | undefined;
  return row?.c ?? 0;
}

/** Reconstrói as linhas FTS de UM workspace a partir das mensagens reais. */
function rebuildWorkspace(workspaceId: string): void {
  const db = getSqlite();
  const rows = db
    .prepare(
      `SELECT m.id AS mid, m.session_id AS sid, m.role AS role, m.parts AS parts,
              m.created_at AS created_at, s.title AS title
       FROM messages m JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.workspace_id = ? AND m.role IN ('user','assistant') AND m.status = 'done'`,
    )
    .all(workspaceId) as Array<{
    mid: string;
    sid: string;
    role: string;
    parts: string;
    created_at: string;
    title: string | null;
  }>;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM messages_fts WHERE workspace_id = ?').run(workspaceId);
    const ins = db.prepare(
      `INSERT INTO messages_fts(message_id, session_id, workspace_id, role, created_at, title, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // Insere TODAS as mensagens contadas por sourceCount (mesmo sem texto), senão
    // indexedCount nunca bate com sourceCount e o rebuild dispara a cada busca.
    for (const r of rows) {
      ins.run(r.mid, r.sid, workspaceId, r.role, r.created_at, r.title ?? '', extractText(r.parts));
    }
  });
  tx();
}

/**
 * Busca nas conversas passadas do workspace. Reconstrói o índice se defasado e
 * retorna os trechos mais relevantes (rank BM25 do FTS5) com snippet destacado.
 */
export function searchSessions(workspaceId: string, query: string, limit = 6): SessionSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const db = getSqlite();
  // Rebuild lazy: índice defasado (mensagens novas/removidas) → reconstrói o ws.
  if (indexedCount(workspaceId) !== sourceCount(workspaceId)) rebuildWorkspace(workspaceId);

  // Cada token vira uma frase literal (sem metacaracteres FTS) unida por OR =
  // recall amplo; o `rank` reordena por relevância. Evita erro de sintaxe FTS.
  const ftsQuery = q
    .replace(/"/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .map((t) => `"${t}"`)
    .join(' OR ');
  if (!ftsQuery) return [];

  const cap = Math.min(Math.max(1, limit), 20);
  try {
    const rows = db
      .prepare(
        `SELECT session_id, title, role, created_at,
                snippet(messages_fts, 6, '[', ']', '…', 14) AS snip
         FROM messages_fts
         WHERE workspace_id = ? AND messages_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(workspaceId, ftsQuery, cap) as Array<{
      session_id: string;
      title: string | null;
      role: string;
      created_at: string;
      snip: string;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      title: r.title ?? '(sem título)',
      role: r.role,
      createdAt: r.created_at,
      snippet: r.snip,
    }));
  } catch (err) {
    console.warn('[session-search] falha na busca FTS:', err);
    return [];
  }
}
