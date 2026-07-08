/**
 * DEV ONLY — renomeia o bundle do Electron pra "Orkestral" no dock/menu do macOS.
 *
 * Em dev (`electron-vite dev`) o macOS lê o nome do app do bundle do Electron em
 * `node_modules/electron/dist/Electron.app` (CFBundleName="Electron") — `app.setName()`
 * NÃO muda isso em dev. Aqui patcheamos o Info.plist pra "Orkestral" e re-assinamos
 * ad-hoc (a assinatura do binário de dev já é adhoc/linker-signed, então re-assinar
 * é seguro). No app EMPACOTADO o productName já é "Orkestral" — isto é só pro dev.
 *
 * Best-effort e idempotente: NUNCA derruba o `npm run dev`. Se a re-assinatura
 * falhar, reverte o nome pra não quebrar o launch.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const NAME = 'Orkestral';

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}
function setName(plist, value) {
  run('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', value, plist]);
  run('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', value, plist]);
}

try {
  if (process.platform !== 'darwin') process.exit(0);
  const appPath = join(process.cwd(), 'node_modules', 'electron', 'dist', 'Electron.app');
  const plist = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plist)) process.exit(0);

  let current = '';
  try {
    current = run('/usr/bin/plutil', ['-extract', 'CFBundleName', 'raw', plist]);
  } catch {
    /* chave ausente — segue e seta */
  }
  if (current === NAME) process.exit(0); // já patcheado

  setName(plist, NAME);
  try {
    // Re-assina ad-hoc (a mudança de Info.plist invalida a assinatura selada).
    run('/usr/bin/codesign', ['--force', '--sign', '-', appPath]);
  } catch (signErr) {
    // Falhou a re-assinatura → reverte pra "Electron" pra não quebrar o launch do dev.
    try {
      setName(plist, 'Electron');
      run('/usr/bin/codesign', ['--force', '--sign', '-', appPath]);
    } catch {
      /* ignore */
    }
    console.warn('[brand-dev-app] re-assinatura falhou, revertido:', signErr?.message ?? signErr);
    process.exit(0);
  }
  console.log(`[brand-dev-app] Electron.app → "${NAME}" (dock/menu do macOS em dev)`);
} catch (err) {
  console.warn(
    '[brand-dev-app] não foi possível renomear (dev segue normal):',
    err?.message ?? err,
  );
}
