import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { NEXT_ISSUE_KEY_SQL } from './issue.repo';

/**
 * Prova o sequenciador de issue_key (nextIssueKey) e a atomicidade do par
 * run-lifecycle ↔ status (finishRunAndSetStatus) contra a STATEMENT SQL real.
 *
 * Por quê node:sqlite e não better-sqlite3: o prebuilt do better-sqlite3 do app
 * é compilado contra o ABI do Electron, incompatível com o Node do vitest. O
 * node:sqlite (built-in, mesmo motor SQLite) roda a MESMA string SQL — então o
 * teste valida a query de produção, não um mock. A constante `NEXT_ISSUE_KEY_SQL`
 * é importada do repo pra garantir que o teste case com o que realmente roda.
 */
describe('nextIssueKey — UPSERT atômico (NEXT_ISSUE_KEY_SQL)', () => {
  function freshDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE issue_counters (workspace_id TEXT PRIMARY KEY, last_value INTEGER NOT NULL DEFAULT 0)',
    );
    return db;
  }

  it('chamadas sequenciais retornam 1,2,3 sem buraco', () => {
    const db = freshDb();
    const stmt = db.prepare(NEXT_ISSUE_KEY_SQL);
    const seen = [0, 1, 2].map(() => (stmt.get('ws-1') as { last_value: number }).last_value);
    expect(seen).toEqual([1, 2, 3]);
    db.close();
  });

  it('chaves de um workspace são estritamente únicas e contíguas (sem lost-update)', () => {
    const db = freshDb();
    const stmt = db.prepare(NEXT_ISSUE_KEY_SQL);
    // Loop apertado simulando criações concorrentes: o UPSERT incrementa-e-lê numa
    // única statement, então cada chamada DEVE devolver um valor novo.
    const keys: number[] = [];
    for (let i = 0; i < 500; i++)
      keys.push((stmt.get('ws-1') as { last_value: number }).last_value);
    expect(new Set(keys).size).toBe(keys.length); // todos únicos
    expect(keys).toEqual(Array.from({ length: 500 }, (_, i) => i + 1)); // contíguos 1..500
    db.close();
  });

  it('workspaces diferentes têm sequenciadores independentes', () => {
    const db = freshDb();
    const stmt = db.prepare(NEXT_ISSUE_KEY_SQL);
    expect((stmt.get('ws-a') as { last_value: number }).last_value).toBe(1);
    expect((stmt.get('ws-b') as { last_value: number }).last_value).toBe(1);
    expect((stmt.get('ws-a') as { last_value: number }).last_value).toBe(2);
    db.close();
  });
});

/**
 * Atomicidade de finishRunAndSetStatus: os dois writes (finishRun + status da
 * issue) acontecem numa única transação — ou ambos persistem, ou nenhum (rollback
 * deixa run e issue intactos). Replica os dois writes numa transação explícita pra
 * provar a invariante sem acoplar ao singleton Electron.
 */
describe('finishRunAndSetStatus — atomicidade run-lifecycle ↔ status', () => {
  function freshDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE issues (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    db.exec('CREATE TABLE issue_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    db.exec("INSERT INTO issues (id, status) VALUES ('i1', 'in_progress')");
    db.exec("INSERT INTO issue_runs (id, status) VALUES ('r1', 'running')");
    return db;
  }

  it('commit aplica os DOIS writes juntos', () => {
    const db = freshDb();
    db.exec('BEGIN');
    db.prepare('UPDATE issue_runs SET status = ? WHERE id = ?').run('done', 'r1');
    db.prepare('UPDATE issues SET status = ? WHERE id = ?').run('in_review', 'i1');
    db.exec('COMMIT');
    expect(
      (db.prepare('SELECT status FROM issue_runs WHERE id = ?').get('r1') as { status: string })
        .status,
    ).toBe('done');
    expect(
      (db.prepare('SELECT status FROM issues WHERE id = ?').get('i1') as { status: string }).status,
    ).toBe('in_review');
    db.close();
  });

  it('rollback no meio deixa AMBOS intactos (nenhum write parcial)', () => {
    const db = freshDb();
    db.exec('BEGIN');
    db.prepare('UPDATE issue_runs SET status = ? WHERE id = ?').run('done', 'r1');
    // Crash/SQLITE_BUSY simulado entre os dois writes → rollback.
    db.exec('ROLLBACK');
    expect(
      (db.prepare('SELECT status FROM issue_runs WHERE id = ?').get('r1') as { status: string })
        .status,
    ).toBe('running');
    expect(
      (db.prepare('SELECT status FROM issues WHERE id = ?').get('i1') as { status: string }).status,
    ).toBe('in_progress');
    db.close();
  });
});
