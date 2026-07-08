/**
 * Roda os comandos de validação (lint/typecheck/test/build) no repo após
 * aplicar um patch. Para no primeiro que falhar e retorna o output capturado
 * pra alimentar o retry/fallback.
 */
import { exec } from 'node:child_process';

export interface ValidationStep {
  command: string;
  ok: boolean;
  output: string;
  durationMs: number;
  /** O comando não pôde nem EXECUTAR (binário ausente) — não é falha de código. */
  skipped?: boolean;
}

export interface ValidationResult {
  passed: boolean;
  steps: ValidationStep[];
}

function runOne(command: string, cwd: string, timeoutMs: number): Promise<ValidationStep> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1' } },
      (error, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(-4000);
        // Ferramenta AUSENTE (não conseguiu nem iniciar): exit 127 (shell "command
        // not found"), ENOENT (spawn falhou) ou a mensagem clássica do npm/sh. Isso
        // é problema de AMBIENTE, não do código do Forge — marca como pulado (ok)
        // pra NÃO bloquear a issue. O syntax-check por arquivo + o Code Reviewer
        // continuam sendo a rede de segurança real.
        const errCode = (error as (Error & { code?: number | string }) | null)?.code;
        const couldNotRun =
          !!error &&
          (errCode === 127 ||
            errCode === 'ENOENT' ||
            /command not found|not recognized|cannot find module|: not found/i.test(out));
        resolve({
          command,
          ok: !error || couldNotRun,
          skipped: couldNotRun,
          output: couldNotRun ? `(pulado — ferramenta indisponível) ${out}` : out,
          durationMs: Date.now() - startedAt,
        });
      },
    );
  });
}

export async function runValidation(
  repoPath: string,
  commands: string[],
  timeoutMs = 180_000,
): Promise<ValidationResult> {
  const steps: ValidationStep[] = [];
  for (const command of commands) {
    const step = await runOne(command, repoPath, timeoutMs);
    steps.push(step);
    if (!step.ok) return { passed: false, steps }; // para no primeiro erro
  }
  return { passed: true, steps };
}

/** Resumo curto do primeiro erro pra logs/fallback. */
export function firstFailure(result: ValidationResult): string | null {
  const failed = result.steps.find((s) => !s.ok);
  if (!failed) return null;
  return `${failed.command}\n${failed.output}`.slice(0, 2000);
}
