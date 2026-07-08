/**
 * Contrato comum de um canal de mensageria (WhatsApp, Discord, …) — o
 * channel-manager opera contra esta interface, então o roteamento inbound→agente
 * e o streaming de saída são os mesmos pra qualquer canal. Cada implementação
 * (WhatsAppConnection via Baileys, DiscordConnection via discord.js) cuida do
 * protocolo específico.
 */

/** Anexo de mídia já baixado do canal (imagem/vídeo/áudio/arquivo). */
export interface InboundAttachment {
  name: string;
  mime: string;
  /** Conteúdo em base64 (sem prefixo data:). */
  data: string;
}

/** Mensagem normalizada de entrada (qualquer canal). */
export interface InboundChannelMessage {
  /** Endereço pra RESPONDER (JID do WhatsApp / channelId do Discord). */
  from: string;
  /** Identificador do REMETENTE pra casar com a allowlist (número / user id). */
  senderId: string;
  /** Identidades alternativas do remetente pra allowlist (ex.: e-mail/UPN do Teams
   *  além do AAD id). Canais que não têm alias deixam indefinido. */
  senderAliases?: string[];
  /** Nome de exibição (pushName / username), quando disponível. */
  displayName: string | null;
  text: string;
  attachments: InboundAttachment[];
}

/** Callbacks que a conexão dispara pro channel-manager. */
export interface ChannelHandlers {
  /** QR string crua (só WhatsApp — Discord autentica por token, não chama isto). */
  onQr?: (qr: string) => void;
  /** Conectado e autenticado. `selfLabel` é a identidade da conta (número/tag). */
  onConnected: (selfLabel: string | null) => void;
  /** Caiu. `loggedOut` = sessão revogada/credencial inválida. */
  onDisconnected: (loggedOut: boolean, error: string | null) => void;
  /** DM/menção recebida (grupos sem menção e a própria conta já filtrados). */
  onMessage: (msg: InboundChannelMessage) => void;
  /** Usuário escolheu uma opção interativa (botão/lista/select). `choiceId` = id
   *  passado em `sendChoices`. Só canais com UI interativa disparam isto. */
  onChoice?: (from: string, choiceId: string) => void;
}

/** Uma opção clicável apresentada via `sendChoices`. */
export interface ChannelChoice {
  id: string;
  label: string;
}

/**
 * Conexão de UM canal. `sendText` devolve uma REF opaca (key do WhatsApp / id da
 * mensagem do Discord) que `editText` usa pra editar — é assim que simulamos o
 * stream (a mensagem cresce via edição).
 */
export interface ChannelConnection {
  start(): Promise<void>;
  sendText(to: string, text: string): Promise<unknown | null>;
  editText(to: string, ref: unknown, text: string): Promise<void>;
  sendMedia(
    to: string,
    buffer: Buffer,
    mime: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  sendTyping(to: string): Promise<void>;
  /** Apresenta opções clicáveis (botões/lista/select, conforme o canal e a
   *  quantidade). Retorna `true` se mandou UI interativa (e `onChoice` vai
   *  disparar); `false` se NÃO suporta pra essa contagem — aí o manager manda
   *  texto numerado e trata a resposta numérica. Opcional: canais sem UI omitem. */
  sendChoices?(to: string, question: string, choices: ChannelChoice[]): Promise<boolean>;
  /** URL da foto/avatar do remetente (null se indisponível). */
  fetchProfilePhoto(id: string): Promise<string | null>;
  /** Derruba a conexão sem revogar a sessão (reconectável). */
  stop(): Promise<void>;
  /** Revoga/encerra a sessão de forma definitiva. */
  logout(): Promise<void>;
}
