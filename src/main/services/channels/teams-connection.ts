import type { Server } from 'node:http';
import type { ChannelConnection, ChannelHandlers, InboundAttachment } from './channel-types';

/**
 * Conexão Microsoft Teams (bot) via Bot Framework / Teams SDK 2.0
 * (`@microsoft/teams.apps` + `@microsoft/teams.api`) — espelha o plugin msteams
 * do openclaw. Diferente de WhatsApp/Discord (que conectam PRA FORA), o Teams é
 * webhook: a Microsoft faz POST das activities num endpoint HTTP público. Aqui
 * subimos um servidor Express LOCAL em `/api/messages` (o usuário expõe via túnel
 * e registra a URL no Azure Bot Service). Mesma política do openclaw: DM responde
 * sempre; em canal/grupo só quando o bot é MENCIONADO; allowlist por usuário
 * (AAD id / e-mail). A saída usa proactive messaging via Bot Connector, guardando
 * o ConversationReference recebido no inbound — e o streaming é simulado editando
 * a mensagem (igual aos outros canais).
 */

/** Credenciais do app registrado no Azure Bot Service. */
export interface TeamsCreds {
  appId: string;
  appPassword: string;
  tenantId: string;
  /** Porta do servidor de bot local (default 3978, igual openclaw). */
  port?: number;
  /** ID do app Teams (manifesto) — usado pra reapontar o endpoint quando a URL
   *  do túnel muda. Preenchido pelo "Criar app"; ausente no preenchimento manual. */
  teamsAppId?: string;
}

export const TEAMS_DEFAULT_PORT = 3978;
/** Limite de tamanho de mensagem do Teams. */
const TEAMS_LIMIT = 4000;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ---- Tipos estruturais do SDK -----------------------------------------------
// As declarações profundas do @microsoft/teams.api não resolvem de forma estável
// em todo tsconfig (hashed .d.ts atrás de `export *`), então modelamos só a
// superfície que usamos — mesma estratégia do openclaw (ver extensions/msteams/src/sdk.ts).

interface TeamsAccountRef {
  id?: string;
  name?: string;
  aadObjectId?: string;
}

interface TeamsActivity {
  type?: string;
  id?: string;
  text?: string;
  from?: TeamsAccountRef;
  recipient?: TeamsAccountRef;
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  entities?: Array<{ type?: string; mentioned?: { id?: string } }>;
  attachments?: Array<{
    contentType?: string;
    contentUrl?: string;
    content?: unknown;
    name?: string;
  }>;
  channelData?: { tenant?: { id?: string } };
  serviceUrl?: string;
}

interface TeamsActivitiesClient {
  create(activity: unknown): Promise<{ id?: string }>;
  update(activityId: string, activity: unknown): Promise<unknown>;
  delete(activityId: string): Promise<unknown>;
}

interface TeamsApiClient {
  serviceUrl?: string;
  http?: unknown;
  conversations: { activities(conversationId: string): TeamsActivitiesClient };
}

interface TeamsApp {
  on(name: string, cb: (ctx: { activity: TeamsActivity }) => unknown): unknown;
  initialize(): Promise<void>;
  api: TeamsApiClient;
  tokenManager: { getBotToken(): Promise<unknown>; getGraphToken(): Promise<unknown> };
}

/** Referência de conversa guardada no inbound, usada pra responder (proactive). */
interface StoredRef {
  conversationId: string;
  conversationType?: string;
  serviceUrl?: string;
  tenantId?: string;
  /** `recipient` do inbound = a identidade do NOSSO bot. */
  bot?: TeamsAccountRef;
  /** `from` do inbound = o interlocutor. */
  user?: TeamsAccountRef;
}

/** Remove as tags `<at>...</at>` que o Teams usa pra menção (igual openclaw). */
function stripMentionTags(text: string): string {
  return text.replace(/<at[^>]*>.*?<\/at>/gi, '').trim();
}

/** O bot foi mencionado? (entities[].mentioned.id === recipient.id). */
function wasMentioned(a: TeamsActivity): boolean {
  const botId = a.recipient?.id;
  if (!botId) return false;
  return (a.entities ?? []).some((e) => e.type === 'mention' && e.mentioned?.id === botId);
}

function tokenToString(token: unknown): string {
  if (token == null) return '';
  return (token as { toString(): string }).toString();
}

function normalizeServiceUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString().replace(/\/+$/, '');
  } catch {
    return url.replace(/\/+$/, '');
  }
}

function sameServiceUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeServiceUrl(a) === normalizeServiceUrl(b);
}

export class TeamsConnection implements ChannelConnection {
  private app: TeamsApp | null = null;
  private server: Server | null = null;
  /** ConversationReference por conversationId — a resposta sempre segue um inbound. */
  private readonly refByConversation = new Map<string, StoredRef>();
  /** Cache aadObjectId → e-mail (resolvido via Graph, pra casar com a allowlist). */
  private readonly emailByAad = new Map<string, string>();

  constructor(
    private readonly creds: TeamsCreds,
    private readonly handlers: ChannelHandlers,
  ) {}

  async start(): Promise<void> {
    const express = (await import('express')).default;
    // Importado dinamicamente pra não pesar o boot quando o canal está parado.
    const { App, ExpressAdapter } = (await import('@microsoft/teams.apps')) as unknown as {
      App: new (opts: Record<string, unknown>) => TeamsApp;
      ExpressAdapter: new (server: unknown) => unknown;
    };

    const expressApp = express();
    // Gate barato: rejeita requisições sem Bearer antes do parse (igual openclaw).
    // O SDK faz a validação completa do JWT na rota registrada.
    expressApp.use((req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
    expressApp.use(express.json({ limit: '4mb' }));

    const app = new App({
      clientId: this.creds.appId,
      clientSecret: this.creds.appPassword,
      tenantId: this.creds.tenantId,
      httpServerAdapter: new ExpressAdapter(expressApp),
      messagingEndpoint: '/api/messages',
    });
    this.app = app;

    // Catch-all de activities (igual openclaw): filtramos `message` aqui dentro.
    app.on('activity', (ctx) => {
      void this.onInbound(ctx.activity).catch((err) =>
        console.error('[teams] erro no handler de activity:', err),
      );
    });

    try {
      // Registra a rota POST no Express e prepara a validação de JWT.
      await app.initialize();
    } catch (err) {
      // Falha de init = credenciais inválidas → precisa reconfigurar ("logged out").
      this.app = null;
      this.handlers.onDisconnected(true, err instanceof Error ? err.message : String(err));
      throw err;
    }

    const port = this.creds.port ?? TEAMS_DEFAULT_PORT;
    await new Promise<void>((resolve, reject) => {
      const server = expressApp.listen(port);
      this.server = server;
      server.once('listening', () => {
        console.log('[teams] servidor de bot ouvindo na porta', port);
        resolve();
      });
      server.once('error', (err: Error) => {
        this.server = null;
        reject(err);
      });
    });

    // O bot está de pé e pronto pra receber. Não há "número próprio" como no
    // WhatsApp — a identidade é o App ID.
    this.handlers.onConnected(this.creds.appId);
  }

  // ---- Entrada ---------------------------------------------------------------

  private async onInbound(a: TeamsActivity): Promise<void> {
    if (a.type && a.type !== 'message') return;
    const conversationId = a.conversation?.id;
    if (!conversationId) return;

    const conversationType = a.conversation?.conversationType;
    const isDM = conversationType === 'personal';
    // Em canal/grupo: só responde quando o bot é MENCIONADO (igual openclaw/discord).
    if (!isDM && !wasMentioned(a)) return;

    const text = stripMentionTags(a.text ?? '');
    const attachments = await this.downloadAttachments(a);
    if (!text && attachments.length === 0) return;

    // Guarda a referência pra responder nessa conversa (proactive/streaming).
    this.refByConversation.set(conversationId, {
      conversationId,
      conversationType,
      serviceUrl: a.serviceUrl,
      tenantId: a.channelData?.tenant?.id ?? a.conversation?.tenantId,
      bot: a.recipient,
      user: a.from,
    });

    // E-mail do remetente (pra allowlist por e-mail, além do AAD id).
    const aad = a.from?.aadObjectId;
    const aliases: string[] = [];
    if (aad) {
      const email = await this.resolveEmail(aad);
      if (email) aliases.push(email);
    }

    console.log(
      `[teams] msg de ${a.from?.name ?? '?'} (aad=${aad ?? '?'}) conv=${conversationType} texto="${text.slice(0, 40)}" anexos=${attachments.length}`,
    );
    this.handlers.onMessage({
      from: conversationId,
      senderId: aad ?? a.from?.id ?? conversationId,
      senderAliases: aliases.length > 0 ? aliases : undefined,
      displayName: a.from?.name ?? null,
      text,
      attachments,
    });
  }

  /** Baixa os anexos de uma activity (imagem inline, data URL, arquivo do Teams). */
  private async downloadAttachments(a: TeamsActivity): Promise<InboundAttachment[]> {
    const out: InboundAttachment[] = [];
    for (const att of a.attachments ?? []) {
      const ct = (att.contentType ?? '').toLowerCase();
      try {
        // Arquivo enviado pelo Teams: o downloadUrl já vem pré-autenticado.
        if (ct === 'application/vnd.microsoft.teams.file.download.info') {
          const content = (att.content ?? {}) as { downloadUrl?: string; fileName?: string };
          if (!content.downloadUrl) continue;
          const res = await fetch(content.downloadUrl);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          out.push({
            name: att.name || content.fileName || 'arquivo',
            mime: res.headers.get('content-type') || 'application/octet-stream',
            data: buf.toString('base64'),
          });
          continue;
        }
        const url = att.contentUrl;
        if (!url) continue;
        // Imagem inline em data URL.
        if (url.startsWith('data:')) {
          const [meta, b64] = url.split(',', 2);
          if (!b64) continue;
          const mime = meta.slice(5).split(';')[0] || ct || 'application/octet-stream';
          out.push({ name: att.name || 'imagem', mime, data: b64 });
          continue;
        }
        // Imagem/arquivo hospedado: fetch direto e, se 401/403, com bot token.
        const buf = await this.fetchWithBotAuth(url);
        if (!buf) continue;
        out.push({
          name: att.name || 'arquivo',
          mime: ct || 'application/octet-stream',
          data: buf.toString('base64'),
        });
      } catch {
        /* anexo que falhou no download não bloqueia o texto */
      }
    }
    return out;
  }

  /** Fetch que tenta sem auth e, em 401/403, repete com o bot token (Bot Connector). */
  private async fetchWithBotAuth(url: string): Promise<Buffer | null> {
    const first = await fetch(url);
    if (first.ok) return Buffer.from(await first.arrayBuffer());
    if (first.status !== 401 && first.status !== 403) return null;
    try {
      const token = tokenToString(await this.app?.tokenManager.getBotToken());
      if (!token) return null;
      const retry = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!retry.ok) return null;
      return Buffer.from(await retry.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** E-mail/UPN do usuário via Graph (best-effort, cacheado) — pra allowlist. */
  private async resolveEmail(aadObjectId: string): Promise<string | null> {
    const cached = this.emailByAad.get(aadObjectId);
    if (cached !== undefined) return cached || null;
    try {
      const token = tokenToString(await this.app?.tokenManager.getGraphToken());
      if (!token) return null;
      const res = await fetch(
        `${GRAPH_BASE}/users/${encodeURIComponent(aadObjectId)}?$select=mail,userPrincipalName`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        this.emailByAad.set(aadObjectId, '');
        return null;
      }
      const data = (await res.json()) as { mail?: string; userPrincipalName?: string };
      const email = (data.mail || data.userPrincipalName || '').toLowerCase();
      this.emailByAad.set(aadObjectId, email);
      return email || null;
    } catch {
      return null;
    }
  }

  // ---- Saída -----------------------------------------------------------------

  /** Cliente de activities pra serviceUrl da referência (constrói um se diferir). */
  private async activitiesFor(ref: StoredRef): Promise<TeamsActivitiesClient> {
    if (!this.app) throw new Error('Teams não conectado');
    const api = this.app.api;
    if (!ref.serviceUrl || sameServiceUrl(api.serviceUrl, ref.serviceUrl)) {
      return api.conversations.activities(ref.conversationId);
    }
    // serviceUrl diferente do default do app → constrói um Client pra ele
    // (mesma lógica do sdk-proactive.ts do openclaw), reusando o http auth do app.
    const httpClient = api.http ?? (this.app as unknown as { client?: unknown }).client;
    if (!httpClient) return api.conversations.activities(ref.conversationId);
    const { Client } = (await import('@microsoft/teams.api')) as unknown as {
      Client: new (serviceUrl: string, http: unknown) => TeamsApiClient;
    };
    const client = new Client(normalizeServiceUrl(ref.serviceUrl), httpClient);
    return client.conversations.activities(ref.conversationId);
  }

  private cap(text: string): string {
    return text.length > TEAMS_LIMIT ? `${text.slice(0, TEAMS_LIMIT - 1)}…` : text;
  }

  /**
   * Activity de mensagem com a referência embutida pro Bot Connector rotear o
   * envio proactive (tenant é obrigatório em DM 1:1, senão dá 403 — igual openclaw).
   */
  private buildActivity(ref: StoredRef, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      channelId: 'msteams',
      ...(ref.bot ? { from: ref.bot } : {}),
      ...(ref.user ? { recipient: ref.user } : {}),
      conversation: {
        id: ref.conversationId,
        ...(ref.conversationType ? { conversationType: ref.conversationType } : {}),
        ...(ref.tenantId ? { tenantId: ref.tenantId } : {}),
      },
      ...(ref.serviceUrl ? { serviceUrl: ref.serviceUrl } : {}),
      ...(ref.tenantId
        ? { channelData: { tenant: { id: ref.tenantId } }, tenantId: ref.tenantId }
        : {}),
      ...extra,
    };
  }

  async sendText(to: string, text: string): Promise<unknown> {
    const ref = this.refByConversation.get(to);
    if (!ref) throw new Error(`Sem referência de conversa do Teams para ${to}`);
    const activities = await this.activitiesFor(ref);
    const res = await activities.create(
      this.buildActivity(ref, { type: 'message', text: this.cap(text) }),
    );
    return res?.id ?? null;
  }

  async editText(to: string, ref: unknown, text: string): Promise<void> {
    const stored = this.refByConversation.get(to);
    if (!stored || !ref) return;
    const activities = await this.activitiesFor(stored);
    await activities.update(
      String(ref),
      this.buildActivity(stored, { type: 'message', text: this.cap(text) }),
    );
  }

  async sendMedia(
    to: string,
    buffer: Buffer,
    mime: string,
    caption?: string,
    fileName?: string,
  ): Promise<void> {
    const ref = this.refByConversation.get(to);
    if (!ref) throw new Error(`Sem referência de conversa do Teams para ${to}`);
    const activities = await this.activitiesFor(ref);
    // Teams aceita data URL base64 de forma confiável pra IMAGENS; outros tipos
    // entram como anexo nomeado (a paridade total — FileConsent/OneDrive — fica
    // pra camada seguinte). A legenda vai como texto da mensagem.
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    await activities.create(
      this.buildActivity(ref, {
        type: 'message',
        ...(caption ? { text: this.cap(caption) } : {}),
        attachments: [{ name: fileName || 'arquivo', contentType: mime, contentUrl: dataUrl }],
      }),
    );
  }

  async sendTyping(to: string): Promise<void> {
    try {
      const ref = this.refByConversation.get(to);
      if (!ref) return;
      const activities = await this.activitiesFor(ref);
      await activities.create(this.buildActivity(ref, { type: 'typing' }));
    } catch {
      /* presença é best-effort */
    }
  }

  /** Foto de perfil do interlocutor via Graph (a partir do AAD da referência). */
  async fetchProfilePhoto(conversationId: string): Promise<string | null> {
    const aad = this.refByConversation.get(conversationId)?.user?.aadObjectId;
    if (!aad) return null;
    try {
      const token = tokenToString(await this.app?.tokenManager.getGraphToken());
      if (!token) return null;
      const res = await fetch(`${GRAPH_BASE}/users/${encodeURIComponent(aad)}/photo/$value`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const mime = res.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.app = null;
    this.refByConversation.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Teams não tem sessão a revogar (auth é por credencial do app) — só para o servidor. */
  async logout(): Promise<void> {
    await this.stop();
  }
}
