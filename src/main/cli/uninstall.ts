/**
 * `orkestral uninstall` — remove a instalação por completo, no modelo do
 * OpenClaw: para e remove o serviço em segundo plano, apaga TODO o estado
 * (~/.orkestral: banco, tokens, workspaces, logs, modelos baixados) e explica
 * como remover o pacote npm global (um processo não se auto-desinstala do npm
 * de forma limpa enquanto está rodando).
 *
 * Destrutivo e IRREVERSÍVEL — o chamador (cli.ts) confirma com o usuário antes.
 */
import { rmSync, existsSync } from 'node:fs';
import { ORKESTRAL_HOME } from '../db/connection';
import { uninstallDaemon } from './daemon';

export interface UninstallOptions {
  /** Mantém o estado em ~/.orkestral (só remove o serviço). */
  keepData: boolean;
}

export interface UninstallStep {
  label: string;
  status: 'done' | 'skipped' | 'error';
  detail: string;
}

export interface UninstallResult {
  steps: UninstallStep[];
  /** Comando que o usuário ainda precisa rodar (npm não se auto-remove). */
  finalHint: string;
}

export function runUninstall(opts: UninstallOptions): UninstallResult {
  const steps: UninstallStep[] = [];

  // 1. Serviço em segundo plano PRIMEIRO — parar antes de apagar os arquivos que
  //    ele usa (senão o daemon reescreveria o db/token durante a remoção).
  const daemon = uninstallDaemon();
  steps.push({
    label: 'Serviço em segundo plano',
    status: daemon.ok ? 'done' : 'error',
    detail: daemon.message,
  });

  // 2. Estado (~/.orkestral): banco, gateway-token, secret.key, workspaces, logs,
  //    modelos. É aqui que vivem TODOS os dados no modo Node puro (VPS/npm -g).
  if (opts.keepData) {
    steps.push({
      label: 'Dados (~/.orkestral)',
      status: 'skipped',
      detail: `mantidos em ${ORKESTRAL_HOME} (--keep-data)`,
    });
  } else if (!existsSync(ORKESTRAL_HOME)) {
    steps.push({
      label: 'Dados (~/.orkestral)',
      status: 'skipped',
      detail: 'nada a remover (diretório ausente)',
    });
  } else {
    try {
      rmSync(ORKESTRAL_HOME, { recursive: true, force: true });
      steps.push({
        label: 'Dados (~/.orkestral)',
        status: 'done',
        detail: `removido ${ORKESTRAL_HOME}`,
      });
    } catch (err) {
      steps.push({
        label: 'Dados (~/.orkestral)',
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    steps,
    finalHint: 'npm uninstall -g orkestral',
  };
}
