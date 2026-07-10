/**
 * Acesso Electron-OPCIONAL — o ÚNICO lugar do main que resolve o módulo 'electron'.
 *
 * O CLI standalone roda em Node puro (`npm i -g`, sem Electron instalado), onde um
 * import/require incondicional de 'electron' crasharia no load (MODULE_NOT_FOUND).
 * E mesmo com o pacote presente (repo de dev), `require('electron')` fora do
 * runtime Electron devolve uma STRING (path do binário), não a API. Por isso só
 * resolvemos a API quando o processo É o Electron (`process.versions.electron`
 * setado); fora dele todos os exports ficam `undefined` e os call sites precisam
 * de guard (optional chaining ou throw com mensagem clara).
 *
 * GUI-only (src/main/index.ts e src/main/menu.ts) continua importando 'electron'
 * direto — esses módulos nunca são carregados pelo CLI. Imports SÓ DE TIPO
 * (`import type { ... } from 'electron'`) também podem ficar diretos: tipo é
 * apagado no build e não gera require em runtime.
 */
import { createRequire } from 'node:module';

type ElectronModule = typeof import('electron');

function resolveElectron(): ElectronModule | undefined {
  if (!process.versions.electron) return undefined;
  // O bundle do main é ESM (electron-vite + "type": "module") — não existe
  // `require` global; createRequire resolve o 'electron' built-in que o runtime
  // do Electron registra no module system.
  const req = createRequire(import.meta.url);
  return req('electron') as ElectronModule;
}

const electron = resolveElectron();

/** True quando o processo roda dentro do Electron (GUI ou `electron cli.js`). */
export const isElectronRuntime = electron !== undefined;

// Só o que src/main realmente usa fora de index.ts/menu.ts — não expandir por
// precaução: export novo aqui = call site novo que precisa de guard.
export const app = electron?.app;
export const BrowserWindow = electron?.BrowserWindow;
export const ipcMain = electron?.ipcMain;
export const safeStorage = electron?.safeStorage;
export const dialog = electron?.dialog;
export const shell = electron?.shell;
export const webContents = electron?.webContents;
export const screen = electron?.screen;
