import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { gatherRepoContext } from './repo-context';

const dirs: string[] = [];
function mk(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-ctx-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('gatherRepoContext (brownfield awareness of the planner)', () => {
  it('lists existing files + deps, ignoring node_modules', () => {
    const root = mk();
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { next: '15' }, scripts: { dev: 'next dev' } }),
    );
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'app', 'page.tsx'),
      'export default function P(){return null}',
    );
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), '');

    const ctx = gatherRepoContext(root);
    expect(ctx).toMatch(/app\/page\.tsx/);
    expect(ctx).toMatch(/next/);
    expect(ctx).toMatch(/JA EXISTEM/);
    expect(ctx).not.toMatch(/node_modules/);
  });

  it('empty repo = signals greenfield', () => {
    const root = mk();
    expect(gatherRepoContext(root)).toMatch(/greenfield/i);
  });
});
