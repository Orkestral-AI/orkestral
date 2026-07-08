import { Client, GatewayIntentBits, Partials, Events, ChannelType, type Message } from 'discord.js';
import type { ChannelConnection, ChannelHandlers, InboundAttachment } from './channel-types';

/** Limite de tamanho de mensagem do Discord. */
const DISCORD_LIMIT = 2000;

/**
 * Conexão Discord (bot) via discord.js — equivalente ao cliente de gateway próprio
 * do openclaw. Mesma política: autentica por BOT TOKEN, intents Guilds +
 * GuildMessages + MessageContent (privilegiada) + DirectMessages; responde a DMs
 * e, em servidores, SÓ quando o bot é mencionado. Implementa o contrato comum de
 * canal pra reusar o roteamento inbound→agente e o streaming de saída.
 */
export class DiscordConnection implements ChannelConnection {
  private client: Client | null = null;
  private selfId = '';

  constructor(
    private readonly token: string,
    private readonly handlers: ChannelHandlers,
  ) {}

  async start(): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      // Channel partial: sem ele as DMs (canais não cacheados) não disparam evento.
      partials: [Partials.Channel, Partials.Message],
    });
    this.client = client;

    client.once(Events.ClientReady, (c) => {
      this.selfId = c.user.id;
      console.log('[discord] conectado como', c.user.tag);
      this.handlers.onConnected(c.user.tag);
    });
    client.on(Events.MessageCreate, (msg) => {
      void this.onMessage(msg).catch((err) =>
        console.error('[discord] erro no handler de mensagem:', err),
      );
    });
    client.on(Events.Error, (err) => this.handlers.onDisconnected(false, String(err)));

    try {
      await client.login(this.token);
    } catch (err) {
      // Falha de login (token inválido) = precisa de novo token → "logged out".
      this.handlers.onDisconnected(true, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async onMessage(msg: Message): Promise<void> {
    if (msg.author.bot) return; // ignora outros bots + a própria conta
    const isDM = msg.channel.type === ChannelType.DM;
    // Em servidores: só responde quando o bot é MENCIONADO (igual openclaw).
    if (!isDM && (!this.selfId || !msg.mentions.users.has(this.selfId))) return;

    let text = msg.content ?? '';
    if (this.selfId) {
      text = text.replace(new RegExp(`<@!?${this.selfId}>`, 'g'), '').trim();
    }

    const attachments: InboundAttachment[] = [];
    for (const att of msg.attachments.values()) {
      try {
        const res = await fetch(att.url);
        const buf = Buffer.from(await res.arrayBuffer());
        attachments.push({
          name: att.name || 'arquivo',
          mime: att.contentType || 'application/octet-stream',
          data: buf.toString('base64'),
        });
      } catch {
        /* anexo que falhou no download não bloqueia o texto */
      }
    }

    if (!text && attachments.length === 0) return;
    console.log(
      `[discord] msg de ${msg.author.id} (${msg.author.username}) texto="${text.slice(0, 40)}" anexos=${attachments.length}`,
    );
    this.handlers.onMessage({
      from: msg.channelId, // responde no mesmo canal/DM
      senderId: msg.author.id,
      displayName: msg.author.username,
      text,
      attachments,
    });
  }

  /** Resolve um canal de texto (canal de guild ou DM) pra enviar. */
  private async sendable(id: string): Promise<{
    send: (payload: unknown) => Promise<Message>;
    sendTyping: () => Promise<void>;
    messages: { fetch: (id: string) => Promise<Message> };
  }> {
    const ch = await this.client?.channels.fetch(id);
    if (!ch || !ch.isTextBased() || !('send' in ch)) {
      throw new Error('Canal do Discord não encontrado ou não enviável');
    }
    return ch as never;
  }

  private cap(text: string): string {
    return text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text;
  }

  async sendText(to: string, text: string): Promise<unknown> {
    const ch = await this.sendable(to);
    const sent = await ch.send(this.cap(text));
    return sent.id;
  }

  async editText(to: string, ref: unknown, text: string): Promise<void> {
    const ch = await this.sendable(to);
    const m = await ch.messages.fetch(String(ref));
    await m.edit(this.cap(text));
  }

  async sendMedia(
    to: string,
    buffer: Buffer,
    _mime: string,
    caption?: string,
    fileName?: string,
  ): Promise<void> {
    const ch = await this.sendable(to);
    await ch.send({
      content: caption || undefined,
      files: [{ attachment: buffer, name: fileName || 'arquivo' }],
    });
  }

  async sendTyping(to: string): Promise<void> {
    try {
      const ch = await this.sendable(to);
      await ch.sendTyping();
    } catch {
      /* presença é best-effort */
    }
  }

  async fetchProfilePhoto(userId: string): Promise<string | null> {
    try {
      const u = await this.client?.users.fetch(userId);
      return u?.displayAvatarURL({ size: 256 }) ?? null;
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.client?.destroy();
    } catch {
      /* já destruído */
    }
    this.client = null;
  }

  async logout(): Promise<void> {
    await this.stop();
  }
}
