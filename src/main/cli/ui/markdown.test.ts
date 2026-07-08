import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './markdown';

describe('parseMarkdown', () => {
  it('texto puro passa direto (uma linha, um span)', () => {
    expect(parseMarkdown('oi tudo bem')).toEqual([[{ text: 'oi tudo bem' }]]);
  });

  it('**negrito** vira span bold', () => {
    expect(parseMarkdown('um **dois** três')).toEqual([
      [{ text: 'um ' }, { text: 'dois', bold: true }, { text: ' três' }],
    ]);
  });

  it('`código` inline vira span code', () => {
    expect(parseMarkdown('rode `npm test` aí')).toEqual([
      [{ text: 'rode ' }, { text: 'npm test', code: true }, { text: ' aí' }],
    ]);
  });

  it('fence vira réguas dim + linhas code (lang na régua de cima)', () => {
    expect(parseMarkdown('```ts\nconst a = 1;\n```')).toEqual([
      [{ text: '────────── ts', dim: true }],
      [{ text: 'const a = 1;', code: true }],
      [{ text: '──────────', dim: true }],
    ]);
  });

  it('bullet `- ` vira `•` (indentação preservada)', () => {
    expect(parseMarkdown('- item **forte**\n  - sub')).toEqual([
      [{ text: '• ' }, { text: 'item ' }, { text: 'forte', bold: true }],
      [{ text: '  • ' }, { text: 'sub' }],
    ]);
  });

  it('heading # / ## vira linha bold', () => {
    expect(parseMarkdown('# Título\n## Sub')).toEqual([
      [{ text: 'Título', bold: true }],
      [{ text: 'Sub', bold: true }],
    ]);
  });

  it('fence sem fechamento é tolerado (resto vira code)', () => {
    expect(parseMarkdown('```\na\nb')).toEqual([
      [{ text: '──────────', dim: true }],
      [{ text: 'a', code: true }],
      [{ text: 'b', code: true }],
    ]);
  });

  it('linha mista: negrito + código + itálico juntos', () => {
    expect(parseMarkdown('**a** e `b` e *c*')).toEqual([
      [
        { text: 'a', bold: true },
        { text: ' e ' },
        { text: 'b', code: true },
        { text: ' e ' },
        { text: 'c', italic: true },
      ],
    ]);
  });

  it('marcador sem par não quebra (vira texto puro)', () => {
    expect(parseMarkdown('2 * 3 * 4 e **aberto')).toEqual([[{ text: '2 * 3 * 4 e **aberto' }]]);
    expect(parseMarkdown('crase ` solta')).toEqual([[{ text: 'crase ` solta' }]]);
  });

  it('linha em branco vira [] (linha vazia no render)', () => {
    expect(parseMarkdown('a\n\nb')).toEqual([[{ text: 'a' }], [], [{ text: 'b' }]]);
  });
});
