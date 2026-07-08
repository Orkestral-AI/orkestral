/**
 * Motor v2: commit por fatia (secao 4.6 do plano).
 *
 * Cada fatia (issue) que fecha vira um commit, pra dar pontos de rollback e um historico
 * legivel. Best-effort: so commita se for repo git e se houver mudanca; nunca quebra o run.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function isGitRepo(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, '.git'));
}

/**
 * Garante um repo git no diretório (greenfield começa vazio/sem git). Sem isso, o
 * commit-por-fatia não funciona e o usuário fica sem histórico do que foi construído.
 */
export function ensureGitRepo(projectRoot: string): void {
  if (isGitRepo(projectRoot)) return;
  try {
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    // identidade local mínima pra permitir commits mesmo sem config global do usuário.
    execFileSync('git', ['config', 'user.email', 'engine-v2@orkestral.local'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Orkestral'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
  } catch {
    // sem git disponível: segue sem commit-por-fatia, não quebra o build.
  }
}

/** Commita o estado atual da fatia. Retorna true se commitou, false se nao deu (sem quebrar). */
export function commitSlice(projectRoot: string, message: string): boolean {
  if (!isGitRepo(projectRoot)) return false;
  try {
    execFileSync('git', ['add', '-A'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', message, '--no-verify'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    // nada pra commitar, ou git indisponivel: nao quebra o run.
    return false;
  }
}
