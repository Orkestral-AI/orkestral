import { Bot, InputFile, InlineKeyboard, type Context } from 'grammy';
import type {
  ChannelConnection,
  ChannelHandlers,
  InboundChannelMessage,
  ChannelChoice,
} from './channel-types';

/** Limite de botões inline antes de cair pro texto numerado (UX + sanidade). */
const TELEGRAM_MAX_BUTTONS = 12;

/**
 * Conexão Telegram — lib `grammy`, **bot token** do BotFather e **long-polling**
 * (getUpdates). Sem QR: o token já autentica. Conforma à interface genérica
 * `ChannelConnection` (igual WhatsApp/Discord) — emite `InboundChannelMessage`,
 * então roteamento inbound→agente e streaming por edição são os mesmos.
 *
 * `from`/`senderId` = id numérico do chat/usuário do Telegram (dígitos), o que casa
 * direto com a allowlist (também dígitos).
 */
export class TelegramConnection implements ChannelConnection {
  private bot: Bot | null = null;
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly handlers: ChannelHandlers,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    const bot = new Bot(this.token);
    this.bot = bot;

    bot.catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.handlers.onDisconnected(false, msg);
    });

    // Só chats privados (DM) no MVP — espelha o "mensagens privadas com seu agente".
    bot.on('message:text', (ctx: Context) => {
      if (ctx.chat?.type !== 'private') return;
      const from = ctx.chat?.id != null ? String(ctx.chat.id) : null;
      const text = ctx.message?.text ?? '';
      if (!from || !text) return;
      const senderId = ctx.from?.id != null ? String(ctx.from.id) : from;
      const name =
        [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim() ||
        ctx.from?.username ||
        null;
      const msg: InboundChannelMessage = {
        from,
        senderId: senderId.replace(/\D/g, ''),
        displayName: name,
        text,
        attachments: [],
      };
      this.handlers.onMessage(msg);
    });

    // Cliques em botões inline (ex.: escolha de workspace). answerCallbackQuery tira
    // o "loading" do botão; o callback data vira a escolha (vai pro onChoice).
    bot.on('callback_query:data', async (ctx) => {
      const from = ctx.chat?.id != null ? String(ctx.chat.id) : null;
      const data = ctx.callbackQuery.data;
      await ctx.answerCallbackQuery().catch(() => undefined);
      if (from && data) this.handlers.onChoice?.(from, data);
    });

    // Valida o token antes de subir o polling (token errado = erro claro, não silêncio).
    try {
      const me = await bot.api.getMe();
      const selfLabel = me.username ? `@${me.username}` : String(me.id);
      // bot.start() resolve só quando para — NÃO await. onStart confirma o polling.
      void bot
        .start({
          drop_pending_updates: true,
          onStart: () => {
            if (!this.stopped) this.handlers.onConnected(selfLabel);
          },
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.handlers.onDisconnected(/401|unauthorized/i.test(msg), msg);
        });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.handlers.onDisconnected(/401|unauthorized/i.test(msg), msg);
      throw err;
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot?.api.sendChatAction(Number(chatId), 'typing').catch(() => undefined);
  }

  /** Botões inline (1 por linha) até TELEGRAM_MAX_BUTTONS; acima disso devolve false
   *  pro manager mandar texto numerado. Cada clique volta em onChoice com o `id`. */
  async sendChoices(chatId: string, question: string, choices: ChannelChoice[]): Promise<boolean> {
    if (!this.bot || choices.length === 0 || choices.length > TELEGRAM_MAX_BUTTONS) return false;
    const kb = new InlineKeyboard();
    for (const c of choices) kb.text(c.label, c.id).row();
    await this.bot.api.sendMessage(Number(chatId), question, { reply_markup: kb });
    return true;
  }

  /** Envia texto e devolve o message_id (ref pra editar no streaming). */
  async sendText(chatId: string, text: string): Promise<unknown | null> {
    if (!this.bot) return null;
    const m = await this.bot.api.sendMessage(Number(chatId), text);
    return m.message_id;
  }

  /** Edita uma mensagem já enviada (streaming por edição, igual WhatsApp). */
  async editText(chatId: string, ref: unknown, text: string): Promise<void> {
    if (!this.bot || ref == null) return;
    const messageId = Number(ref);
    // Telegram rejeita edição com texto idêntico ou mensagem antiga — best-effort.
    await this.bot.api.editMessageText(Number(chatId), messageId, text).catch(() => undefined);
  }

  async sendMedia(
    chatId: string,
    buffer: Buffer,
    mime: string,
    caption?: string,
    fileName = 'file',
  ): Promise<void> {
    if (!this.bot) return;
    const file = new InputFile(buffer, fileName);
    const target = Number(chatId);
    if (mime.startsWith('image/')) {
      await this.bot.api.sendPhoto(target, file, caption ? { caption } : undefined);
    } else if (mime.startsWith('video/')) {
      await this.bot.api.sendVideo(target, file, caption ? { caption } : undefined);
    } else {
      await this.bot.api.sendDocument(target, file, caption ? { caption } : undefined);
    }
  }

  /** Telegram não expõe foto de perfil simples por chat — no-op (mantém interface). */
  async fetchProfilePhoto(): Promise<string | null> {
    return null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.bot?.stop().catch(() => undefined);
    this.bot = null;
  }

  async logout(): Promise<void> {
    this.stopped = true;
    // logOut invalida o token no servidor do Telegram (desvincula o bot deste host).
    await this.bot?.api.logOut().catch(() => undefined);
    await this.bot?.stop().catch(() => undefined);
    this.bot = null;
  }
}
