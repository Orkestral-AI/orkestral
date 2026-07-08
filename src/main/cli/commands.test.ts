import { describe, it, expect } from 'vitest';
import { parseInput, COMMANDS, COMMAND_GROUPS, buildHelpText } from './commands';

describe('parseInput', () => {
  it('texto normal → mensagem', () => {
    expect(parseInput('oi tudo bem')).toEqual({ kind: 'message', text: 'oi tudo bem' });
  });
  it('/new → comando new sem args', () => {
    expect(parseInput('/new')).toEqual({ kind: 'command', name: 'new', args: '' });
  });
  it('/model gpt-5 → comando model com args', () => {
    expect(parseInput('/model gpt-5')).toEqual({ kind: 'command', name: 'model', args: 'gpt-5' });
  });
  it('comando desconhecido → unknown', () => {
    expect(parseInput('/wat')).toEqual({ kind: 'unknown', name: 'wat' });
  });
  it('COMMANDS expõe os nomes esperados', () => {
    const names = COMMANDS.map((c) => c.name);
    for (const n of [
      'new',
      'resume',
      'clear',
      'compact',
      'help',
      'status',
      'model',
      'agent',
      'workspace',
      'config',
      'permissions',
      'channels',
      'cost',
      'exit',
    ])
      expect(names).toContain(n);
  });
});

describe('COMMAND_GROUPS / buildHelpText', () => {
  it('todo comando aparece em exatamente um grupo (nada some do /help)', () => {
    const grouped = COMMAND_GROUPS.flatMap((g) => g.names).sort();
    expect(grouped).toEqual(COMMANDS.map((c) => c.name).sort());
  });
  it('help lista todos os comandos com descrição, alinhados', () => {
    const text = buildHelpText();
    for (const c of COMMANDS) {
      expect(text).toContain(`/${c.name}`);
      expect(text).toContain(c.desc);
    }
    // Linhas de comando alinham a descrição na MESMA coluna (padEnd).
    const commandLines = text.split('\n').filter((l) => l.trimStart().startsWith('/'));
    const descColumns = new Set(
      commandLines.map((l) => {
        const afterName = l.trimEnd().replace(/^(\s*\/\S+\s+).*$/, '$1');
        return afterName.length;
      }),
    );
    expect(descColumns.size).toBe(1);
  });
});
