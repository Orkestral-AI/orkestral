import { shell } from '../../platform/electron';
import { broadcast as hostBroadcast } from '../../platform/host';
import { registerHandler } from '../register';
import {
  checkForUpdate,
  downloadUpdateInstaller,
  quitAndInstallUpdate,
} from '../../services/update-service';
import { openExternalSafe } from '../../utils/safe-shell';

export function registerUpdateHandlers(): void {
  // Boot-check: o renderer chama na inicialização (e periodicamente).
  registerHandler('update:check', () => checkForUpdate());

  // Download manual: abre o .dmg no navegador (sem auto-install — não precisa de
  // cert Apple). O usuário baixa e arrasta pra Applications.
  registerHandler('update:open', async ({ url }) => {
    const ok = typeof url === 'string' ? await openExternalSafe(url) : false;
    return { ok };
  });

  // Download DENTRO do app: baixa o instalador pro ~/Downloads com progresso
  // (evento `update:download-progress`) e abre o instalador no fim — sem navegador.
  registerHandler('update:download', async ({ url }) => {
    if (typeof url !== 'string' || !url) return { ok: false };
    const broadcast = (percent: number, done = false, failed = false): void => {
      hostBroadcast('update:download-progress', { percent, done, failed });
    };
    try {
      const file = await downloadUpdateInstaller(url, (p) => broadcast(p));
      broadcast(100, true);
      // macOS: monta o .dmg · Win: roda o instalador. Headless (sem shell) o
      // download vale sozinho — o arquivo fica no disco, sem auto-abrir.
      if (shell) await shell.openPath(file);
      return { ok: true };
    } catch (err) {
      console.warn('[update] download in-app falhou:', err instanceof Error ? err.message : err);
      broadcast(0, true, true);
      return { ok: false };
    }
  });

  // Auto-update (Win/Linux): aplica a versão já baixada e reinicia.
  registerHandler('update:quit-and-install', () => {
    quitAndInstallUpdate();
    return { ok: true as const };
  });
}
