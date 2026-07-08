import { describe, expect, it, vi, beforeEach } from 'vitest';
import path from 'node:path';

// O helper importa `shell` do wrapper platform/electron (que resolve undefined
// fora do Electron, ex.: aqui no vitest) — mockamos o WRAPPER, não 'electron',
// senão o helper devolve false pra tudo. existsSync mockado pra controlar mustExist.
const openExternal = vi.fn(async () => '');
const openPath = vi.fn(async () => '');
vi.mock('../platform/electron', () => ({
  shell: { openExternal: (u: string) => openExternal(u), openPath: (p: string) => openPath(p) },
}));
vi.mock('node:fs', () => ({ existsSync: (p: string) => existing.has(path.resolve(p)) }));

const existing = new Set<string>();
import { openExternalSafe, openPathSafe } from './safe-shell';

beforeEach(() => {
  openExternal.mockClear();
  openPath.mockClear();
  existing.clear();
});

describe('openExternalSafe', () => {
  it('blocks dangerous and unexpected schemes', async () => {
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,x',
      'not a url',
      '',
    ]) {
      expect(await openExternalSafe(bad)).toBe(false);
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('allows https, mailto and OS-settings schemes', async () => {
    expect(await openExternalSafe('https://orkestral.ai')).toBe(true);
    expect(await openExternalSafe('mailto:a@b.com')).toBe(true);
    expect(await openExternalSafe('ms-settings:dateandtime')).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(3);
  });

  it('allows http only for loopback, blocks external http', async () => {
    expect(await openExternalSafe('http://localhost:3000/login')).toBe(true);
    expect(await openExternalSafe('http://127.0.0.1:38427/cb')).toBe(true);
    expect(await openExternalSafe('http://evil.example.com')).toBe(false);
  });
});

describe('openPathSafe', () => {
  it('rejects a path that escapes withinRoot', async () => {
    const root = path.resolve('/root');
    existing.add(path.resolve('/etc/passwd'));
    expect(await openPathSafe('/root/../../etc/passwd', { withinRoot: root })).toBe(false);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('accepts an in-root existing path', async () => {
    const root = path.resolve('/root');
    const target = path.resolve('/root/src/file.ts');
    existing.add(target);
    expect(await openPathSafe(target, { withinRoot: root })).toBe(true);
    expect(openPath).toHaveBeenCalledWith(target);
  });

  it('rejects a non-existent path by default', async () => {
    expect(await openPathSafe('/nope/missing')).toBe(false);
    expect(openPath).not.toHaveBeenCalled();
  });
});
