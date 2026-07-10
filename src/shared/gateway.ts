import type { IpcChannel } from './ipc-contract';

/**
 * Constantes do gateway web — compartilhadas entre o servidor HTTP (main) e o
 * web-bridge (renderer rodando num browser puro). Ficam em shared/ porque os
 * dois lados precisam concordar nos paths e na lista de canais indisponíveis.
 */

/** Porta padrão do gateway ("ORK" no teclado numérico = 675 + 0). */
export const GATEWAY_DEFAULT_PORT = 6750;

/** Prefixo REST: POST {API_IPC_PATH}/<canal> com body {"request": ...}. */
export const GATEWAY_API_IPC_PATH = '/api/ipc';

/** Stream SSE dos eventos push (pushBus): cada mensagem é {channel, payload}. */
export const GATEWAY_EVENTS_PATH = '/api/events';

/** Metadados do gateway (versão, canais registrados/indisponíveis). */
export const GATEWAY_INFO_PATH = '/api/gateway/info';

/**
 * Canais que NÃO fazem sentido fora do app desktop: dependem de janela nativa,
 * file picker do SO, Finder/Explorer, auto-update do Electron ou do microfone
 * da máquina onde o daemon roda. O gateway responde 403 com mensagem clara;
 * o restante do contrato (chat, issues, agents, git, terminal, docker…) roda
 * server-side e funciona no browser normalmente.
 */
export const GATEWAY_WEB_UNAVAILABLE_CHANNELS = [
  // janela/processo do app
  'app:quit',
  'window:minimize',
  'window:toggle-maximize',
  'window:close',
  'webview:set-devtools',
  // desktop pet — janela flutuante nativa, não existe no browser
  'pet:set-ignore-mouse',
  'pet:set-enabled',
  // pickers e integrações com o shell do SO (abrem NA MÁQUINA DO DAEMON)
  'dialog:open-directory',
  'dialog:open-file',
  'attachment:add-files',
  'attachment:open',
  'data:reveal',
  'shell:reveal',
  'shell:open-path',
  'source:reveal',
  // auto-update do app desktop (electron-updater)
  'update:download',
  'update:open',
  'update:quit-and-install',
  // ditado por voz usa o microfone local do desktop (smart-whisper)
  'voice:install',
  'voice:uninstall',
  'voice:dictation-start',
  'voice:dictation-tick',
  'voice:dictation-stop',
  'voice:dictation-cancel',
] as const satisfies readonly IpcChannel[];

export type GatewayWebUnavailableChannel = (typeof GATEWAY_WEB_UNAVAILABLE_CHANNELS)[number];

export function isWebUnavailableChannel(channel: string): boolean {
  return (GATEWAY_WEB_UNAVAILABLE_CHANNELS as readonly string[]).includes(channel);
}
