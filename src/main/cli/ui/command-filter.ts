import { COMMANDS, type CommandDef } from '../commands';

/**
 * Filtra os COMMANDS pelo texto digitado depois da `/`. Prioriza prefixo
 * (quem começa com a query vem primeiro), com fallback pra "fuzzy-contains"
 * (a query aparece em qualquer posição do nome). Vazio = todos os comandos.
 */
export function filterCommands(query: string): CommandDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMANDS;
  const prefix = COMMANDS.filter((c) => c.name.startsWith(q));
  const contains = COMMANDS.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...prefix, ...contains];
}
