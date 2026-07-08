import { describe, it, expect } from 'vitest';
import { extractLinkUri } from './signal-link-uri';

describe('extractLinkUri', () => {
  it('extrai o sgnl://linkdevice da saída do signal-cli', () => {
    const out = 'Some banner\nsgnl://linkdevice?uuid=abc&pub_key=xyz%3D\nmore logs';
    expect(extractLinkUri(out)).toBe('sgnl://linkdevice?uuid=abc&pub_key=xyz%3D');
  });

  it('retorna null quando não há URI', () => {
    expect(extractLinkUri('nada aqui')).toBeNull();
  });

  it('ignora espaços/quebras ao redor', () => {
    expect(extractLinkUri('  sgnl://linkdevice?uuid=1  \n')).toBe('sgnl://linkdevice?uuid=1');
  });
});
