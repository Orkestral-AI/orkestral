import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { planPreview } from './preview-policy';

const dirs: string[] = [];
function mk(pkg: object | null, sourceDirs: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-prev-'));
  dirs.push(dir);
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const s of sourceDirs) fs.mkdirSync(path.join(dir, s), { recursive: true });
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('planPreview (contextual preview of engine v2)', () => {
  it('runnable Next.js = browser, needs the server up', () => {
    const root = mk({ dependencies: { next: '15', react: '19' }, scripts: { dev: 'next dev' } }, [
      'app',
      'node_modules',
    ]);
    const p = planPreview({ projectRoot: root });
    expect(p.kind).toBe('fullstack');
    expect(p.mode).toBe('browser');
    expect(p.needsBackendUp).toBe(true);
    expect(p.url).toBe('http://localhost:3000');
    expect(p.runnable).toBe(true);
  });

  it('scaffold with source + script but deps NOT installed (no node_modules) = not runnable yet', () => {
    const root = mk({ dependencies: { next: '15' }, scripts: { dev: 'next dev' } }, ['app']);
    const p = planPreview({ projectRoot: root });
    // Sem node_modules o dev server nem sobe: o preview nao deve aparecer ainda.
    expect(p.runnable).toBe(false);
    expect(p.mode).toBe('none');
    expect(p.url).toBeNull();
  });

  it('pure backend (express) = NO browser, HTTP endpoint, needs the server', () => {
    const root = mk({ dependencies: { express: '4' }, scripts: { start: 'node server.js' } }, [
      'src',
      'node_modules',
    ]);
    const p = planPreview({ projectRoot: root });
    expect(p.kind).toBe('backend');
    expect(p.mode).toBe('http-endpoint');
    expect(p.needsBackendUp).toBe(true);
    expect(p.url).toMatch(/\/health$/);
  });

  it('static frontend (react + vite, no backend) = browser, does NOT need a backend', () => {
    const root = mk(
      { devDependencies: { vite: '6' }, dependencies: { react: '19' }, scripts: { dev: 'vite' } },
      ['src', 'node_modules'],
    );
    const p = planPreview({ projectRoot: root });
    expect(p.kind).toBe('frontend');
    expect(p.needsBackendUp).toBe(false);
    expect(p.mode).toBe('browser');
  });

  it('front + back in the same repo = fullstack, needs the backend up', () => {
    const root = mk(
      { dependencies: { react: '19', express: '4' }, scripts: { dev: 'concurrently' } },
      ['src', 'node_modules'],
    );
    const p = planPreview({ projectRoot: root });
    expect(p.kind).toBe('fullstack');
    expect(p.needsBackendUp).toBe(true);
  });

  it('greenfield (package.json without source/script) = nothing runnable yet, no preview', () => {
    const root = mk({ dependencies: { next: '15' } }); // sem script, sem app/
    const p = planPreview({ projectRoot: root });
    expect(p.runnable).toBe(false);
    expect(p.mode).toBe('none');
    expect(p.url).toBeNull();
  });

  it('without package.json = unknown, preview unavailable', () => {
    const root = mk(null);
    const p = planPreview({ projectRoot: root });
    expect(p.kind).toBe('unknown');
    expect(p.mode).toBe('none');
    expect(p.runnable).toBe(false);
  });
});
