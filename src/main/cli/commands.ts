export interface CommandDef {
  name: string;
  desc: string;
}

export const COMMANDS: CommandDef[] = [
  { name: 'new', desc: 'nova conversa' },
  { name: 'resume', desc: 'retomar outra conversa' },
  { name: 'clear', desc: 'limpa a conversa atual' },
  { name: 'compact', desc: 'compacta o contexto' },
  { name: 'help', desc: 'lista comandos' },
  { name: 'status', desc: 'estado do orkestral' },
  { name: 'model', desc: 'lista/troca o modelo' },
  { name: 'agent', desc: 'lista/troca o agente' },
  { name: 'workspace', desc: 'troca o workspace' },
  { name: 'config', desc: 'edita configs' },
  { name: 'permissions', desc: 'modo de permissão' },
  { name: 'channels', desc: 'conectar/listar canais' },
  { name: 'cost', desc: 'tokens e custo da sessão' },
  { name: 'exit', desc: 'sai' },
];

/**
 * Agrupamento dos comandos pro `/help` — todo comando de COMMANDS precisa
 * aparecer em exatamente um grupo (guardado por teste), senão some do help.
 */
export const COMMAND_GROUPS: { label: string; names: string[] }[] = [
  { label: 'Conversa', names: ['new', 'resume', 'clear', 'compact'] },
  { label: 'Config', names: ['model', 'agent', 'workspace', 'config', 'permissions'] },
  { label: 'Canais', names: ['channels'] },
  { label: 'Outros', names: ['help', 'status', 'cost', 'exit'] },
];

/** Largura da coluna `/nome` alinhada pelo comando mais longo (+2 de respiro). */
export function commandColumnWidth(): number {
  return Math.max(...COMMANDS.map((c) => c.name.length)) + 1 + 2; // +1 da `/`
}

/**
 * Texto do `/help` pro transcript (note turn): comandos AGRUPADOS, nomes
 * alinhados por padEnd e descrição na mesma linha. Primeira linha é o título
 * ("comandos") — o REPL renderiza a nota multi-linha com indent consistente.
 */
export function buildHelpText(): string {
  const width = commandColumnWidth();
  const lines: string[] = ['comandos'];
  for (const group of COMMAND_GROUPS) {
    lines.push(`${group.label}:`);
    for (const name of group.names) {
      const cmd = COMMANDS.find((c) => c.name === name);
      if (cmd) lines.push(`  /${cmd.name.padEnd(width - 1)}${cmd.desc}`);
    }
  }
  return lines.join('\n');
}

export type ParsedInput =
  | { kind: 'message'; text: string }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'unknown'; name: string };

export function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return { kind: 'message', text: trimmed };
  const [token, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = token.toLowerCase();
  if (!COMMANDS.some((c) => c.name === name)) return { kind: 'unknown', name };
  return { kind: 'command', name, args: rest.join(' ') };
}
