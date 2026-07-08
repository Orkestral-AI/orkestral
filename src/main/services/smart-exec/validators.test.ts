import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runValidation, firstFailure } from './validators';

describe('runValidation — ferramenta ausente não pode bloquear o Forge (é problema de ambiente)', () => {
  function dir(): string {
    return mkdtempSync(join(tmpdir(), 'ork-val-'));
  }

  it('comando inexistente (binário ausente) → PULADO, passa (não bloqueia)', async () => {
    const d = dir();
    try {
      const res = await runValidation(d, ['orkestral-no-such-binary-xyz --check'], 5000);
      expect(res.passed).toBe(true);
      expect(res.steps[0].skipped).toBe(true);
      expect(firstFailure(res)).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('npm run de script com binário ausente → PULADO (caso do node_modules não instalado)', async () => {
    const d = dir();
    try {
      // simula `npm run lint` quando eslint não está instalado: o shell não acha o bin
      const res = await runValidation(d, ['eslint-not-installed-here src'], 5000);
      expect(res.passed).toBe(true);
      expect(res.steps[0].skipped).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('comando que RODA e falha de verdade → falha (continua sendo rede de segurança)', async () => {
    const d = dir();
    try {
      const res = await runValidation(d, ['node -e "process.exit(1)"'], 5000);
      expect(res.passed).toBe(false);
      expect(res.steps[0].skipped).toBeFalsy();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('comando que RODA e passa → passa', async () => {
    const d = dir();
    try {
      const res = await runValidation(d, ['node -e "process.exit(0)"'], 5000);
      expect(res.passed).toBe(true);
      expect(res.steps[0].skipped).toBeFalsy();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
