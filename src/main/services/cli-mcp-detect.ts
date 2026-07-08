/**
 * Detecta MCP servers já configurados nos CLIs do usuário, lendo os arquivos de
 * config conhecidos. Tudo read-only — só listamos pra que o usuário possa
 * importar pro Orkestral (e gerenciar por modelo).
 *
 *  - Claude Code → ~/.claude.json (mcpServers global + por projeto)
 *  - Codex       → ~/.codex/config.toml ([mcp_servers.<name>])
 *  - Gemini      → ~/.gemini/settings.json (mcpServers)
 *  - Cursor      → ~/.cursor/mcp.json (mcpServers)
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { DetectedCliMcp, CliSource, McpTransport } from '../../shared/types';

function readJson(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Normaliza uma entrada `mcpServers[name]` (shape JSON dos CLIs) → DetectedCliMcp. */
function fromJsonEntry(
  source: CliSource,
  name: string,
  entry: any,
  scope: string | undefined,
): DetectedCliMcp | null {
  if (!entry || typeof entry !== 'object') return null;
  const env = entry.env && typeof entry.env === 'object' ? entry.env : undefined;
  const headers = entry.headers && typeof entry.headers === 'object' ? entry.headers : undefined;
  if (typeof entry.url === 'string' && entry.url.trim()) {
    const transport: McpTransport = entry.type === 'sse' ? 'sse' : 'http';
    return { source, name, transport, url: entry.url, headers, scope };
  }
  if (typeof entry.command === 'string' && entry.command.trim()) {
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a: unknown) => typeof a === 'string')
      : [];
    return { source, name, transport: 'stdio', command: entry.command, args, env, scope };
  }
  return null;
}

function fromMcpServersMap(
  source: CliSource,
  map: unknown,
  scope: string | undefined,
): DetectedCliMcp[] {
  if (!map || typeof map !== 'object') return [];
  const out: DetectedCliMcp[] = [];
  for (const [name, entry] of Object.entries(map as Record<string, unknown>)) {
    const d = fromJsonEntry(source, name, entry, scope);
    if (d) out.push(d);
  }
  return out;
}

function detectClaude(): DetectedCliMcp[] {
  const data = readJson(join(homedir(), '.claude.json'));
  if (!data) return [];
  const out = fromMcpServersMap('claude', data.mcpServers, 'global');
  // mcpServers por projeto
  if (data.projects && typeof data.projects === 'object') {
    for (const [path, proj] of Object.entries(data.projects as Record<string, any>)) {
      out.push(...fromMcpServersMap('claude', proj?.mcpServers, basename(path)));
    }
  }
  return out;
}

function detectGemini(): DetectedCliMcp[] {
  const data = readJson(join(homedir(), '.gemini', 'settings.json'));
  return data ? fromMcpServersMap('gemini', data.mcpServers, 'global') : [];
}

function detectCursor(): DetectedCliMcp[] {
  const data = readJson(join(homedir(), '.cursor', 'mcp.json'));
  return data ? fromMcpServersMap('cursor', data.mcpServers, 'global') : [];
}

/** Remove aspas de uma string TOML, ou tenta JSON.parse (arrays/strings). */
function tomlValue(raw: string): unknown {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Parser mínimo do config.toml do Codex, só pras seções `[mcp_servers.*]`.
 * Suficiente pra command/args/url/env — não é um parser TOML completo.
 */
function detectCodex(): DetectedCliMcp[] {
  const path = join(homedir(), '.codex', 'config.toml');
  let text: string;
  try {
    if (!existsSync(path)) return [];
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const servers = new Map<string, DetectedCliMcp>();
  let current: string | null = null;
  let inEnv = false;

  const ensure = (name: string): DetectedCliMcp => {
    let s = servers.get(name);
    if (!s) {
      s = { source: 'codex', name, transport: 'stdio', scope: 'global' };
      servers.set(name, s);
    }
    return s;
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const section = trimmed.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (section) {
      const path2 = section[1];
      if (path2.endsWith('.env')) {
        current = path2.slice(0, -'.env'.length);
        inEnv = true;
        ensure(current);
      } else {
        current = path2;
        inEnv = false;
        ensure(current);
      }
      continue;
    }
    // Outra seção qualquer encerra o contexto de mcp_servers.
    if (trimmed.startsWith('[')) {
      current = null;
      inEnv = false;
      continue;
    }
    if (!current) continue;

    const kv = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = tomlValue(kv[2]);
    const s = ensure(current);

    if (inEnv) {
      s.env = { ...(s.env ?? {}), [key]: String(value) };
      continue;
    }
    if (key === 'command' && typeof value === 'string') s.command = value;
    else if (key === 'args' && Array.isArray(value)) s.args = value.map(String);
    else if (key === 'url' && typeof value === 'string') {
      s.url = value;
      s.transport = 'http';
    }
  }

  return Array.from(servers.values()).filter((s) => s.command || s.url);
}

/** Lista todos os MCPs detectados nos CLIs instalados. */
export function detectCliMcps(): DetectedCliMcp[] {
  return [...detectClaude(), ...detectCodex(), ...detectGemini(), ...detectCursor()];
}
