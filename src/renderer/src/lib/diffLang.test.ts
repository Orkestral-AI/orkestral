import { describe, it, expect } from 'vitest';
import { langFromPath } from './diffLang';

describe('langFromPath', () => {
  it('maps common extensions', () => {
    expect(langFromPath('src/app.ts')).toBe('typescript');
    expect(langFromPath('src/App.tsx')).toBe('tsx');
    expect(langFromPath('main.py')).toBe('python');
    expect(langFromPath('style.css')).toBe('css');
    expect(langFromPath('data.json')).toBe('json');
    expect(langFromPath('run.sh')).toBe('bash');
  });
  it('handles dotfiles and unknown extensions', () => {
    expect(langFromPath('Dockerfile')).toBe('docker');
    expect(langFromPath('notes.xyz')).toBe('tsx');
    expect(langFromPath('noext')).toBe('tsx');
  });
});
