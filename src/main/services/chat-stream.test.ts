import { describe, it, expect } from 'vitest';
import { orkestralComponentCut, safeStreamDisplay } from './chat-stream';

const HIRING = ['<orkestral:create-agent'];
const display = (raw: string): string => raw.slice(0, orkestralComponentCut(raw));

describe('orkestralComponentCut — streaming buffer de componentes (P0-03)', () => {
  it('passa texto normal sem cortar', () => {
    const s = 'Hello, this is a normal answer.';
    expect(orkestralComponentCut(s)).toBe(s.length);
  });

  it('segura uma tag de abertura incompleta (sem ">")', () => {
    const s = 'Plan ready: <orkestral:create-issue title="Fix';
    expect(display(s)).toBe('Plan ready: ');
  });

  it('segura um prefixo parcial do literal no fim do buffer', () => {
    expect(display('Text before <ork')).toBe('Text before ');
    expect(display('Text before <')).toBe('Text before ');
  });

  it('deixa um componente COMPLETO passar e continua varrendo', () => {
    const s = 'A <orkestral:create-issue title="x"></orkestral:create-issue> B';
    expect(orkestralComponentCut(s)).toBe(s.length);
  });

  it('segura um bloco aberto mas ainda sem fechamento', () => {
    const s = 'A <orkestral:create-issue title="x">body without close';
    expect(display(s)).toBe('A ');
  });

  it('aceita componente self-closing', () => {
    const s = 'A <orkestral:create-issue title="x" /> B';
    expect(orkestralComponentCut(s)).toBe(s.length);
  });

  it('mantém o completo e segura um segundo componente incompleto', () => {
    const s =
      'A <orkestral:create-issue title="1"></orkestral:create-issue> then <orkestral:create-issue title="2"';
    expect(display(s)).toBe('A <orkestral:create-issue title="1"></orkestral:create-issue> then ');
  });

  it('nunca vaza markup parcial em NENHUM corte de chunk arbitrário', () => {
    const full = 'Intro <orkestral:create-issue title="x"></orkestral:create-issue> done';
    for (let n = 1; n <= full.length; n++) {
      const shown = display(full.slice(0, n));
      // Se o display mostra "<orkestral", então o componente COMPLETO está presente.
      if (shown.includes('<orkestral')) {
        expect(shown).toContain('</orkestral:create-issue>');
      }
    }
  });
});

describe('safeStreamDisplay — tokens veneno + buffer (P0-03)', () => {
  it('corta um bloco de hiring inteiro (mesmo completo)', () => {
    const s = 'Hiring: <orkestral:create-agent name="x"></orkestral:create-agent>';
    expect(safeStreamDisplay(s, HIRING)).toBe('Hiring: ');
  });

  it('corta um prefixo parcial do token de hiring no fim', () => {
    expect(safeStreamDisplay('before <orkestral:create-ag', HIRING)).toBe('before ');
  });

  it('é no-op pra texto normal', () => {
    const s = 'just a normal message';
    expect(safeStreamDisplay(s, HIRING)).toBe(s);
  });
});
