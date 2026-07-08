import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { runMigrations } from './migrations';

let _sqlite: Database.Database | null = null;
let _db: BetterSQLite3Database<typeof schema> | null = null;

/**
 * Estrutura de pastas em ~/.orkestral (inspirada no .paperclip):
 *   ~/.orkestral/
 *     instances/default/db/orkestral.db   — SQLite principal
 *     instances/default/logs/             — Logs (futuro)
 *     workspaces/<companyId>/             — Workspace por company (futuro)
 *     config.json                          — Config global (futuro)
 */
export const ORKESTRAL_HOME = join(homedir(), '.orkestral');
export const ORKESTRAL_INSTANCE_DIR = join(ORKESTRAL_HOME, 'instances', 'default');
export const ORKESTRAL_DB_DIR = join(ORKESTRAL_INSTANCE_DIR, 'db');
export const ORKESTRAL_WORKSPACES_DIR = join(ORKESTRAL_HOME, 'workspaces');
/** Anexos de comentários/decisões — arquivos copiados pra cá no upload. */
export const ORKESTRAL_ATTACHMENTS_DIR = join(ORKESTRAL_INSTANCE_DIR, 'attachments');

/** Raiz dos runtimes/modelos de voz, baixados sob demanda (Voice Pack). */
export const ORKESTRAL_VOICE_DIR = join(ORKESTRAL_INSTANCE_DIR, 'voice');

/**
 * Resolve um caminho relativo dentro de ~/.orkestral/.../voice, criando a
 * pasta-pai se preciso. Ex: voicePath('models/stt/ggml.bin').
 */
export function voicePath(relative: string): string {
  const full = resolve(ORKESTRAL_VOICE_DIR, relative);
  // Containment: nunca deixar `relative` (ex: '../..') escapar a pasta de voz.
  if (full !== ORKESTRAL_VOICE_DIR && !full.startsWith(ORKESTRAL_VOICE_DIR + sep)) {
    throw new Error(`voicePath fora do diretório de voz: ${relative}`);
  }
  ensureDir(join(full, '..'));
  return full;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function resolveDbPath(): string {
  ensureDir(ORKESTRAL_DB_DIR);
  ensureDir(ORKESTRAL_WORKSPACES_DIR);
  return join(ORKESTRAL_DB_DIR, 'orkestral.db');
}

/**
 * Retorna o diretório workspace para a company indicada,
 * criando se não existir. Use pra guardar anexos/artefatos por workspace.
 */
export function resolveWorkspaceDir(companyId: string): string {
  const dir = join(ORKESTRAL_WORKSPACES_DIR, companyId);
  ensureDir(dir);
  return dir;
}

export function initDatabase(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;

  const dbPath = resolveDbPath();
  console.log(`[db] abrindo SQLite em ${dbPath}`);

  _sqlite = new Database(dbPath);
  // App + core standalone compartilham este arquivo (WAL). Sem busy_timeout, um
  // escritor concorrente lança SQLITE_BUSY na hora; com ele, espera o lock.
  _sqlite.pragma('busy_timeout = 5000');
  // WAL + synchronous=NORMAL: durável contra crash de processo (só perde em crash
  // de SO/energia), evita fsync por commit — alivia SQLITE_BUSY entre app e core MCP.
  _sqlite.pragma('synchronous = NORMAL');
  runMigrations(_sqlite);

  _db = drizzle(_sqlite, { schema });
  return _db;
}

export function getDatabase(): BetterSQLite3Database<typeof schema> {
  if (!_db) throw new Error('Database não inicializado. Chame initDatabase() no boot do main.');
  return _db;
}

/** O DB está aberto? false após closeDatabase() (app encerrando) — trabalho assíncrono
 *  de background (ex.: análise de KB longa) usa isto pra abortar quieto em vez de
 *  estourar "Database não inicializado" ao escrever durante o shutdown. */
export function isDatabaseOpen(): boolean {
  return _db !== null;
}

/** Handle cru do better-sqlite3 — pra SQL que o Drizzle não modela (ex.: FTS5). */
export function getSqlite(): Database.Database {
  if (!_sqlite) throw new Error('Database não inicializado. Chame initDatabase() no boot do main.');
  return _sqlite;
}

export function closeDatabase(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}
