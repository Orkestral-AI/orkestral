import { app } from '../../platform/electron';
import { registerHandler } from '../register';
import { SettingsRepository } from '../../db/repositories/settings.repo';
import type { SettingsRecord } from '@shared/types';

/**
 * Aplica efeitos a nível de SO de uma config (best-effort).
 * Hoje: "abrir ao ligar" via app.setLoginItemSettings (macOS/Windows).
 * Em ambientes onde a API não existe (alguns Linux/dev) simplesmente ignora —
 * o valor continua persistido e tem efeito quando o app rodar empacotado.
 */
function applyLoginItem(record: SettingsRecord): void {
  // Só tem efeito (e permissão) no app EMPACOTADO. Em dev/unsigned o macOS nega com
  // "Operation not permitted" e o Electron loga no NATIVO (fora do try/catch JS),
  // poluindo o console. Então nem tentamos: o valor fica persistido e aplica quando
  // o app rodar empacotado. Em Node puro (sem Electron) idem: só persiste.
  if (!app?.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: record.system.launchOnStartup });
  } catch {
    // ignore — best-effort
  }
}

export function registerSettingsHandlers(): void {
  const repo = new SettingsRepository();

  // Leitura é PURA: não aplica efeito de SO (antes re-setava o login item a cada
  // get, disparando o erro nativo repetidamente). O efeito vai só no update abaixo.
  registerHandler('settings:get', () => repo.get());
  registerHandler('settings:update', (req) => {
    const record = repo.update(req);
    if (req && req.system && 'launchOnStartup' in req.system) {
      applyLoginItem(record);
    }
    return record;
  });
}
