import { describe, it, expect } from 'vitest';
import {
  encryptWithKey,
  decryptWithKey,
  resolveSecretKey,
  blobScheme,
  safeStorageDecryptPlan,
} from './crypto-secret';

describe('crypto-secret', () => {
  const key = Buffer.alloc(32, 7);
  it('roundtrip: decrypt(encrypt(x)) === x', () => {
    const blob = encryptWithKey('meu-token-secreto', key);
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(decryptWithKey(blob, key)).toBe('meu-token-secreto');
  });
  it('cada encrypt usa IV novo (blobs diferentes pro mesmo input)', () => {
    const a = encryptWithKey('x', key);
    const b = encryptWithKey('x', key);
    expect(a.equals(b)).toBe(false);
    expect(decryptWithKey(a, key)).toBe('x');
    expect(decryptWithKey(b, key)).toBe('x');
  });
  it('chave errada falha (authTag não bate)', () => {
    const blob = encryptWithKey('x', key);
    expect(() => decryptWithKey(blob, Buffer.alloc(32, 9))).toThrow();
  });
  it('resolveSecretKey: usa ORKESTRAL_SECRET_KEY (base64 de 32 bytes)', () => {
    const raw = Buffer.alloc(32, 3);
    const key = resolveSecretKey({ envKey: raw.toString('base64'), keyfilePath: '/tmp/none' });
    expect(key.equals(raw)).toBe(true);
  });
  it('resolveSecretKey: gera e persiste keyfile quando sem env', () => {
    const p = `/tmp/ork-secret-${process.pid}.key`;
    const k1 = resolveSecretKey({ envKey: undefined, keyfilePath: p });
    const k2 = resolveSecretKey({ envKey: undefined, keyfilePath: p });
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });
});

describe('blobScheme', () => {
  it('identifica blobs tagueados (0x01 safeStorage, 0x02 crypto fallback)', () => {
    expect(blobScheme(Buffer.from([0x01, 0xaa, 0xbb]))).toBe('tagged-safestorage');
    expect(blobScheme(Buffer.from([0x02, 0xcc, 0xdd]))).toBe('tagged-crypto');
  });
  it('blob legado do safeStorage do Chromium (prefixo "v10"/"v11") cai em legacy', () => {
    expect(blobScheme(Buffer.concat([Buffer.from('v10'), Buffer.from([0x8a, 0x3b])]))).toBe(
      'legacy',
    );
    expect(blobScheme(Buffer.concat([Buffer.from('v11'), Buffer.from([0x00])]))).toBe('legacy');
  });
  it('buffer vazio é seguro (legacy, sem throw)', () => {
    expect(blobScheme(Buffer.alloc(0))).toBe('legacy');
  });
  it('0x01 é ambíguo no Windows: nossa tag e o DPAPI cru legado colidem', () => {
    // No Windows um blob safeStorage LEGADO (pré-tag) é DPAPI cru cujo 1º byte
    // também é 0x01. blobScheme não consegue distinguir — ambos viram
    // 'tagged-safestorage'. Quem resolve é o safeStorageDecryptPlan + fallback.
    expect(blobScheme(Buffer.from([0x01, 0x00, 0x00, 0x00]))).toBe('tagged-safestorage');
  });
});

describe('safeStorageDecryptPlan', () => {
  // Puro: não toca safeStorage (indisponível sob vitest); só decide a ordem de
  // tentativa que decryptCompat aplica. O decrypt de verdade é validado no
  // Windows ao vivo, onde o 1º byte do DPAPI (0x01) existe de fato.
  it('0x01 (tag ou DPAPI legado): tenta tagueado primeiro, cai pro blob inteiro', () => {
    const plan = safeStorageDecryptPlan(Buffer.from([0x01, 0xaa, 0xbb]));
    expect(plan).toEqual({ tryTaggedFirst: true, fallbackToFullBlob: true });
  });
  it('legacy 0x76 ("v10"/"v11" macOS/Linux): blob inteiro, sem fallback', () => {
    const plan = safeStorageDecryptPlan(Buffer.concat([Buffer.from('v10'), Buffer.from([0x8a])]));
    expect(plan).toEqual({ tryTaggedFirst: false, fallbackToFullBlob: false });
  });
});
