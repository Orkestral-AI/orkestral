import { describe, it, expect } from 'vitest';
import * as os from 'node:os';

import { launchPreview } from './preview-launcher';
import type { PreviewPlan } from './preview-policy';

const base: PreviewPlan = {
  kind: 'fullstack',
  runnable: true,
  brownfield: true,
  needsBackendUp: true,
  mode: 'browser',
  url: 'http://localhost:3000',
  startCommand: 'npm run dev',
  reason: '',
};

describe('launchPreview (brings up the dev server)', () => {
  it('does not run when it is not runnable', () => {
    expect(launchPreview(os.tmpdir(), { ...base, runnable: false })).toBeNull();
  });

  it('does not run without startCommand', () => {
    expect(launchPreview(os.tmpdir(), { ...base, startCommand: null })).toBeNull();
  });

  it('brings up a process and returns a handle with url + stop', () => {
    // usa um comando inofensivo que fica vivo (node sleep), em vez de um dev server real.
    const handle = launchPreview(os.tmpdir(), {
      ...base,
      startCommand: 'node -e setTimeout(()=>{},3000)',
    });
    expect(handle).not.toBeNull();
    expect(handle?.url).toBe('http://localhost:3000');
    expect(typeof handle?.stop).toBe('function');
    handle?.stop();
  });
});
