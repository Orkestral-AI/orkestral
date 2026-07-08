import type { ChatStreamEvent, MessagePart } from '../../shared/types';

/** Prefixo HH:MM das linhas do feed (cockpit e `serve --no-tui`). */
export function feedTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Máximo de caracteres da mensagem de canal exibida no feed. */
const CHANNEL_PREVIEW_MAX = 60;

/**
 * Traduz um evento do chatStreamBus numa linha LEGÍVEL do feed. Retorna null
 * pros eventos que não viram linha (deltas de texto/thinking, parts finais…).
 *
 * `user-message` só é emitido pelo chat-service quando a mensagem chegou por um
 * CANAL (origin 'channel' — WhatsApp/Telegram/Discord); o renderer não emite.
 * Por isso ele vira a linha `canal ◂ "…"` de entrada. Não há evento limpo de
 * SAÍDA pro canal (o envio é buffer interno do channel-manager), então o feed
 * não mostra outbound.
 */
export function formatFeedEvent(e: ChatStreamEvent): string | null {
  switch (e.type) {
    case 'message-start':
      return 'run ▸ iniciando…';
    case 'phase':
      return `run ▸ ${e.label ?? e.phase}`;
    case 'tool-call':
      return e.part.type === 'tool-call' ? `run ▸ tool: ${e.part.toolName}` : null;
    case 'message-end':
      if (e.status === 'done') return 'run ▸ concluído';
      if (e.status === 'cancelled') return 'run ▸ cancelado';
      return 'run ▸ falhou';
    case 'user-message': {
      const text = e.message.parts
        .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      const preview =
        text.length > CHANNEL_PREVIEW_MAX ? `${text.slice(0, CHANNEL_PREVIEW_MAX)}…` : text;
      return `canal ◂ "${preview}"`;
    }
    default:
      return null;
  }
}
