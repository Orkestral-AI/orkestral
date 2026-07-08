/**
 * Motor v2: sobe o dev server pro preview (secao 6 do plano).
 *
 * Depois do esqueleto-que-anda, liga o dev server em background a partir do PreviewPlan,
 * pra o usuario "Abrir preview" e ver a tela. Best-effort: null se nao da pra rodar; nunca
 * quebra o run. O processo roda detached; o caller guarda o handle pra parar depois.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PreviewPlan } from './preview-policy';

export interface PreviewHandle {
  pid: number | undefined;
  url: string | null;
  stop: () => void;
  /** true quando o processo do dev server morreu (crash, script inválido, dep faltando). */
  exited: boolean;
  /** Registra callback disparado UMA vez quando o processo morre. */
  onExit: (listener: () => void) => void;
}

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** Acha o arquivo de compose do projeto (se houver). */
function composeFileOf(projectRoot: string): string | null {
  for (const f of COMPOSE_FILES) {
    if (fs.existsSync(path.join(projectRoot, f))) return f;
  }
  return null;
}

/**
 * Sobe os servicos do docker-compose ANTES do dev server. Sem o DB/Redis no ar o app
 * conecta num banco inexistente e o preview fica em branco/erro. Best-effort e NAO
 * bloqueante: roda `docker compose up -d` detached (o Next leva ~10-30s compilando,
 * tempo de o banco subir). Se o Docker nao estiver instalado/rodando, nao quebra.
 */
function ensureComposeUp(projectRoot: string): void {
  if (!composeFileOf(projectRoot)) return;
  try {
    const up = spawn('docker', ['compose', 'up', '-d'], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
    });
    up.on('error', () => {
      /* docker ausente/parado: best-effort, o app sobe mesmo assim */
    });
    up.unref();
  } catch {
    /* best-effort */
  }
}

/** Sobe o dev server em background. Retorna o handle ou null (nao rodavel / falhou). */
export function launchPreview(projectRoot: string, preview: PreviewPlan): PreviewHandle | null {
  if (!preview.runnable || !preview.startCommand) return null;
  const parts = preview.startCommand.split(' ').filter(Boolean);
  if (parts.length === 0) return null;
  // Se o app tem docker-compose (DB/queue), sobe os servicos primeiro pra o preview
  // ser FUNCIONAL e nao uma pagina em branco de banco faltando.
  ensureComposeUp(projectRoot);
  // A porta vem da url do plano (http://localhost:PORT). Passa via PORT env pro dev server subir
  // na porta certa — sem isso 2 workspaces colidem no 3000 e o segundo falha calado.
  const portMatch = preview.url?.match(/:(\d+)/);
  const env = portMatch ? { ...process.env, PORT: portMatch[1] } : process.env;
  try {
    const child = spawn(parts[0], parts.slice(1), {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    const exitListeners: Array<() => void> = [];
    const handle: PreviewHandle = {
      pid: child.pid,
      url: preview.url,
      exited: false,
      onExit: (listener) => exitListeners.push(listener),
      stop: () => {
        try {
          if (child.pid) process.kill(-child.pid);
        } catch {
          /* ja morreu */
        }
      },
    };
    // 'exit' (processo morreu) e 'error' (spawn falhou, ex: npm ausente): sem isto o
    // caller acha que o dev server esta vivo pra sempre e o preview mente "rodando".
    const markExited = (): void => {
      if (handle.exited) return;
      handle.exited = true;
      for (const listener of exitListeners) listener();
    };
    child.on('exit', markExited);
    child.on('error', markExited);
    return handle;
  } catch {
    return null;
  }
}
