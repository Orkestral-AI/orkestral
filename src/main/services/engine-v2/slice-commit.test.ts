import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { commitSlice, isGitRepo } from './slice-commit';

const dirs: string[] = [];
function mk(git: boolean): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v2-commit-'));
  dirs.push(d);
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: d });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: d });
  }
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('commitSlice (commit per slice)', () => {
  it('commits in a git repo with a change', () => {
    const root = mk(true);
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    expect(isGitRepo(root)).toBe(true);
    expect(commitSlice(root, 'fatia 1')).toBe(true);
    const log = execFileSync('git', ['log', '--oneline'], { cwd: root }).toString();
    expect(log).toMatch(/fatia 1/);
  });

  it('does not break outside a git repo', () => {
    const root = mk(false);
    expect(isGitRepo(root)).toBe(false);
    expect(commitSlice(root, 'x')).toBe(false);
  });

  it('returns false when there is nothing to commit', () => {
    const root = mk(true);
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    commitSlice(root, 'primeira');
    expect(commitSlice(root, 'vazia')).toBe(false); // nada mudou
  });
});
