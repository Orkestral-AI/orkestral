import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const IV_LEN = 12;
const TAG_LEN = 16;

// Byte de esquema no início do blob — torna o segredo auto-descritivo, pra
// decifrar certo mesmo se a disponibilidade do Keychain mudar entre quem cifrou
// (ex.: GUI Electron) e quem decifra (ex.: CLI headless) na mesma máquina.
export const SCHEME_SAFE_STORAGE = 0x01;
export const SCHEME_CRYPTO_FALLBACK = 0x02;

export type BlobScheme = 'tagged-safestorage' | 'tagged-crypto' | 'legacy';

/**
 * Identifica o esquema de um blob de segredo. Blobs novos são tagueados com o
 * byte de esquema; blobs legados são safeStorage cru do Chromium, que no
 * macOS/Linux começa com "v10"/"v11" (0x76…) — nunca colide.
 *
 * ATENÇÃO — colisão no Windows: lá o safeStorage legado (pré-tag) é um blob
 * DPAPI cru cujo PRIMEIRO byte também é 0x01 (dword de versão do DPAPI). Ou
 * seja, um blob legado do Windows é classificado aqui como 'tagged-safestorage'
 * — 0x01 é AMBÍGUO nessa plataforma (tag nossa vs. DPAPI cru). Quem decifra
 * (ver decryptCompat) precisa tratar isso tentando a interpretação tagueada e,
 * se falhar, caindo pro blob inteiro como DPAPI legado. 0x02 é inequívoco (só
 * nosso fallback crypto produz). Buffer vazio cai em 'legacy'.
 */
export function blobScheme(blob: Buffer): BlobScheme {
  if (blob[0] === SCHEME_SAFE_STORAGE) return 'tagged-safestorage';
  if (blob[0] === SCHEME_CRYPTO_FALLBACK) return 'tagged-crypto';
  return 'legacy';
}

/**
 * Plano de decifração de um blob safeStorage (com ou sem tag), decidido só pelo
 * esquema — puro, sem tocar no safeStorage (por isso testável sob vitest).
 *
 * - `tryTaggedFirst`: tentar `safeStorage.decryptString(blob.subarray(1))`
 *   (interpretação tagueada, tirando nosso byte de esquema).
 * - `fallbackToFullBlob`: se a tentativa tagueada lançar, tentar
 *   `safeStorage.decryptString(blob)` (blob inteiro = DPAPI legado do Windows,
 *   cujo 1º byte 0x01 colide com nossa tag). Só faz sentido quando o 1º byte é
 *   0x01; um 0x76… ('legacy') vai direto pro blob inteiro sem tentar subarray.
 */
export function safeStorageDecryptPlan(blob: Buffer): {
  tryTaggedFirst: boolean;
  fallbackToFullBlob: boolean;
} {
  const scheme = blobScheme(blob);
  if (scheme === 'tagged-safestorage') {
    // 0x01: ambíguo no Windows. Tenta tag primeiro, cai pro blob inteiro.
    return { tryTaggedFirst: true, fallbackToFullBlob: true };
  }
  // 'legacy' (ex.: 0x76 "v10"/"v11" no macOS/Linux): blob inteiro, sem fallback.
  return { tryTaggedFirst: false, fallbackToFullBlob: false };
}

export function encryptWithKey(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptWithKey(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function resolveSecretKey(opts: { envKey?: string; keyfilePath: string }): Buffer {
  if (opts.envKey) {
    const buf = Buffer.from(opts.envKey, 'base64');
    if (buf.length !== 32) throw new Error('ORKESTRAL_SECRET_KEY deve ser 32 bytes em base64');
    return buf;
  }
  if (existsSync(opts.keyfilePath)) {
    const buf = readFileSync(opts.keyfilePath);
    if (buf.length === 32) return buf;
  }
  const key = randomBytes(32);
  mkdirSync(dirname(opts.keyfilePath), { recursive: true });
  writeFileSync(opts.keyfilePath, key, { mode: 0o600 });
  return key;
}
