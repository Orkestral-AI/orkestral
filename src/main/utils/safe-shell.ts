import { shell } from '../platform/electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Choke point ÚNICO pra todo `shell.openExternal` / `shell.openPath` do main.
 *
 * Centraliza a política de schemes/paths num lugar só, fechando o vetor clássico
 * de escalonamento do Electron (setWindowOpenHandler abrindo `file://`/scheme
 * custom controlado pela página) e a traversal de path em handlers que recebem
 * `relPath`/`path` cru do renderer. URLs https internas (menu, cloud-auth,
 * github, azure) passam sem mudança de comportamento — só ganham defesa extra.
 */

/**
 * Schemes permitidos no `openExternalSafe`. Inclui os deep-links de ajustes do
 * SO já usados em app.ts (data/hora). Tudo fora disso (file:, javascript:,
 * data:, schemes custom inesperados) é bloqueado.
 */
export const ALLOWED_EXTERNAL_SCHEMES = new Set([
  'https:',
  'mailto:',
  'x-apple.systempreferences:',
  'ms-settings:',
  'settings:',
]);

/** Hosts de loopback pros quais `http:` é aceito (login em dev / self-hosted
 *  local). http pra qualquer outro host segue bloqueado — sem texto-claro na rede. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Abre uma URL externa só se o scheme estiver na allow-list. Retorna `false` se bloqueada/inválida.
 *  Em Node puro (CLI standalone, sem Electron) não há shell — retorna `false` como "bloqueada". */
export async function openExternalSafe(rawUrl: string): Promise<boolean> {
  if (!shell) {
    console.warn('[safe-shell] shell indisponível fora do app desktop — openExternal ignorado');
    return false;
  }
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'http:') {
    // http só pra loopback (callback de login em dev / Cloud self-hosted local).
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      console.warn('[safe-shell] blocked non-loopback http', url.hostname);
      return false;
    }
  } else if (!ALLOWED_EXTERNAL_SCHEMES.has(url.protocol)) {
    console.warn('[safe-shell] blocked external scheme', url.protocol);
    return false;
  }
  await shell.openExternal(rawUrl);
  return true;
}

/**
 * Abre um path no app padrão do SO. Por default exige que o path exista; com
 * `withinRoot` confina o alvo resolvido à árvore do root (guarda anti-traversal).
 * Retorna `false` quando bloqueado/inexistente.
 */
export async function openPathSafe(
  absPath: string,
  opts?: { mustExist?: boolean; withinRoot?: string },
): Promise<boolean> {
  if (!shell) {
    console.warn('[safe-shell] shell indisponível fora do app desktop — openPath ignorado');
    return false;
  }
  if (!absPath || typeof absPath !== 'string') return false;
  const resolved = path.resolve(absPath);
  if (opts?.withinRoot) {
    const root = path.resolve(opts.withinRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      console.warn('[safe-shell] blocked path outside root', resolved);
      return false;
    }
  }
  if ((opts?.mustExist ?? true) && !existsSync(resolved)) return false;
  await shell.openPath(resolved);
  return true;
}
