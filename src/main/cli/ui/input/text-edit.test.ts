import { describe, it, expect } from 'vitest';
import { applyKeyToBuffer } from './text-edit';

describe('applyKeyToBuffer', () => {
  it('insere char na posição do cursor (meio do buffer)', () => {
    expect(applyKeyToBuffer('abcd', 2, 'X', {})).toEqual({
      value: 'abXcd',
      cursor: 3,
      handled: true,
    });
  });

  it('backspace apaga o char ANTES do cursor; no início é no-op consumido', () => {
    expect(applyKeyToBuffer('abcd', 2, '', { backspace: true })).toEqual({
      value: 'acd',
      cursor: 1,
      handled: true,
    });
    expect(applyKeyToBuffer('abcd', 0, '', { backspace: true })).toEqual({
      value: 'abcd',
      cursor: 0,
      handled: true,
    });
  });

  it('delete apaga o char NO cursor; no fim é no-op consumido', () => {
    expect(applyKeyToBuffer('abcd', 1, '', { delete: true })).toEqual({
      value: 'acd',
      cursor: 1,
      handled: true,
    });
    expect(applyKeyToBuffer('abcd', 4, '', { delete: true })).toEqual({
      value: 'abcd',
      cursor: 4,
      handled: true,
    });
  });

  it('setas ←/→ movem o cursor com clamp em 0..len', () => {
    expect(applyKeyToBuffer('ab', 1, '', { leftArrow: true }).cursor).toBe(0);
    expect(applyKeyToBuffer('ab', 0, '', { leftArrow: true }).cursor).toBe(0);
    expect(applyKeyToBuffer('ab', 1, '', { rightArrow: true }).cursor).toBe(2);
    expect(applyKeyToBuffer('ab', 2, '', { rightArrow: true }).cursor).toBe(2);
  });

  it('Home/Ctrl+A vão pro início; End/Ctrl+E pro fim', () => {
    expect(applyKeyToBuffer('abcd', 2, '', { home: true }).cursor).toBe(0);
    expect(applyKeyToBuffer('abcd', 2, 'a', { ctrl: true }).cursor).toBe(0);
    expect(applyKeyToBuffer('abcd', 2, '', { end: true }).cursor).toBe(4);
    expect(applyKeyToBuffer('abcd', 2, 'e', { ctrl: true }).cursor).toBe(4);
  });

  it('Ctrl+U mata do início até o cursor', () => {
    expect(applyKeyToBuffer('abcdef', 3, 'u', { ctrl: true })).toEqual({
      value: 'def',
      cursor: 0,
      handled: true,
    });
  });

  it('Ctrl+K mata do cursor até o fim', () => {
    expect(applyKeyToBuffer('abcdef', 3, 'k', { ctrl: true })).toEqual({
      value: 'abc',
      cursor: 3,
      handled: true,
    });
  });

  it('Ctrl+W apaga a palavra antes do cursor (pulando espaços à esquerda)', () => {
    expect(applyKeyToBuffer('foo bar  ', 9, 'w', { ctrl: true })).toEqual({
      value: 'foo ',
      cursor: 4,
      handled: true,
    });
    expect(applyKeyToBuffer('foo bar baz', 7, 'w', { ctrl: true })).toEqual({
      value: 'foo  baz',
      cursor: 4,
      handled: true,
    });
  });

  it('Alt+Backspace (meta+backspace) apaga palavra igual Ctrl+W', () => {
    expect(applyKeyToBuffer('foo bar', 7, '', { backspace: true, meta: true })).toEqual({
      value: 'foo ',
      cursor: 4,
      handled: true,
    });
  });

  it('paste multi-char insere o bloco inteiro no cursor', () => {
    expect(applyKeyToBuffer('ab', 1, 'XYZ', {})).toEqual({
      value: 'aXYZb',
      cursor: 4,
      handled: true,
    });
  });

  it('paste normaliza \\r\\n, \\n e \\r pra espaço (campo single-line)', () => {
    expect(applyKeyToBuffer('', 0, 'a\r\nb\nc\rd', {})).toEqual({
      value: 'a b c d',
      cursor: 7,
      handled: true,
    });
  });

  it('clampa cursor fora do range antes de editar', () => {
    expect(applyKeyToBuffer('ab', 99, 'X', {})).toEqual({
      value: 'abX',
      cursor: 3,
      handled: true,
    });
    expect(applyKeyToBuffer('ab', -1, 'X', {})).toEqual({
      value: 'Xab',
      cursor: 1,
      handled: true,
    });
  });

  it('não trata Enter/Esc/Tab/↑/↓ nem combos de controle (dono do campo decide)', () => {
    expect(applyKeyToBuffer('ab', 1, '', { return: true }).handled).toBe(false);
    expect(applyKeyToBuffer('ab', 1, '', { escape: true }).handled).toBe(false);
    expect(applyKeyToBuffer('ab', 1, '', { tab: true }).handled).toBe(false);
    expect(applyKeyToBuffer('ab', 1, '', { upArrow: true }).handled).toBe(false);
    expect(applyKeyToBuffer('ab', 1, '', { downArrow: true }).handled).toBe(false);
    expect(applyKeyToBuffer('ab', 1, 'c', { ctrl: true }).handled).toBe(false); // Ctrl+C
    expect(applyKeyToBuffer('ab', 1, 'x', { meta: true }).handled).toBe(false);
  });
});
