import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { camelSuffix, findCreateTemplate } from './create-template';

describe('create-template — template type-aware pra criar arquivo novo', () => {
  function repo(): string {
    return mkdtempSync(join(tmpdir(), 'ork-tpl-'));
  }

  it('camelSuffix pega a última palavra CamelCase', () => {
    expect(camelSuffix('CallContext')).toBe('Context');
    expect(camelSuffix('SoftPhoneWidget')).toBe('Widget');
    expect(camelSuffix('foo')).toBe('');
  });

  it('prefere o irmão de MESMO sufixo no MESMO diretório', () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, 'src', 'contexts'), { recursive: true });
      writeFileSync(join(dir, 'src', 'contexts', 'AuthContext.tsx'), 'export const Auth = 1;');
      writeFileSync(join(dir, 'src', 'contexts', 'Button.tsx'), 'export const Button = 2;');
      const tpl = findCreateTemplate(dir, 'src/contexts/CallContext.tsx', 10_000);
      expect(tpl).toBe('export const Auth = 1;'); // AuthContext (mesmo sufixo "Context")
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cai pra um irmão de mesma extensão quando não há mesmo sufixo', () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Card.tsx'), 'export const Card = 1;');
      const tpl = findCreateTemplate(dir, 'src/components/Modal.tsx', 10_000);
      expect(tpl).toBe('export const Card = 1;');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('não casa extensão diferente / sem candidato → null', () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'data.json'), '{}');
      expect(findCreateTemplate(dir, 'src/App.tsx', 10_000)).toBeNull();
      expect(findCreateTemplate(dir, 'src/App', 10_000)).toBeNull(); // sem extensão
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('capa o conteúdo em maxChars', () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'A.ts'), 'x'.repeat(500));
      const tpl = findCreateTemplate(dir, 'src/B.ts', 100);
      expect(tpl?.length).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
