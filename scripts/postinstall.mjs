#!/usr/bin/env node
/**
 * postinstall — rebuilda os addons nativos pro ABI do Electron SÓ no checkout de
 * desenvolvimento (onde electron-builder existe como devDependency).
 *
 * Numa instalação de usuário (`npm i -g orkestral` ou `npm install --omit=dev`)
 * não há devDependencies: os nativos (better-sqlite3, node-pty…) ficam no ABI do
 * Node — exatamente o que o CLI standalone precisa (bin/orkestral roda em Node
 * puro quando o Electron está ausente). Sem este guard, o postinstall antigo
 * (`electron-builder install-app-deps`) quebrava o install global.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

let hasElectronBuilder = true;
try {
  require.resolve('electron-builder/package.json');
} catch {
  hasElectronBuilder = false;
}

if (!hasElectronBuilder) {
  console.log('[orkestral] install sem devDeps — nativos ficam no ABI do Node (CLI standalone).');
  process.exit(0);
}

const res = spawnSync('npx', ['--no-install', 'electron-builder', 'install-app-deps'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(res.status ?? 0);
