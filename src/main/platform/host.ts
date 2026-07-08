import { app, BrowserWindow, safeStorage } from './electron';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encryptWithKey,
  decryptWithKey,
  resolveSecretKey,
  blobScheme,
  safeStorageDecryptPlan,
  SCHEME_SAFE_STORAGE,
  SCHEME_CRYPTO_FALLBACK,
} from './crypto-secret';

/**
 * Bus de push do main → interfaces. Todo `broadcast()` emite aqui
 * (`'push'`, payload `{ channel, payload }`) ALÉM de mandar pras
 * BrowserWindows: é o que alimenta o gateway WS (web) e o feed do CLI em Node
 * puro, onde não existe janela nenhuma. setMaxListeners(0): o número de
 * consumidores (gateway + feeds + debug) não é conhecido aqui.
 */
export const pushBus = new EventEmitter();
pushBus.setMaxListeners(0);

export function broadcast(channel: string, payload: unknown): void {
  pushBus.emit('push', { channel, payload });
  if (!BrowserWindow?.getAllWindows) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function fallbackKey(): Buffer {
  return resolveSecretKey({
    envKey: process.env.ORKESTRAL_SECRET_KEY,
    keyfilePath: join(appInfo.path('userData'), 'secret.key'),
  });
}

export const secrets = {
  encrypt(plain: string): Buffer {
    if (safeStorage?.isEncryptionAvailable?.()) {
      return Buffer.concat([Buffer.from([SCHEME_SAFE_STORAGE]), safeStorage.encryptString(plain)]);
    }
    return Buffer.concat([
      Buffer.from([SCHEME_CRYPTO_FALLBACK]),
      encryptWithKey(plain, fallbackKey()),
    ]);
  },
  decrypt(blob: Buffer): string {
    const scheme = blob[0];
    const body = blob.subarray(1);
    if (scheme === SCHEME_SAFE_STORAGE) {
      if (!safeStorage?.isEncryptionAvailable?.()) {
        throw new Error('segredo cifrado com o Keychain do SO, indisponível neste ambiente');
      }
      // NB: no Windows este subarray(1) pode corromper um blob DPAPI legado
      // (1º byte 0x01 = versão do DPAPI, não nossa tag). O caminho robusto é
      // decryptCompat, que todos os consumidores usam. Ver DPAPI collision.
      return safeStorage.decryptString(body);
    }
    if (scheme === SCHEME_CRYPTO_FALLBACK) return decryptWithKey(body, fallbackKey());
    throw new Error('formato de segredo desconhecido');
  },
  /**
   * Decripta de forma tolerante — é o caminho que todos os repos usam. Trata a
   * colisão do DPAPI no Windows: um blob safeStorage LEGADO (pré-tag) começa com
   * 0x01 (dword de versão do DPAPI), o MESMO byte da nossa tag SCHEME_SAFE_STORAGE.
   * Por isso, no esquema 0x01, tenta a interpretação tagueada (subarray(1)) e, se
   * falhar, cai pro blob inteiro (DPAPI legado). macOS/Linux ('legacy', 0x76…) vão
   * direto pro blob inteiro. 0x02 (crypto fallback) é inequívoco e delega ao decrypt.
   */
  decryptCompat(blob: Buffer): string {
    if (blobScheme(blob) === 'tagged-crypto') return this.decrypt(blob);
    if (!safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('segredo legado requer o Keychain do SO, indisponível neste ambiente');
    }
    const plan = safeStorageDecryptPlan(blob);
    if (plan.tryTaggedFirst) {
      try {
        return safeStorage.decryptString(blob.subarray(1));
      } catch (taggedErr) {
        if (!plan.fallbackToFullBlob) throw taggedErr;
        // Fallback: blob inteiro como safeStorage/DPAPI legado do Windows.
        try {
          return safeStorage.decryptString(blob);
        } catch {
          throw new Error('falha ao decifrar segredo safeStorage (tag e DPAPI legado)');
        }
      }
    }
    // 'legacy' (0x76…): blob inteiro, sem tag a remover.
    return safeStorage.decryptString(blob);
  },
};

/**
 * Versão lida do package.json DO PRÓPRIO pacote (sobe diretórios a partir do
 * bundle até achar o "orkestral"). É a fonte certa em todo cenário:
 * `app.getVersion()` devolve a versão do ELECTRON quando rodamos não-empacotado
 * (`electron out/main/cli.js` → 39.x) e não existe em Node puro (npm i -g).
 */
let cachedPackageVersion: string | null | undefined;
function packageVersion(): string | null {
  if (cachedPackageVersion !== undefined) return cachedPackageVersion;
  cachedPackageVersion = null;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'orkestral' && pkg.version) {
        cachedPackageVersion = pkg.version;
        break;
      }
    } catch {
      /* sem package.json neste nível */
    }
    dir = dirname(dir);
  }
  return cachedPackageVersion;
}

export const appInfo = {
  version(): string {
    return packageVersion() ?? app?.getVersion?.() ?? process.env.APP_VERSION ?? '0.0.0-headless';
  },
  path(name: 'userData' | 'home'): string {
    if (app?.getPath) {
      return name === 'userData' ? app.getPath('userData') : app.getPath('home');
    }
    return name === 'home' ? homedir() : join(homedir(), '.orkestral');
  },
};
