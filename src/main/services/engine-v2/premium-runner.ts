/**
 * Motor v2: o premiumChat real, AGNOSTICO de provider.
 *
 * Premium = qualquer adapter que NAO seja o Forge. Roda o CLI do provider configurado
 * (claude/codex/cursor) em modo stateless one-shot (sem tools, sem streaming), do mesmo
 * jeito que o app ja invoca os adapters (prompt inteiro via stdin). Devolve texto + tokens
 * do JSON do proprio adapter (fonte agnostica de tokens).
 *
 * SO roda dentro do app (precisa do CLI do provider instalado + logado). O primeiro run
 * vivo E o teste: pode quebrar e a gente itera.
 */
import { spawn } from 'node:child_process';

import type { PremiumChatFn } from './conduct-adapter';

/** O adapter do Forge local. Premium e tudo que NAO for isso. */
export const FORGE_ADAPTER = 'orkestral_local';

export function isPremiumAdapter(adapterType: string): boolean {
  return adapterType !== FORGE_ADAPTER;
}

interface Cmd {
  command: string;
  args: string[];
}

// Ferramentas do harness desligadas: o premium do engine-v2 so gera TEXTO, nao usa tool.
// Cortar tools + contexto dinamico + MCP reduz o overhead fixo por chamada (~12k -> ~7k tokens).
const CLAUDE_DISALLOWED_TOOLS =
  'Bash,Read,Write,Edit,MultiEdit,Glob,Grep,Task,WebFetch,WebSearch,TodoWrite,NotebookEdit,BashOutput,KillBash';

interface PremiumCmd extends Cmd {
  /** O que vai pro stdin (claude usa --system-prompt, entao stdin = so o user). */
  stdin: string;
}

/** Comando one-shot por provider (JSON batch, sem MCP/tools, contexto enxuto). */
function buildPremiumCommand(
  adapterType: string,
  model: string | null | undefined,
  system: string,
  user: string,
): PremiumCmd {
  const m = model && model !== 'default' ? model : null;
  const combined = `${system}\n\n---\n\n${user}`;
  switch (adapterType) {
    case 'claude_local': {
      // --system-prompt SUBSTITUI o system default (harness do Claude Code), nao anexa.
      const args = [
        '--print',
        '--output-format',
        'json',
        '--system-prompt',
        system,
        '--strict-mcp-config',
        '--exclude-dynamic-system-prompt-sections',
        '--disallowedTools',
        CLAUDE_DISALLOWED_TOOLS,
      ];
      if (m) args.push('--model', m);
      return { command: 'claude', args, stdin: user };
    }
    case 'codex_local': {
      const args = ['exec', '--json', '--skip-git-repo-check'];
      if (m) args.push('--model', m);
      args.push('-');
      return { command: 'codex', args, stdin: combined };
    }
    case 'cursor_local': {
      const args = ['-p', '--output-format', 'json'];
      if (m) args.push('--model', m);
      return { command: 'cursor-agent', args, stdin: combined };
    }
    default:
      throw new Error(
        `engine-v2: provider premium "${adapterType}" ainda nao tem completion stateless. Use claude/codex/cursor.`,
      );
  }
}

interface ParsedCompletion {
  text: string;
  premiumIn: number;
  premiumOut: number;
}

/**
 * Parser TOLERANTE da saida do CLI. Aceita um objeto JSON unico (`--output-format json`) ou
 * JSONL (uma linha por evento). Coleta o texto do evento `result`/mensagem e os tokens de
 * `usage`. Toler ruido (banner/warning do CLI) sem quebrar.
 */
export function parsePremiumCompletion(stdout: string): ParsedCompletion {
  const objs: Record<string, unknown>[] = [];
  const trimmed = stdout.trim();
  // 1) tenta objeto unico.
  try {
    const one = JSON.parse(trimmed);
    if (one && typeof one === 'object') objs.push(one as Record<string, unknown>);
  } catch {
    // 2) JSONL: cada linha um JSON; ignora linhas nao-JSON (banner do CLI).
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        objs.push(JSON.parse(l) as Record<string, unknown>);
      } catch {
        /* linha nao-JSON do stdout: ignora */
      }
    }
  }

  let text = '';
  let premiumIn = 0;
  let premiumOut = 0;
  for (const o of objs) {
    // texto: campo `result` (claude json) ou content de mensagem assistant.
    if (typeof o.result === 'string' && o.result) text = o.result;
    const msg = o.message as { content?: unknown } | undefined;
    if (!text && msg && Array.isArray(msg.content)) {
      const t = msg.content
        .filter((b): b is { type: string; text: string } => {
          const bb = b as { type?: string; text?: string };
          return bb.type === 'text' && typeof bb.text === 'string';
        })
        .map((b) => b.text)
        .join('');
      if (t) text = t;
    }
    // tokens: `usage.input_tokens/output_tokens` (claude/anthropic-style).
    const usage = o.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (usage) {
      premiumIn += usage.input_tokens ?? 0;
      premiumOut += usage.output_tokens ?? 0;
    }
  }
  return { text, premiumIn, premiumOut };
}

export interface PremiumRunnerOptions {
  adapterType: string;
  model?: string | null;
  cwd?: string;
  timeoutMs?: number;
}

/** Cria o PremiumChatFn rodando o CLI do provider configurado. */
export function createAdapterPremiumChat(opts: PremiumRunnerOptions): PremiumChatFn {
  if (!isPremiumAdapter(opts.adapterType)) {
    throw new Error(
      'engine-v2: o premium nao pode ser o Forge. Configure um provider (claude/codex/cursor).',
    );
  }
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return (system, user) =>
    new Promise((resolve, reject) => {
      const {
        command,
        args,
        stdin: prompt,
      } = buildPremiumCommand(opts.adapterType, opts.model, system, user);
      const child = spawn(command, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(`engine-v2: premium "${command}" estourou ${Math.round(timeoutMs / 1000)}s`),
        );
      }, timeoutMs);
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(
          new Error(`engine-v2: falha ao rodar "${command}" (instalado? logado?): ${e.message}`),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) {
          reject(
            new Error(`engine-v2: premium "${command}" saiu ${code}: ${stderr.slice(0, 300)}`),
          );
          return;
        }
        const parsed = parsePremiumCompletion(stdout);
        if (!parsed.text) {
          reject(
            new Error(
              `engine-v2: premium "${command}" nao devolveu texto. stderr: ${stderr.slice(0, 200)}`,
            ),
          );
          return;
        }
        resolve(parsed);
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
}
