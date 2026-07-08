import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQaBuildGate, findOrphanedNextRoutes } from './qa-validation-service';

describe('runQaBuildGate — gate de build determinístico do QA', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ork-qa-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function pkg(buildScript: string | null): void {
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 't', scripts: buildScript ? { build: buildScript } : {} }),
    );
  }

  it('path inexistente → não roda (ran:false), não inventa veredito', () => {
    expect(runQaBuildGate('/nao/existe/aqui').ran).toBe(false);
    expect(runQaBuildGate(null).ran).toBe(false);
  });

  it('sem script de build nem tsconfig → ran:false', () => {
    pkg(null);
    expect(runQaBuildGate(repo).ran).toBe(false);
  });

  it('build que PASSA → ran:true, ok:true', () => {
    pkg('node -e "process.exit(0)"');
    const r = runQaBuildGate(repo);
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.command).toBe('npm run build');
  });

  it('build que FALHA → ran:true, ok:false + captura o erro (a prova que o agente não fabrica)', () => {
    pkg('node -e "console.error(\'ERRO_DE_BUILD_XYZ\'); process.exit(1)"');
    const r = runQaBuildGate(repo);
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/ERRO_DE_BUILD_XYZ/);
  });
});

describe('findOrphanedNextRoutes — rotas Next fora de app/', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ork-route-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  const file = (p: string): void => {
    const full = join(repo, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// x');
  };

  it('não é projeto Next (sem next.config) → ignora', () => {
    file('config/route.ts');
    expect(findOrphanedNextRoutes(repo)).toEqual([]);
  });

  it('pega route.ts/page.tsx ÓRFÃS fora de app/ (raiz, config/, sessions/)', () => {
    file('next.config.js');
    file('route.ts');
    file('config/route.ts');
    file('sessions/route.ts');
    file('page.tsx');
    const orphans = findOrphanedNextRoutes(repo);
    expect(orphans).toContain('route.ts');
    expect(orphans).toContain('config/route.ts');
    expect(orphans).toContain('sessions/route.ts');
    expect(orphans).toContain('page.tsx');
  });

  it('NÃO marca rotas corretas sob app/ e src/app/', () => {
    file('next.config.js');
    file('app/api/webhooks/whatsapp/route.ts');
    file('app/page.tsx');
    file('src/app/dashboard/page.tsx');
    expect(findOrphanedNextRoutes(repo)).toEqual([]);
  });
});
