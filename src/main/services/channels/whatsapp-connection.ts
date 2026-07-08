import { mkdirSync } from 'node:fs';
import type { InboundAttachment, ChannelHandlers, ChannelConnection } from './channel-types';
import {
  makeWASocket,
  // Renomeado: NÃO é um React hook (só tem prefixo "use"); o alias evita o
  // falso-positivo da regra react-hooks/rules-of-hooks num arquivo do main.
  useMultiFileAuthState as loadMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
  type proto,
} from 'baileys';

/**
 * Logger no-op que satisfaz a interface que o Baileys (e o
 * makeCacheableSignalKeyStore) esperam, sem puxar `pino` como dependência.
 */
interface BaileysLogger {
  level: string;
  child: (obj: unknown) => BaileysLogger;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
}

function makeSilentLogger(): BaileysLogger {
  const noop = (): void => {};
  const logger: BaileysLogger = {
    level: 'silent',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  return logger;
}

/** Wrappers que embrulham a mensagem real (temporária, ver-uma-vez, etc.). */
const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'botInvokeMessage',
  'groupMentionedMessage',
] as const;

/** Desembrulha mensagens em cadeia até o conteúdo real (igual openclaw). */
function unwrapMessage(
  message: proto.IMessage | null | undefined,
): proto.IMessage | null | undefined {
  let current = message;
  for (let i = 0; i < 6 && current; i++) {
    const rec = current as Record<string, { message?: proto.IMessage }>;
    const key = WRAPPER_KEYS.find((k) => rec[k]);
    if (!key) break;
    const inner = rec[key]?.message;
    if (!inner) break;
    current = inner;
  }
  return current;
}

/** Texto puro ou caption da mídia (desembrulhando temporárias/ver-uma-vez). */
function extractText(raw: proto.IMessage | null | undefined): string {
  const message = unwrapMessage(raw);
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

/** Nó de mídia + mime, se a mensagem carregar um anexo suportado. */
function mediaInfo(
  raw: proto.IMessage | null | undefined,
): { mime: string; fileName?: string } | null {
  const message = unwrapMessage(raw);
  if (!message) return null;
  if (message.imageMessage) return { mime: message.imageMessage.mimetype || 'image/jpeg' };
  if (message.videoMessage) return { mime: message.videoMessage.mimetype || 'video/mp4' };
  if (message.audioMessage) return { mime: message.audioMessage.mimetype || 'audio/ogg' };
  if (message.documentMessage)
    return {
      mime: message.documentMessage.mimetype || 'application/octet-stream',
      fileName: message.documentMessage.fileName || undefined,
    };
  if (message.stickerMessage) return { mime: message.stickerMessage.mimetype || 'image/webp' };
  return null;
}

function defaultName(mime: string): string {
  const ext = mime.split('/')[1]?.split(';')[0] || 'bin';
  const kind = mime.startsWith('image')
    ? 'imagem'
    : mime.startsWith('video')
      ? 'video'
      : mime.startsWith('audio')
        ? 'audio'
        : 'arquivo';
  return `whatsapp-${kind}.${ext}`;
}

/**
 * Conexão WhatsApp de UMA conta via Baileys. Espelha o openclaw: multi-file auth
 * state em disco (cria QR quando o authDir está vazio, reconecta sem QR quando já
 * existe), evento `connection.update` pra QR/estado e `messages.upsert` pra
 * entrada. Reconexão com backoff simples; logout (401) para de tentar.
 */
/**
 * Converte o Markdown que os modelos cospem por hábito pra formatação do WhatsApp:
 * negrito no WhatsApp é UM asterisco (`*x*`), não dois (`**x**`). Sem isso o
 * WhatsApp mostra os `*` soltos e quebra o visual da mensagem. (No Discord o
 * Markdown `**` é o certo, então essa conversão vive só aqui, na conexão WhatsApp.)
 */
/** Teto de tamanho da mensagem do WhatsApp. SAFETY-NET: o protocolo já manda o agente
 *  ser conciso, mas se escapar uma spec/plano gigante, uma mensagem de 5 mil linhas no
 *  celular é ilegível — corta com aviso. (Bem abaixo do limite duro de ~65k do WhatsApp.) */
const WHATSAPP_MAX_CHARS = 1500;

function toWhatsAppFormat(text: string): string {
  const formatted = text
    .replace(/\*\*([^\n*]+?)\*\*/g, '*$1*') // **negrito** → *negrito*
    .replace(/__([^\n_]+?)__/g, '*$1*') // __negrito__ → *negrito*
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '*$1*'); // # Título → *Título*
  if (formatted.length <= WHATSAPP_MAX_CHARS) return formatted;
  // Corta num limite de parágrafo/linha pra não cortar no meio de uma palavra.
  const head = formatted.slice(0, WHATSAPP_MAX_CHARS);
  const cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), WHATSAPP_MAX_CHARS - 200);
  return head.slice(0, cut).trimEnd() + '\n\n_…(mensagem longa — veja os detalhes no app)_';
}

export class WhatsAppConnection implements ChannelConnection {
  private sock: WASocket | null = null;
  private readonly logger = makeSilentLogger();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Quando a conexão abriu (ms) — pra ignorar mensagens antigas no replay. */
  private onlineSince = 0;

  constructor(
    private readonly authDir: string,
    private readonly handlers: ChannelHandlers,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await loadMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger as never),
      },
      logger: this.logger as never,
      printQRInTerminal: false,
      browser: ['Orkestral', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) this.handlers.onQr?.(qr);
      if (connection === 'open') {
        this.reconnectAttempts = 0;
        if (!this.onlineSince) this.onlineSince = Date.now();
        console.log('[wa] conectado como', sock.user?.id ?? '?');
        this.handlers.onConnected(sock.user?.id ?? null);
      }
      if (connection === 'close') {
        // O erro do Baileys é um Boom; lemos o statusCode sem importar @hapi/boom
        // (dependência transitiva — tipamos a forma mínima inline).
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;

        if (status === DisconnectReason.loggedOut) {
          this.handlers.onDisconnected(true, null);
          return;
        }

        // 515 (restartRequired) é ESPERADO logo após o pareamento: o WhatsApp
        // manda reiniciar o stream. NÃO é erro — reconecta na hora, sem backoff
        // nem contar como falha, mantendo o status 'connecting' (sem mostrar erro).
        if (status === DisconnectReason.restartRequired && !this.stopped) {
          void this.start().catch(() => {
            if (!this.stopped) this.scheduleReconnect();
          });
          return;
        }

        // Queda inesperada — reporta e tenta reconectar com backoff.
        const errMsg = lastDisconnect?.error ? String(lastDisconnect.error) : null;
        this.handlers.onDisconnected(false, errMsg);
        if (!this.stopped) this.scheduleReconnect();
      }
    });

    sock.ev.on('messages.upsert', (upsert) => {
      // Aceita 'notify' (tempo real) E 'append' — device recém-vinculado às vezes
      // entrega mensagens como 'append'. (Igual ao openclaw.)
      if (upsert.type !== 'notify' && upsert.type !== 'append') return;
      console.log('[wa] upsert', upsert.type, 'n=', upsert.messages.length);
      for (const msg of upsert.messages) {
        const jid = msg.key.remoteJid;
        if (!jid) continue;
        console.log(
          '[wa] msg jid=',
          jid,
          'fromMe=',
          msg.key.fromMe,
          'tipos=',
          Object.keys(msg.message ?? {}),
        );
        // MVP: só DM. Ignora a própria mensagem, grupos, status/broadcast, newsletter.
        if (msg.key.fromMe) continue;
        if (jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid === 'status@broadcast')
          continue;
        // Aceita DM em @s.whatsapp.net E @lid (formato novo do WhatsApp).
        if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
        // Ignora replay de mensagens ANTIGAS no boot/reconexão (evita responder a
        // conversas que já existiam quando o número foi vinculado). 10s de folga.
        const tsMs = Number(msg.messageTimestamp ?? 0) * 1000;
        if (tsMs && this.onlineSince && tsMs < this.onlineSince - 10_000) continue;
        void this.ingest(jid, msg);
      }
    });
  }

  /** Normaliza uma mensagem (texto + mídia baixada) e entrega ao handler. */
  private async ingest(jid: string, msg: WAMessage): Promise<void> {
    const text = extractText(msg.message).trim();
    const attachments: InboundAttachment[] = [];
    const media = mediaInfo(msg.message);
    if (media) {
      try {
        const buffer = (await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: this.logger as never,
            reuploadRequest: this.sock!.updateMediaMessage,
          },
        )) as Buffer;
        attachments.push({
          name: media.fileName || defaultName(media.mime),
          mime: media.mime,
          data: buffer.toString('base64'),
        });
      } catch {
        /* falha de download não bloqueia o texto/caption */
      }
    }
    if (!text && attachments.length === 0) {
      console.log('[wa] msg sem texto/anexo após desembrulhar, ignorada');
      return;
    }
    const senderId = await this.resolveNumber(jid);
    console.log(
      `[wa] msg de ${jid} (num=${senderId}) texto="${text.slice(0, 40)}" anexos=${attachments.length}`,
    );
    this.handlers.onMessage({
      from: jid,
      senderId,
      displayName: msg.pushName ?? null,
      text,
      attachments,
    });
  }

  /**
   * Número de telefone (dígitos) de um JID. Pra '@s.whatsapp.net' é direto; pra
   * '@lid' (ID opaco do WhatsApp novo) resolve via lidMapping do Baileys — sem
   * isso a allowlist nunca casaria, porque o @lid não é o número.
   */
  private async resolveNumber(jid: string): Promise<string> {
    const digits = (s: string): string => s.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!jid.endsWith('@lid')) return digits(jid);
    try {
      const mapping = (
        this.sock as unknown as {
          signalRepository?: {
            lidMapping?: { getPNForLID?: (j: string) => Promise<string | null> };
          };
        }
      )?.signalRepository?.lidMapping;
      const pn = await mapping?.getPNForLID?.(jid);
      if (pn) return digits(pn);
    } catch {
      /* sem mapping → cai no fallback (dígitos do lid) */
    }
    return digits(jid);
  }

  /** URL da foto de perfil do contato (null se privada/indisponível). */
  async fetchProfilePhoto(jid: string): Promise<string | null> {
    try {
      return (await this.sock?.profilePictureUrl(jid, 'image')) ?? null;
    } catch {
      return null;
    }
  }

  /** Envia uma indicação de "digitando…" pro contato (feedback de fluidez). */
  async sendTyping(toJid: string): Promise<void> {
    try {
      await this.sock?.sendPresenceUpdate('composing', toJid);
    } catch {
      /* presença é best-effort */
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 5) return;
    const delay = Math.min(2000 * 1.5 ** (this.reconnectAttempts - 1), 60000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start().catch(() => {
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  /** Envia texto e retorna a key da mensagem (pra editar depois / simular stream). */
  async sendText(toJid: string, text: string): Promise<unknown> {
    if (!this.sock) throw new Error('WhatsApp não conectado');
    const res = await this.sock.sendMessage(toJid, { text: toWhatsAppFormat(text) });
    return res?.key ?? null;
  }

  /** Edita uma mensagem já enviada (modo de edição do WhatsApp). */
  async editText(toJid: string, ref: unknown, text: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp não conectado');
    await this.sock.sendMessage(toJid, { text: toWhatsAppFormat(text), edit: ref as WAMessageKey });
  }

  /** Envia mídia (imagem como imagem; resto como documento) com legenda opcional. */
  async sendMedia(
    toJid: string,
    buffer: Buffer,
    mime: string,
    caption?: string,
    fileName?: string,
  ): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp não conectado');
    const cap = caption ? toWhatsAppFormat(caption) : undefined;
    if (mime.startsWith('image/')) {
      await this.sock.sendMessage(toJid, { image: buffer, caption: cap, mimetype: mime });
    } else if (mime.startsWith('video/')) {
      await this.sock.sendMessage(toJid, { video: buffer, caption: cap, mimetype: mime });
    } else if (mime.startsWith('audio/')) {
      await this.sock.sendMessage(toJid, { audio: buffer, mimetype: mime });
    } else {
      await this.sock.sendMessage(toJid, {
        document: buffer,
        mimetype: mime,
        fileName: fileName || 'arquivo',
        caption: cap,
      });
    }
  }

  /** Para a conexão sem revogar a sessão (reconectável no boot). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.sock?.end(undefined);
    } catch {
      /* socket já morto */
    }
    this.sock = null;
  }

  /** Revoga a sessão no WhatsApp (Dispositivos conectados) e encerra. */
  async logout(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.sock?.logout();
    } catch {
      /* já desconectado */
    }
    this.sock = null;
  }
}
