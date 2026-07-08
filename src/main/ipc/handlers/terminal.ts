import { registerHandler } from '../register';
import {
  createTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  listTerminals,
} from '../../services/terminal-service';

export function registerTerminalHandlers(): void {
  registerHandler('terminal:create', ({ cwd, cols, rows, meta }) =>
    createTerminal({ cwd, cols, rows, meta }),
  );
  // Re-attach pós-reload: o renderer lista os PTYs vivos no main e restaura as abas.
  registerHandler('terminal:list', () => listTerminals());
  registerHandler('terminal:input', ({ id, data }) => {
    writeTerminal(id, data);
    return { ok: true as const };
  });
  registerHandler('terminal:resize', ({ id, cols, rows }) => {
    resizeTerminal(id, cols, rows);
    return { ok: true as const };
  });
  registerHandler('terminal:kill', ({ id }) => {
    killTerminal(id);
    return { ok: true as const };
  });
}
