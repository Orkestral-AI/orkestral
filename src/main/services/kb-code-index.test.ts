import { describe, it, expect } from 'vitest';
import { __test__ } from './kb-code-index';

/**
 * Testes UNITÁRIOS da lógica PURA da indexação de código-fonte: chunking por
 * símbolo com provenance file:line, parser de .gitignore, detecção de binário e
 * tokenização. A indexação completa toca o DB singleton (ABI Electron) e fica
 * fora destes testes — aqui validamos a lógica que decide O QUE indexar e COMO
 * fatiar, que é o coração do grounding por código.
 */

const { chunkFile, symbolForLine, parseGitignoreLines, isIgnored, looksBinary, tokenSetFor } =
  __test__;

describe('symbolForLine', () => {
  it('detecta declarações top-level TS/JS', () => {
    expect(symbolForLine('export function searchCode(ws: string) {', '.ts')).toBe('searchCode');
    expect(symbolForLine('export const kbCodeChunkRepo = new Repo();', '.ts')).toBe(
      'kbCodeChunkRepo',
    );
    expect(symbolForLine('export default class Foo {', '.tsx')).toBe('Foo');
    expect(symbolForLine('async function loadModel() {', '.js')).toBe('loadModel');
  });

  it('detecta def/class em Python e func/type em Go', () => {
    expect(symbolForLine('def index_source(path):', '.py')).toBe('index_source');
    expect(symbolForLine('class Indexer:', '.py')).toBe('Indexer');
    expect(symbolForLine('func IndexSource(p string) error {', '.go')).toBe('IndexSource');
    expect(symbolForLine('type CodeChunk struct {', '.go')).toBe('CodeChunk');
  });

  it('ignora linhas que não declaram símbolo top-level', () => {
    expect(symbolForLine('  const x = 1;', '.ts')).toBeNull();
    expect(symbolForLine('// export function fake() {}', '.ts')).toBeNull();
    expect(symbolForLine('return foo;', '.ts')).toBeNull();
  });
});

describe('chunkFile — provenance file:line', () => {
  it('quebra em fronteiras de símbolo com linhas 1-based corretas', () => {
    const src = [
      "import { a } from 'x';", // 1
      '', // 2
      'export function alpha() {', // 3
      '  return 1;', // 4
      '}', // 5
      '', // 6
      'export function beta() {', // 7
      '  return 2;', // 8
      '}', // 9
    ].join('\n');
    const chunks = chunkFile(src, '.ts');
    // header (imports) + alpha + beta
    expect(chunks.length).toBe(3);
    const header = chunks[0];
    expect(header.startLine).toBe(1);
    const alpha = chunks.find((c) => c.symbol === 'alpha')!;
    expect(alpha).toBeDefined();
    expect(alpha.startLine).toBe(3);
    expect(alpha.text).toContain('return 1;');
    const beta = chunks.find((c) => c.symbol === 'beta')!;
    expect(beta.startLine).toBe(7);
    expect(beta.endLine).toBe(9);
    expect(beta.text).toContain('return 2;');
  });

  it('arquivo sem símbolos vira janelas por tamanho (provenance preservada)', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `value_${i} = ${i}`);
    const chunks = chunkFile(lines.join('\n'), '.py');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startLine).toBe(1);
    // As linhas são contíguas e crescentes entre chunks.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
    }
  });

  it('pula chunk trivial/vazio', () => {
    expect(chunkFile('\n\n   \n', '.ts')).toEqual([]);
  });
});

describe('parseGitignoreLines + isIgnored', () => {
  it('casa nome de diretório em qualquer profundidade', () => {
    const rules = parseGitignoreLines('node_modules\nbuild/\n*.log');
    expect(isIgnored(rules, 'node_modules', true)).toBe(true);
    expect(isIgnored(rules, 'packages/app/node_modules', true)).toBe(true);
    expect(isIgnored(rules, 'build', true)).toBe(true);
    expect(isIgnored(rules, 'debug.log', false)).toBe(true);
    expect(isIgnored(rules, 'src/index.ts', false)).toBe(false);
  });

  it('respeita anchored e dir-only', () => {
    const rules = parseGitignoreLines('/dist\nsecrets/');
    expect(isIgnored(rules, 'dist', true)).toBe(true);
    expect(isIgnored(rules, 'dist/bundle.js', false)).toBe(true);
    // anchored: só na raiz
    expect(isIgnored(rules, 'packages/dist', true)).toBe(false);
    // dir-only não casa arquivo de mesmo nome
    expect(isIgnored(rules, 'secrets', false)).toBe(false);
    expect(isIgnored(rules, 'secrets', true)).toBe(true);
  });

  it('negação reabilita um caminho ignorado (última regra vence)', () => {
    const rules = parseGitignoreLines('*.env\n!example.env');
    expect(isIgnored(rules, 'prod.env', false)).toBe(true);
    expect(isIgnored(rules, 'example.env', false)).toBe(false);
  });
});

describe('looksBinary', () => {
  it('detecta NUL byte como binário', () => {
    expect(looksBinary(Buffer.from([0x66, 0x00, 0x6f]))).toBe(true);
    expect(looksBinary(Buffer.from('const x = 1;', 'utf-8'))).toBe(false);
  });
});

describe('tokenSetFor', () => {
  it('tokeniza símbolo e body separadamente', () => {
    const set = tokenSetFor('searchCode', 'export function searchCode(ws) { return bm25(ws); }');
    expect(set.symbol.has('searchcode')).toBe(true);
    expect(set.body.has('searchcode')).toBe(true);
    expect(set.body.has('bm25')).toBe(true);
    // sem símbolo → symbol vazio
    expect(tokenSetFor(null, 'plain body text').symbol.size).toBe(0);
  });
});
