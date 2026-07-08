import { describe, expect, it } from 'vitest';
import { isAbsolute, resolve, sep } from 'node:path';
import { anchorSuggestionRange, resolveSuggestionTarget } from './code-review-service';

/**
 * Testes da ÂNCORA por conteúdo de `applyCommentSuggestion`. Essa função escreve
 * em arquivos-fonte reais, então a regra é SEGURANÇA EM PRIMEIRO LUGAR: localizar
 * o `codeContext` como bloco contíguo EXATO (com indentação e brancos), exigir
 * match único e ≥ 2 linhas não-triviais, e abortar (null) em qualquer ambiguidade.
 */
describe('anchorSuggestionRange', () => {
  const file = [
    'function add(a, b) {', // 0
    '  const sum = a + b;', // 1
    '  return sum;', // 2
    '}', // 3
    '', // 4
    'function sub(a, b) {', // 5
    '  const diff = a - b;', // 6
    '  return diff;', // 7
    '}', // 8
  ];

  it('localiza o bloco inteiro quando o alvo cobre todo o codeContext', () => {
    const ctx = '  const sum = a + b;\n  return sum;';
    const range = anchorSuggestionRange(file, ctx, 2, 3);
    expect(range).toEqual({ startIdx: 1, endIdx: 2 });
  });

  it('compara COM indentação original (não casa bloco re-indentado/trimado)', () => {
    const ctx = 'const sum = a + b;\nreturn sum;'; // sem a indentação real
    expect(anchorSuggestionRange(file, ctx, 2, 3)).toBeNull();
  });

  it('inclui linhas em branco do contexto na comparação contígua', () => {
    const ctx = '  return sum;\n}\n\nfunction sub(a, b) {';
    const range = anchorSuggestionRange(file, ctx, 3, 6);
    // bloco em [2..5], alvo == bloco inteiro
    expect(range).toEqual({ startIdx: 2, endIdx: 5 });
  });

  it('aborta quando o codeContext sumiu do arquivo', () => {
    const ctx = '  const product = a * b;\n  return product;';
    expect(anchorSuggestionRange(file, ctx, 2, 3)).toBeNull();
  });

  it('aborta em match ambíguo (>1 ocorrência)', () => {
    const dup = ['  return x;', '}', '  return x;', '}'];
    const ctx = '  return x;\n}';
    expect(anchorSuggestionRange(dup, ctx, 1, 2)).toBeNull();
  });

  it('aborta com âncora de 1 linha (não-trivial) — casaria indiscriminadamente', () => {
    const ctx = '  return sum;';
    expect(anchorSuggestionRange(file, ctx, 3, 3)).toBeNull();
  });

  it('aborta quando o contexto é só linhas triviais (< 2 não-triviais)', () => {
    const ctx = '}\n';
    expect(anchorSuggestionRange(file, ctx, 4, 4)).toBeNull();
  });

  it('aborta sem codeContext (não confia nos números do diff)', () => {
    expect(anchorSuggestionRange(file, null, 2, 3)).toBeNull();
    expect(anchorSuggestionRange(file, '', 2, 3)).toBeNull();
  });

  it('aborta quando o alvo é menor que o bloco (offset não recuperável)', () => {
    // bloco de 4 linhas, mas alvo de 1 linha → offset ambíguo → aborta
    const ctx = 'function sub(a, b) {\n  const diff = a - b;\n  return diff;\n}';
    expect(anchorSuggestionRange(file, ctx, 6, 6)).toBeNull();
  });

  it('aborta quando o alvo é maior que o bloco de contexto', () => {
    const ctx = '  const sum = a + b;\n  return sum;';
    expect(anchorSuggestionRange(file, ctx, 2, 5)).toBeNull();
  });

  it('localiza corretamente mesmo com drift de números de linha (ancora por conteúdo)', () => {
    // diff aponta linhas bem distantes, mas o conteúdo casa em [1..2]
    const ctx = '  const sum = a + b;\n  return sum;';
    const range = anchorSuggestionRange(file, ctx, 99, 100);
    expect(range).toEqual({ startIdx: 1, endIdx: 2 });
  });
});

/**
 * Guard anti path-traversal de `applyCommentSuggestion`: o `filePath` vem cru do
 * JSON do LLM (sem sanitização), então um `../../../evil.txt` ou path absoluto
 * NÃO pode escrever fora do workspace. `resolveSuggestionTarget` é a checagem de
 * contenção (com tratamento do prefixo `[repo-name]` do fluxo multi-PR).
 */
describe('resolveSuggestionTarget (containment / path traversal)', () => {
  const workspace = resolve(sep, 'tmp', 'workspace');

  it('aceita um path relativo simples dentro do workspace', () => {
    const target = resolveSuggestionTarget(workspace, 'src/auth.ts');
    expect(target).toBe(resolve(workspace, 'src/auth.ts'));
  });

  it('RECUSA traversal com ../ que escapa do workspace', () => {
    expect(resolveSuggestionTarget(workspace, '../../../evil.txt')).toBeNull();
  });

  it('RECUSA um path absoluto cru', () => {
    const absolute = resolve(sep, 'etc', 'passwd');
    expect(isAbsolute(absolute)).toBe(true);
    expect(resolveSuggestionTarget(workspace, absolute)).toBeNull();
  });

  it('RECUSA traversal mesmo com o prefixo [repo-name] do fluxo multi-PR', () => {
    expect(resolveSuggestionTarget(workspace, '[ezsoft/api]../../../evil.txt')).toBeNull();
  });

  it('remove o prefixo [repo-name] antes de resolver um path válido', () => {
    const target = resolveSuggestionTarget(workspace, '[ezsoft/api]src/auth.ts');
    expect(target).toBe(resolve(workspace, 'src/auth.ts'));
  });

  it('RECUSA prefixo que casa o nome do workspace mas escapa (workspace-evil)', () => {
    // resolve(workspace, '../workspace-evil/x') NÃO pode ser aceito como "contido"
    expect(resolveSuggestionTarget(workspace, '../workspace-evil/x.ts')).toBeNull();
  });
});
