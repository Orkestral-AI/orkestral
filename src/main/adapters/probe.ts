import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { AdapterTestResult } from '@shared/types';
import { scrubSpawnEnv } from '../services/spawn-policy';

/**
 * Utilitários compartilhados pelas implementações de adapter pra rodar
 * probes contra CLIs locais.
 */

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Roda um comando com timeout. Retorna stdout, stderr e código.
 * Nunca rejeita — sempre retorna RunResult.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, {
        // Scrub de secrets não-relacionados (mantém a auth do agente: ANTHROPIC/OPENAI/
        // CLAUDE_*/CODEX_* via SCRUB_KEEP) — o probe roda o CLI com flags elevadas
        // (--yolo/--skip-permissions), então não vaza GITHUB_TOKEN nem *_SECRET do shell.
        env: scrubSpawnEnv(process.env),
        // shell: false — chamamos o binário direto pra evitar injeção
        shell: false,
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        durationMs: Date.now() - started,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child!.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr || err.message,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });

    // Sempre fecha o stdin do child. Sem isso, CLIs como o `claude` ficam
    // aguardando input via stdin e emitem "no stdin data received in 3s".
    if (child.stdin) {
      if (opts.input != null) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    }
  });
}

/**
 * Verifica se um binário está no PATH usando which/where conforme plataforma.
 */
export async function which(bin: string): Promise<string | null> {
  const isWin = platform() === 'win32';
  const cmd = isWin ? 'where' : 'which';
  const r = await run(cmd, [bin], { timeoutMs: 3_000 });
  if (!r.ok || !r.stdout.trim()) return null;
  return r.stdout.split(/\r?\n/)[0].trim();
}

/**
 * Helper pra montar um AdapterTestResult agregando checks individuais.
 * Status final é o pior dos checks: se algum 'fail' → fail; se algum 'warn' → warn; senão 'pass'.
 */
export function aggregateResult(
  checks: AdapterTestResult['checks'],
  startedAt: number,
  fallbackMessage = 'OK',
): AdapterTestResult {
  let status: AdapterTestResult['status'] = 'pass';
  for (const c of checks) {
    if (c.status === 'fail') status = 'fail';
    else if (c.status === 'warn' && status === 'pass') status = 'warn';
  }
  const failMsg = checks.find((c) => c.status === 'fail')?.detail;
  const warnMsg = checks.find((c) => c.status === 'warn')?.detail;
  const message =
    status === 'fail'
      ? (failMsg ?? 'Falha na verificação do adapter.')
      : status === 'warn'
        ? (warnMsg ?? 'Adapter funcional com observações.')
        : fallbackMessage;

  return {
    status,
    message,
    checks,
    durationMs: Date.now() - startedAt,
  };
}
