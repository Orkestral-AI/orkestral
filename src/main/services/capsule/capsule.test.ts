import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveAsserts, runAsserts } from './contract';
import { scopeViolation } from './scope';
import { renderCapsuleGuidance, pitfallFromFailure } from './render';
import { deriveCapsuleKeywords } from './builder';
import type { TaskCapsule, CapsuleTarget } from '../../../shared/types/capsule';
import { OEP_VERSION } from '../../../shared/types/capsule';

function target(file: string, op: 'edit' | 'create' = 'edit'): CapsuleTarget {
  return { taskId: 't1', file, op, region: null, delta: '', maxChangedLines: 200 };
}
function capsule(over: Partial<TaskCapsule> = {}): TaskCapsule {
  return {
    v: OEP_VERSION,
    capsuleId: 'c1',
    issueId: 'i1',
    workspaceId: 'w1',
    goal: 'g',
    keywords: [],
    targets: [target('src/app/page.tsx')],
    scope: { lockedPaths: [], allowNewFiles: false, touchBudgetFiles: 1 },
    contract: { done: '', asserts: [] },
    patterns: [],
    pitfalls: [],
    exemplarRefs: [],
    provenance: {
      compiledBy: 'deterministic-builder',
      compiledAt: '',
      capsuleHash: 'h',
      ledger: [],
    },
    ...over,
  };
}

describe('contract.deriveAsserts', () => {
  it('deriva file_contains do símbolo citado + imports_intact/no_shrink pra edit', () => {
    const a = deriveAsserts(
      { ...target('src/a.ts'), delta: 'chamar startCall() no onClick' },
      'o botão dispara startCall()',
    );
    expect(a.some((x) => x.kind === 'file_contains' && x.needle === 'startCall(')).toBe(true);
    expect(a.some((x) => x.kind === 'imports_intact')).toBe(true);
    expect(a.some((x) => x.kind === 'no_shrink_gt')).toBe(true);
  });

  it('NÃO deriva asserts pra CREATE (não rejeita arquivo novo válido)', () => {
    expect(
      deriveAsserts(
        { ...target('src/x.ts', 'create'), delta: 'criar com initApp()' },
        'usa initApp()',
      ),
    ).toEqual([]);
  });

  it('ignora símbolo citado dentro de COMENTÁRIO no done', () => {
    const a = deriveAsserts({ ...target('src/a.ts'), delta: '// não chamar ghost()' }, 'edita');
    expect(a.some((x) => x.kind === 'file_contains' && x.needle === 'ghost(')).toBe(false);
  });
});

describe('contract.runAsserts', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ork-cap-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('falha quando o símbolo pedido NÃO está no arquivo (trabalho errado que hoje passa)', () => {
    writeFileSync(join(repo, 'a.ts'), 'export function x() { return 1; }');
    const fail = runAsserts(
      [{ kind: 'file_contains', file: 'a.ts', needle: 'startCall(' }],
      repo,
      new Map(),
    );
    expect(fail?.reason).toMatch(/startCall/);
  });

  it('passa quando o símbolo está presente e imports intactos', () => {
    const before = 'import { y } from "y";\nexport function x() { return startCall(); }';
    writeFileSync(join(repo, 'a.ts'), before);
    const ok = runAsserts(
      [
        { kind: 'file_contains', file: 'a.ts', needle: 'startCall(' },
        { kind: 'imports_intact', file: 'a.ts' },
      ],
      repo,
      new Map([['a.ts', before]]),
    );
    expect(ok).toBeNull();
  });

  it('pega remoção de import (regressão)', () => {
    const before = 'import { y } from "y";\nexport const x = y;';
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;');
    const fail = runAsserts(
      [{ kind: 'imports_intact', file: 'a.ts' }],
      repo,
      new Map([['a.ts', before]]),
    );
    expect(fail?.reason).toMatch(/imports/);
  });
});

describe('scope.scopeViolation', () => {
  it('bloqueia caminho sensível (migrations/auth/secret) sempre', () => {
    expect(scopeViolation(capsule(), 'src/main/db/migrations.ts')).toMatch(/bloqueado/);
    expect(scopeViolation(capsule(), 'src/auth/login.ts')).toMatch(/bloqueado/);
  });
  it('bloqueia .env na RAIZ (glob **/ pega arquivo sem diretório)', () => {
    expect(scopeViolation(capsule(), '.env')).toMatch(/bloqueado/);
    expect(scopeViolation(capsule(), '.env.local')).toMatch(/bloqueado/);
  });
  it('bloqueia arquivo fora dos alvos quando não permite novos', () => {
    expect(scopeViolation(capsule(), 'src/other.ts')).toMatch(/fora dos alvos/);
  });
  it('permite o arquivo-alvo', () => {
    expect(scopeViolation(capsule(), 'src/app/page.tsx')).toBeNull();
  });
});

describe('render', () => {
  it('renderiza pitfalls como bloco AVOID compacto; vazio quando não há sinal', () => {
    expect(renderCapsuleGuidance(capsule())).toBe('');
    const g = renderCapsuleGuidance(
      capsule({
        pitfalls: [{ when: 'editar imports', avoid: 'duplicar', because: 'quebra', freq: 2 }],
      }),
    );
    expect(g).toMatch(/AVOID/);
    expect(g).toMatch(/duplicar/);
  });
  it('mapeia falha → pitfall acionável', () => {
    expect(pitfallFromFailure('import_drop', '')?.avoid).toMatch(/import/i);
    expect(pitfallFromFailure('whatever', '')).toBeNull();
  });
});

describe('builder.deriveCapsuleKeywords', () => {
  it('extrai termos canônicos, sem stopwords', () => {
    const kw = deriveCapsuleKeywords({
      title: 'Corrigir o botão de ligar no componente CallButton',
      description: '',
    } as never);
    expect(kw).toContain('corrigir');
    expect(kw).toContain('callbutton');
    expect(kw).not.toContain('de');
  });
});
