import { describe, it, expect } from 'vitest';
import { isNewerVersion } from './update-service';

describe('isNewerVersion', () => {
  it('detecta patch/minor/major mais novos', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.0.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
  });

  it('versão igual não é update', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });

  it('versão mais antiga não é update', () => {
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(false);
    expect(isNewerVersion('1.9.9', '2.0.0')).toBe(false);
  });

  it('ignora prefixo "v" dos dois lados', () => {
    expect(isNewerVersion('v1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('v1.0.0', 'v1.0.0')).toBe(false);
  });

  it('ignora sufixo de prerelease ao comparar o core', () => {
    // 1.2.3-beta tem o mesmo core que 1.2.3 → não conta como update.
    expect(isNewerVersion('1.2.3-beta', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.4-rc1', '1.2.3')).toBe(true);
  });

  it('trata versões curtas (1.2) como 1.2.0', () => {
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.3', '1.2.9')).toBe(true);
  });
});
