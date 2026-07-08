import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { runMigrations } from './migrations';

/**
 * Roda a cadeia COMPLETA de migrations (v1→atual) num SQLite real e prova o
 * contrato que o resto do app (e o benchmark/) assume do schema físico.
 *
 * Por quê node:sqlite e não better-sqlite3: o prebuilt do better-sqlite3 é
 * compilado contra o ABI do Electron, incompatível com o Node do vitest (mesmo
 * padrão do issue-key-sequencer.test.ts). O motor SQLite é o mesmo; o runner só
 * usa exec/prepare/pragma/transaction, emulados fielmente no adapter abaixo —
 * então o teste valida o DDL de produção, não um mock.
 */
function newMigrationAdapter(): { raw: DatabaseSync; db: Database.Database } {
  const raw = new DatabaseSync(':memory:');
  const adapter = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      const stmt = raw.prepare(sql);
      return {
        get: (...args: unknown[]) => stmt.get(...(args as never[])),
        all: (...args: unknown[]) => stmt.all(...(args as never[])),
        run: (...args: unknown[]) => stmt.run(...(args as never[])),
      };
    },
    pragma: (spec: string, opts?: { simple?: boolean }) => {
      if (spec.includes('=')) {
        raw.exec(`PRAGMA ${spec}`);
        return undefined;
      }
      const rows = raw.prepare(`PRAGMA ${spec}`).all() as Array<Record<string, unknown>>;
      if (opts?.simple) {
        const first = rows[0];
        return first ? Object.values(first)[0] : undefined;
      }
      return rows;
    },
    transaction: (fn: () => void) => () => {
      raw.exec('BEGIN');
      try {
        fn();
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
  // reason: adapter fino cobre exatamente a superfície que runMigrations usa;
  // tipar como better-sqlite3 completo exigiria mockar dezenas de métodos não usados.
  return { raw, db: adapter as unknown as Database.Database };
}

function columns(raw: DatabaseSync, table: string): Set<string> {
  const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe('runMigrations — cadeia completa num SQLite real', () => {
  beforeEach(() => {
    // O runner loga uma linha por migration aplicada — silencia pra não poluir o output.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aplica v1→atual do zero sem erro e é idempotente no re-run', () => {
    const { raw, db } = newMigrationAdapter();
    expect(() => runMigrations(db)).not.toThrow();
    const version = raw.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBeGreaterThanOrEqual(81);
    // Boot seguinte (mesmo user_version): não reaplica nem quebra.
    expect(() => runMigrations(db)).not.toThrow();
    raw.close();
  });

  it('v81: agent_runs ganha as colunas de custo do turno de chat', () => {
    const { raw, db } = newMigrationAdapter();
    runMigrations(db);
    const cols = columns(raw, 'agent_runs');
    for (const col of ['tokens_in', 'tokens_out', 'cost_usd']) expect(cols).toContain(col);
    raw.close();
  });

  it('v82: chat_sessions ganha o vínculo de resume do CLI e kb_analysis_jobs o custo', () => {
    const { raw, db } = newMigrationAdapter();
    runMigrations(db);
    const sessions = columns(raw, 'chat_sessions');
    for (const col of ['cli_session_id', 'cli_session_fingerprint', 'cli_last_message_id'])
      expect(sessions).toContain(col);
    const jobs = columns(raw, 'kb_analysis_jobs');
    for (const col of ['tokens_in', 'tokens_out', 'cost_usd']) expect(jobs).toContain(col);
    raw.close();
  });

  it('a query de custo do benchmark (RESULTS.template.md) roda contra o schema migrado', () => {
    const { raw, db } = newMigrationAdapter();
    runMigrations(db);
    // Mesma forma da query documentada: soma issue_runs (executores) + agent_runs
    // (orquestrador) + kb_analysis_jobs (analyzer de repo) filtrando por tempo.
    // Se uma migration renomear/remover essas colunas, este teste quebra junto
    // com a doc do benchmark.
    const row = raw
      .prepare(
        `SELECT
           (SELECT COUNT(*)                    FROM issue_runs WHERE started_at >= ?) AS executor_runs,
           (SELECT COALESCE(SUM(cost_usd),0)   FROM issue_runs WHERE started_at >= ?) AS executor_cost_usd,
           (SELECT COALESCE(SUM(tokens_in),0)  FROM issue_runs WHERE started_at >= ?) AS executor_tokens_in,
           (SELECT COALESCE(SUM(tokens_out),0) FROM issue_runs WHERE started_at >= ?) AS executor_tokens_out,
           (SELECT COUNT(*)                    FROM agent_runs WHERE started_at >= ?) AS orchestrator_turns,
           (SELECT COALESCE(SUM(cost_usd),0)   FROM agent_runs WHERE started_at >= ?) AS orchestrator_cost_usd,
           (SELECT COUNT(*)                    FROM kb_analysis_jobs WHERE created_at >= ?) AS analyzer_runs,
           (SELECT COALESCE(SUM(cost_usd),0)   FROM kb_analysis_jobs WHERE created_at >= ?) AS analyzer_cost_usd,
           (SELECT COALESCE(SUM(cost_usd),0) FROM issue_runs WHERE started_at >= ?)
             + (SELECT COALESCE(SUM(cost_usd),0) FROM agent_runs WHERE started_at >= ?)
             + (SELECT COALESCE(SUM(cost_usd),0) FROM kb_analysis_jobs WHERE created_at >= ?) AS total_cost_usd`,
      )
      .get(...Array(11).fill('2026-01-01T00:00:00Z')) as { total_cost_usd: number };
    expect(row.total_cost_usd).toBe(0);
    raw.close();
  });
});
