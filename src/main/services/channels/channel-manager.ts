import { join, basename, extname } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { app } from '../../platform/electron';
import { appInfo, broadcast as hostBroadcast } from '../../platform/host';
import QRCode from 'qrcode';
import type {
  ChannelAccountSnapshot,
  ChannelType,
  ChatAttachment,
  ChatStreamEvent,
  MessagePart,
} from '../../../shared/types';
import { channelRepo, type ChannelSessionLink } from '../../db/repositories/channel.repo';
import { ChatSessionRepository } from '../../db/repositories/session.repo';
import { MessageRepository } from '../../db/repositories/message.repo';
import { AgentRepository } from '../../db/repositories/agent.repo';
import { WorkspaceRepository } from '../../db/repositories/workspace.repo';
import {
  enqueueChatMessage,
  chatStreamBus,
  activeRunIdForSession,
  cancelRun,
} from '../chat-service';
import { approveSessionPlan, hasPendingPlanForSession } from '../issue-execution-service';
import { WhatsAppConnection } from './whatsapp-connection';
import { DiscordConnection } from './discord-connection';
import { TelegramConnection } from './telegram-connection';
import { SignalConnection } from './signal-connection';
import { isSignalCliInstalled, installSignalCli } from './signal-cli-pack';
import { TeamsConnection, TEAMS_DEFAULT_PORT, type TeamsCreds } from './teams-connection';
import { teamsCreateApp, teamsUpdateEndpoint, teamsEnsureLogin, stopLogin } from './teams-cli';
import { startTunnel, stopTunnel, stopAllTunnels, tunnelUrlForPort } from './tunnel-manager';
import type { ChannelConnection, InboundChannelMessage } from './channel-types';
import { toolSecretRepo } from '../../db/repositories/tool-secret.repo';
import { getPackStatus, installPack } from '../voice/voice-pack-manager';
import { transcribeAudio } from './audio-transcribe';

/** Chave do secret store pro token do bot Discord de uma conta (cifrado). */
function discordTokenKey(accountId: string): string {
  return `channel:discord:${accountId}:token`;
}

/** Chave do secret store pro token do bot Telegram de uma conta (cifrado). */
function telegramTokenKey(accountId: string): string {
  return `channel:telegram:${accountId}:token`;
}

/** Chave do secret store pras credenciais do bot Teams de uma conta (JSON cifrado). */
function teamsCredsKey(accountId: string): string {
  return `channel:msteams:${accountId}:creds`;
}

/** Lê as credenciais do Teams do secret store (null se ausentes/corrompidas). */
function readTeamsCreds(accountId: string): TeamsCreds | null {
  const raw = toolSecretRepo.get(teamsCredsKey(accountId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TeamsCreds;
  } catch {
    return null;
  }
}

function teamsPort(accountId: string): number {
  return readTeamsCreds(accountId)?.port ?? TEAMS_DEFAULT_PORT;
}

/** Persiste as credenciais do Teams (JSON cifrado), preservando o que já existe. */
function writeTeamsCreds(accountId: string, patch: Partial<TeamsCreds>): void {
  const current = readTeamsCreds(accountId) ?? {};
  const merged = { ...current, ...patch } as TeamsCreds;
  toolSecretRepo.set(teamsCredsKey(accountId), JSON.stringify(merged));
}

/** Endpoint do messaging do Teams pra UI: a URL pública do túnel se ativo, senão
 *  o localhost (informativo). É a URL que o Azure precisa alcançar. */
function teamsEndpoint(accountId: string): string | null {
  const creds = readTeamsCreds(accountId);
  if (!creds) return null;
  const port = creds.port ?? TEAMS_DEFAULT_PORT;
  const tunnel = tunnelUrlForPort(port);
  return tunnel ? `${tunnel}/api/messages` : `http://localhost:${port}/api/messages`;
}

const sessionRepo = new ChatSessionRepository();
const agentRepo = new AgentRepository();
const workspaceRepo = new WorkspaceRepository();

/** Conversas aguardando o usuário escolher o workspace (por `${accountId}:${from}`).
 *  Guarda a 1ª mensagem pendente pra despachar após a escolha. */
const awaitingWorkspaceChoice = new Map<string, { pending: InboundChannelMessage }>();
/** Prefixo do id de escolha de workspace (botões/select). */
const WS_CHOICE_PREFIX = 'ws:';

/** Contatos que pediram pra mandar áudio mas o Whisper não estava instalado —
 *  aguardando o "sim" pra instalar. Chave: `${accountId}:${numero}`. */
const awaitingWhisperConsent = new Set<string>();

function isAffirmative(text: string): boolean {
  return /^\s*(sim|s|yes|y|claro|pode|por\s*favor|instala|instalar|ok|isso|quero)\b/i.test(text);
}

/** Comando de APROVAÇÃO de plano por canal (WhatsApp). Específico ("aprovar"/"aprovar
 *  tudo"…) pra não confundir com conversa normal — só intercepta quando há plano pendente. */
function isPlanApproval(text: string): boolean {
  return /^\s*(aprovar|aprovado|aprova|pode\s+aprovar)(\s+(tudo|todos|o?\s*plano))?\s*[.!]*$/i.test(
    text.trim(),
  );
}

/** QR atual (PNG dataURL) por conta — efêmero, vive só em memória. */
const qrByAccount = new Map<string, string>();
/** QR atual (string CRUA do canal) por conta — pro CLI renderizar no terminal
 *  (`qrcode-terminal`), já que a GUI consome só o dataURL. Efêmero, em memória. */
const rawQrByAccount = new Map<string, string>();
/** Conexões de canal ativas por conta (WhatsApp/Discord). */
const connections = new Map<string, ChannelConnection>();

/**
 * Buffer de saída por mensagem do agente. Em vez de mandar só no fim, mandamos a
 * 1ª parte como uma mensagem no WhatsApp e vamos EDITANDO ela conforme o stream
 * chega (modo de edição do WhatsApp), simulando o streaming do chat.
 */
interface OutboundBuffer {
  accountId: string;
  toJid: string;
  /** Sessão do turno — pra ler o erro persistido se ele terminar sem texto. */
  sessionId: string;
  /** Texto acumulado dos deltas. */
  text: string;
  /** Texto final canônico (message-final), quando vier. */
  finalText: string | null;
  /** Ref opaca da mensagem enviada no canal (pra editar): key do WhatsApp / id do Discord. */
  msgKey: unknown;
  /** Último texto efetivamente enviado/editado (evita edits redundantes). */
  flushedText: string;
  /** Quando foi o último envio/edit (ms) — throttle. */
  lastFlushAt: number;
  /** Flush em andamento (evita edits concorrentes/fora de ordem). */
  flushing: boolean;
  /** O turno terminou — força o flush final. */
  ended: boolean;
}
const outboundByMessage = new Map<string, OutboundBuffer>();
/** Intervalo mínimo entre edits no WhatsApp (evita spam/rate-limit). */
const EDIT_THROTTLE_MS = 1800;

/**
 * Envia/edita a mensagem do WhatsApp com o texto acumulado até agora. Idempotente
 * e serializado por `flushing`: a 1ª chamada ENVIA (guarda a key), as seguintes
 * EDITAM. Sempre reconcilia no fim (re-chama se chegou texto novo durante o envio).
 */
async function flushOutbound(messageId: string): Promise<void> {
  const buf = outboundByMessage.get(messageId);
  if (!buf || buf.flushing) return;
  const target = (buf.finalText ?? buf.text).trim();
  if (!target || target === buf.flushedText) {
    if (buf.ended) outboundByMessage.delete(messageId);
    return;
  }
  const conn = connections.get(buf.accountId);
  if (!conn) {
    if (buf.ended) outboundByMessage.delete(messageId);
    return;
  }
  buf.flushing = true;
  try {
    if (!buf.msgKey) {
      buf.msgKey = await conn.sendText(buf.toJid, target);
    } else {
      await conn.editText(buf.toJid, buf.msgKey, target);
    }
    buf.flushedText = target;
    buf.lastFlushAt = Date.now();
  } catch (err) {
    console.error('[channels] falha ao enviar/editar resposta no WhatsApp:', err);
  } finally {
    buf.flushing = false;
  }
  // Reconcilia: chegou texto novo durante o envio, ou é o flush final.
  const latest = (buf.finalText ?? buf.text).trim();
  if (
    latest !== buf.flushedText &&
    (buf.ended || Date.now() - buf.lastFlushAt >= EDIT_THROTTLE_MS)
  ) {
    await flushOutbound(messageId);
  } else if (buf.ended && latest === buf.flushedText) {
    outboundByMessage.delete(messageId);
  }
}

function authDirFor(accountId: string): string {
  // appInfo.path: userData do Electron no app; fallback ~/.orkestral em Node puro.
  return join(appInfo.path('userData'), 'channels', 'whatsapp', accountId);
}

/** Dir de config do signal-cli pra esta conta (guarda as credenciais do dispositivo
 *  linkado). File-based, como o authDir do WhatsApp — sem schema/secret store. */
function signalConfigDir(accountId: string): string {
  return join(appInfo.path('userData'), 'channels', 'signal', accountId);
}

function broadcast(channel: string, payload: unknown): void {
  hostBroadcast(channel, payload);
}

function buildSnapshot(accountId: string): ChannelAccountSnapshot | null {
  const account = channelRepo.getAccount(accountId);
  if (!account) return null;
  return {
    ...account,
    qrDataUrl: account.status === 'qr' ? (qrByAccount.get(accountId) ?? null) : null,
    sessionCount: channelRepo.countLinks(accountId),
    hasToken:
      account.channelType === 'discord'
        ? toolSecretRepo.has(discordTokenKey(accountId))
        : account.channelType === 'telegram'
          ? toolSecretRepo.has(telegramTokenKey(accountId))
          : account.channelType === 'msteams'
            ? toolSecretRepo.has(teamsCredsKey(accountId))
            : false,
    endpoint: account.channelType === 'msteams' ? teamsEndpoint(accountId) : null,
  };
}

function emitAccountUpdate(accountId: string): void {
  const snapshot = buildSnapshot(accountId);
  if (snapshot) broadcast('channels:account-updated', snapshot);
}

// ---- Entrada: mensagem do WhatsApp → sessão de chat do Orkestral ------------

/** Reduz um número/JID a só dígitos, pra comparar com a allowlist sem máscara. */
function normalizeNumber(raw: string): string {
  return raw.split('@')[0].replace(/\D/g, '');
}

/** Envia um texto direto pro contato (respostas de comando / status). */
function replyTo(accountId: string, toJid: string, text: string): void {
  const conn = connections.get(accountId);
  void conn?.sendText(toJid, text).catch(() => {
    /* best-effort */
  });
}

const HELP_TEXT = [
  '*Comandos disponíveis:*',
  '/new — começa uma conversa nova (zera o contexto)',
  '/status — mostra o agente e a sessão atual',
  '/stop — interrompe a resposta em andamento',
  '/whoami — mostra o seu número',
  '/workspaces — escolhe/troca o workspace da conversa',
  '/help — mostra esta lista',
].join('\n');

/** Trata comandos /slash (estilo openclaw). Retorna true se consumiu a mensagem. */
function handleCommand(
  accountId: string,
  link: ChannelSessionLink,
  msg: InboundChannelMessage,
): boolean {
  if (msg.attachments.length > 0 || !msg.text.startsWith('/')) return false;
  const account = channelRepo.getAccount(accountId);
  if (!account) return true;
  const cmd = msg.text.slice(1).split(/\s+/)[0].toLowerCase();

  switch (cmd) {
    case 'help':
    case 'menu':
      replyTo(accountId, msg.from, HELP_TEXT);
      return true;
    case 'new':
    case 'reset': {
      // Com >1 workspace, conversa nova volta a perguntar qual (botões/numérico),
      // igual ao 1º contato. A sessão só é criada após a escolha.
      const workspaces = workspaceRepo.list();
      if (workspaces.length > 1) {
        void askWorkspace(accountId, msg, workspaces);
        return true;
      }
      const session = sessionRepo.create({
        workspaceId: account.workspaceId,
        agentId: account.agentId,
        // Sem título: auto-titula pela 1ª mensagem (igual chat normal).
        channelType: account.channelType,
      });
      channelRepo.setLinkSession(link.id, session.id);
      replyTo(accountId, msg.from, '✅ Conversa nova iniciada. O contexto anterior foi zerado.');
      return true;
    }
    case 'status': {
      const agent = agentRepo.get(account.agentId);
      const agentName = agent?.title || agent?.name || account.agentId;
      replyTo(accountId, msg.from, `*Agente:* ${agentName}\n*Sessão:* ativa neste número`);
      return true;
    }
    case 'stop': {
      const runId = activeRunIdForSession(link.chatSessionId);
      if (runId) {
        cancelRun(runId);
        replyTo(accountId, msg.from, '⏹️ Resposta interrompida.');
      } else {
        replyTo(accountId, msg.from, 'Nada em andamento agora.');
      }
      return true;
    }
    case 'whoami':
      replyTo(accountId, msg.from, `Seu número: ${msg.senderId}`);
      return true;
    case 'workspaces': {
      const workspaces = workspaceRepo.list();
      if (workspaces.length <= 1) {
        replyTo(
          accountId,
          msg.from,
          workspaces.length === 1
            ? `Só existe um workspace: *${workspaces[0].name}*.`
            : 'Nenhum workspace disponível.',
        );
        return true;
      }
      void askWorkspace(accountId, msg, workspaces);
      return true;
    }
    default:
      replyTo(accountId, msg.from, `Comando desconhecido: /${cmd}\n\n${HELP_TEXT}`);
      return true;
  }
}

/** Agente que responde num workspace: o orquestrador, ou o 1º agente se não houver. */
function defaultAgentForWorkspace(workspaceId: string): string | null {
  const orchestrator = agentRepo.getOrchestrator(workspaceId);
  if (orchestrator) return orchestrator.id;
  return agentRepo.listByWorkspace(workspaceId)[0]?.id ?? null;
}

/** Pergunta "sobre qual workspace?" — UI interativa (botões/lista/select) quando o
 *  canal suporta a contagem, senão texto numerado. Guarda a msg pra despachar depois. */
async function askWorkspace(
  accountId: string,
  msg: InboundChannelMessage,
  workspaces: { id: string; name: string }[],
): Promise<void> {
  awaitingWorkspaceChoice.set(`${accountId}:${msg.from}`, { pending: msg });
  const conn = connections.get(accountId);
  const question = 'Sobre qual workspace você quer falar?';
  const choices = workspaces.map((w) => ({ id: `${WS_CHOICE_PREFIX}${w.id}`, label: w.name }));
  // Tenta UI interativa; o canal decide botões/lista/numérico pela contagem e devolve
  // false se não couber — aí caímos no texto numerado (sempre aceito como fallback).
  let interactive = false;
  if (conn?.sendChoices) {
    interactive = await conn.sendChoices(msg.from, question, choices).catch(() => false);
  }
  if (!interactive) {
    const lines = workspaces.map((w, i) => `${i + 1}) ${w.name}`).join('\n');
    replyTo(accountId, msg.from, `${question}\n\n${lines}\n\nResponda com o número.`);
  }
}

/** Resolve a escolha: cria a sessão no workspace escolhido (agente orquestrador),
 *  (re)aponta o vínculo e despacha a 1ª mensagem que ficou pendente. */
function startConversationInWorkspace(accountId: string, from: string, workspaceId: string): void {
  const key = `${accountId}:${from}`;
  const stash = awaitingWorkspaceChoice.get(key);
  awaitingWorkspaceChoice.delete(key);

  const workspace = workspaceRepo.list().find((w) => w.id === workspaceId);
  if (!workspace) return;
  const agentId = defaultAgentForWorkspace(workspaceId);
  if (!agentId) {
    replyTo(accountId, from, `O workspace *${workspace.name}* não tem agente configurado.`);
    return;
  }

  const msg = stash?.pending;
  const session = sessionRepo.create({
    workspaceId,
    agentId,
    // Sem título: auto-titula pela 1ª mensagem despachada (igual chat normal).
    channelType: channelRepo.getAccount(accountId)?.channelType ?? null,
  });

  const existing = channelRepo.getLinkByUser(accountId, from);
  if (existing) channelRepo.setLinkSession(existing.id, session.id);
  else
    channelRepo.createLink({
      accountId,
      channelUserId: from,
      displayName: msg?.displayName ?? null,
      phone: msg?.senderId ?? from,
      chatSessionId: session.id,
    });

  replyTo(accountId, from, `Pronto, falando sobre *${workspace.name}*.`);

  // Despacha a 1ª mensagem real (não despacha comandos /slash nem áudio — MVP: só texto).
  if (msg && msg.text && !msg.text.startsWith('/') && msg.attachments.length === 0) {
    void connections.get(accountId)?.sendTyping(from);
    void enqueueChatMessage({
      sessionId: session.id,
      content: msg.text,
      attachments: [],
      origin: 'channel',
    }).catch((err) => {
      console.error('[channels] falha ao despachar 1ª msg pós-escolha de workspace:', err);
    });
  }
}

function handleInbound(accountId: string, msg: InboundChannelMessage): void {
  const account = channelRepo.getAccount(accountId);
  if (!account) return;

  // Guard OPCIONAL: se a allowlist tem números, só eles são respondidos; vazia =
  // responde todo mundo. Usa o número REAL resolvido (do @lid), não o jid opaco.
  if (account.allowlist.length > 0) {
    // Teams casa por AAD id / e-mail (case-insensitive, guardados em minúsculo);
    // os demais canais casam por dígitos (número/snowflake) com o número resolvido.
    const allowed =
      account.channelType === 'msteams'
        ? [msg.senderId, ...(msg.senderAliases ?? [])]
            .map((s) => s.toLowerCase())
            .some((id) => account.allowlist.includes(id))
        : account.allowlist.some((n) => normalizeNumber(n) === msg.senderId);
    if (!allowed) {
      console.log(`[channels] ${msg.senderId} bloqueado pela allowlist`, account.allowlist);
      return;
    }
  }
  console.log(`[channels] despachando mensagem de ${msg.senderId} pro agente`);

  // Aguardando a escolha de workspace via TEXTO (fallback numerado p/ contagem grande
  // ou canais sem botão)? Resolve a escolha aqui.
  const choiceKey = `${accountId}:${msg.from}`;
  if (awaitingWorkspaceChoice.has(choiceKey)) {
    const workspaces = workspaceRepo.list();
    const n = Number.parseInt(msg.text.trim(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= workspaces.length) {
      startConversationInWorkspace(accountId, msg.from, workspaces[n - 1].id);
    } else {
      replyTo(accountId, msg.from, 'Responda com o número do workspace (ex.: 1).');
    }
    return;
  }

  // Mantém a MESMA sessão por contato (conversa contínua/fluida).
  let link = channelRepo.getLinkByUser(accountId, msg.from);
  if (!link) {
    // Conversa nova: com MAIS DE UM workspace, pergunta sobre qual falar (a sessão só
    // é criada após a escolha). Com um só, segue direto no workspace/agente da conta.
    const workspaces = workspaceRepo.list();
    if (workspaces.length > 1) {
      void askWorkspace(accountId, msg, workspaces);
      return;
    }
    const session = sessionRepo.create({
      workspaceId: account.workspaceId,
      agentId: account.agentId,
      // Sem título: o chat-service auto-titula pela 1ª mensagem (igual chat normal).
      // O nome do contato já aparece no header da conversa.
      channelType: account.channelType,
    });
    link = channelRepo.createLink({
      accountId,
      channelUserId: msg.from,
      displayName: msg.displayName,
      phone: msg.senderId,
      chatSessionId: session.id,
    });
    // Busca a foto de perfil em background (não bloqueia a resposta).
    void connections
      .get(accountId)
      ?.fetchProfilePhoto(msg.from)
      .then((url) => {
        if (url) channelRepo.setLinkPhoto(link!.id, url);
      });
  } else {
    channelRepo.touchLink(link.id);
  }

  // Comandos /slash são respondidos direto (não viram turno do agente).
  if (handleCommand(accountId, link, msg)) return;

  // Aprovação do PLANO por WhatsApp: se há plano pendente pra esta sessão e o usuário
  // respondeu "aprovar"/"aprovar tudo", aprova + executa direto (em vez de virar turno do
  // agente, que só ficaria explicando). Mesmo núcleo do card do chat.
  if (msg.attachments.length === 0 && isPlanApproval(msg.text)) {
    const acc = channelRepo.getAccount(accountId);
    if (acc && hasPendingPlanForSession(acc.workspaceId, link.chatSessionId)) {
      const r = approveSessionPlan(acc.workspaceId, link.chatSessionId);
      replyTo(
        accountId,
        msg.from,
        r.started > 0
          ? `✅ Plano aprovado — ${r.started} tarefa(s) em execução. Acompanhe o progresso no app.`
          : '✅ Plano aprovado.',
      );
      return;
    }
  }

  // Áudio: precisa do Whisper local pra transcrever (o agente não "ouve" áudio cru).
  const audioAtt = msg.attachments.find((a) => a.mime.startsWith('audio/'));
  const consentKey = `${accountId}:${msg.senderId}`;
  // Aguardando "sim" pra instalar o Whisper? Trata a resposta.
  if (awaitingWhisperConsent.has(consentKey) && !audioAtt) {
    awaitingWhisperConsent.delete(consentKey);
    if (isAffirmative(msg.text)) {
      void runWhisperInstall(accountId, msg.from);
      return;
    }
    // Não quis instalar → segue o fluxo normal com o texto.
  }
  if (audioAtt) {
    void handleAudioMessage(accountId, link, msg, audioAtt);
    return;
  }

  // Anexos do WhatsApp → ChatAttachment (imagem o agente "vê"; vídeo/arquivo seguem anexados).
  const attachments: ChatAttachment[] = msg.attachments.map((a) => {
    const buf = Buffer.from(a.data, 'base64');
    return { id: randomUUID(), name: a.name, mime: a.mime, size: buf.length, data: a.data };
  });

  // Feedback de "digitando…" enquanto o agente pensa.
  void connections.get(accountId)?.sendTyping(msg.from);

  // Enfileira (em vez de chamar sendMessage direto): se o agente ainda está
  // processando a mensagem anterior, evita um RUN CONCORRENTE na mesma sessão
  // (que travava as respostas). A fila despacha sozinha ao terminar o turno.
  void enqueueChatMessage({
    sessionId: link.chatSessionId,
    content: msg.text,
    attachments,
    origin: 'channel',
  }).catch((err) => {
    console.error('[channels] falha ao despachar mensagem do WhatsApp pro agente:', err);
  });
}

/** Áudio recebido: se o Whisper estiver instalado, transcreve e despacha o texto;
 *  senão, pergunta se o usuário quer instalar (e aguarda o "sim"). */
async function handleAudioMessage(
  accountId: string,
  link: ChannelSessionLink,
  msg: InboundChannelMessage,
  audio: { data: string; mime: string; name: string },
): Promise<void> {
  const status = await getPackStatus();
  if (!status.installed) {
    awaitingWhisperConsent.add(`${accountId}:${msg.senderId}`);
    replyTo(
      accountId,
      msg.from,
      '🎤 Recebi seu áudio! Pra eu *entender áudios* eu uso a transcrição local (Whisper, ~575 MB) — roda offline no computador onde o Orkestral está. Quer que eu instale agora? Responda *sim*.',
    );
    return;
  }
  void connections.get(accountId)?.sendTyping(msg.from);
  try {
    const text = await transcribeAudio(Buffer.from(audio.data, 'base64'));
    if (!text) {
      replyTo(accountId, msg.from, 'Não consegui entender o áudio. Pode repetir ou mandar texto?');
      return;
    }
    await enqueueChatMessage({
      sessionId: link.chatSessionId,
      content: text,
      origin: 'channel',
    });
  } catch (err) {
    console.error('[channels] falha ao transcrever áudio:', err);
    replyTo(accountId, msg.from, 'Tive um problema pra transcrever esse áudio. Tenta de novo?');
  }
}

/** Instala o pack de transcrição (Whisper) e avisa o usuário no WhatsApp. */
async function runWhisperInstall(accountId: string, jid: string): Promise<void> {
  replyTo(
    accountId,
    jid,
    '⏳ Instalando a transcrição local (Whisper)… baixa ~575 MB, pode levar alguns minutos. Te aviso quando terminar.',
  );
  try {
    await installPack();
    replyTo(
      accountId,
      jid,
      '✅ Pronto! Transcrição instalada. Agora eu *entendo seus áudios* — pode mandar o áudio de novo. 🎧',
    );
  } catch (err) {
    console.error('[channels] falha ao instalar Whisper:', err);
    replyTo(accountId, jid, 'Não consegui instalar a transcrição agora. Tenta de novo mais tarde.');
  }
}

// ---- Saída: resposta do agente → de volta pro WhatsApp ---------------------

/** Mime por extensão (suficiente pro envio de mídia do agente). */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

function mimeFromPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function partsToText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
}

/**
 * Mensagem de erro pro contato quando o turno falhou sem produzir texto. Lê o
 * `error` persistido na última mensagem da sessão (ex.: "spawn claude ENOENT",
 * "approval_prompt not found") pra dizer o motivo real; cai num genérico se não
 * houver. Trunca — é canal de chat, não log. Prefixo diferencia de resposta real.
 */
function channelErrorReply(sessionId: string): string {
  let detail = '';
  try {
    const last = new MessageRepository().lastBySession(sessionId);
    const errPart = last?.parts.find(
      (p): p is Extract<MessagePart, { type: 'error' }> => p.type === 'error',
    );
    if (errPart?.message) detail = errPart.message.trim().slice(0, 300);
  } catch {
    /* sem detalhe — usa o genérico */
  }
  const base = '⚠️ Não consegui processar sua mensagem — o agente falhou.';
  return detail ? `${base}\n\n${detail}` : `${base} Confira os logs do servidor.`;
}

function onChatStreamEvent(event: ChatStreamEvent): void {
  switch (event.type) {
    case 'message-start': {
      const link = channelRepo.getLinkByChatSession(event.sessionId);
      if (!link) return;
      outboundByMessage.set(event.messageId, {
        accountId: link.accountId,
        toJid: link.channelUserId,
        sessionId: event.sessionId,
        text: '',
        finalText: null,
        msgKey: null,
        flushedText: '',
        lastFlushAt: 0,
        flushing: false,
        ended: false,
      });
      return;
    }
    case 'text-delta': {
      const buf = outboundByMessage.get(event.messageId);
      if (!buf) return;
      buf.text += event.delta;
      // Stream pro WhatsApp via edição, com throttle (evita spam de edits).
      if (!buf.flushing && Date.now() - buf.lastFlushAt >= EDIT_THROTTLE_MS) {
        void flushOutbound(event.messageId);
      }
      return;
    }
    case 'message-final': {
      const buf = outboundByMessage.get(event.messageId);
      if (buf) buf.finalText = partsToText(event.parts);
      return;
    }
    case 'message-end': {
      const buf = outboundByMessage.get(event.messageId);
      if (!buf) return;
      buf.ended = true;
      // Status não-done sem nada enviado ainda: cancelamento (usuário deu Stop)
      // fica silencioso; ERRO NÃO — avisa o contato em vez de sumir mudo (senão
      // o Telegram/WhatsApp fica "digitando…" e nunca responde, sem pista do
      // motivo). Puxa o texto do erro persistido pra dizer o que falhou.
      if (event.status !== 'done' && !buf.msgKey) {
        const { accountId, toJid, sessionId } = buf;
        outboundByMessage.delete(event.messageId);
        if (event.status === 'error') {
          replyTo(accountId, toJid, channelErrorReply(sessionId));
        }
        return;
      }
      void flushOutbound(event.messageId); // edit final com o texto completo
      return;
    }
    default:
      return;
  }
}

// ---- Ciclo de vida da conexão ----------------------------------------------

async function openConnection(accountId: string): Promise<void> {
  if (connections.has(accountId)) return;
  const account = channelRepo.getAccount(accountId);
  if (!account) return;

  const handlers = {
    onQr: (qr: string) => {
      rawQrByAccount.set(accountId, qr);
      void QRCode.toDataURL(qr, { margin: 1, width: 264 }).then((dataUrl) => {
        qrByAccount.set(accountId, dataUrl);
        channelRepo.updateAccount(accountId, { status: 'qr', lastError: null });
        emitAccountUpdate(accountId);
      });
    },
    onConnected: (selfId: string | null) => {
      qrByAccount.delete(accountId);
      rawQrByAccount.delete(accountId);
      channelRepo.updateAccount(accountId, {
        status: 'connected',
        selfId,
        lastConnectedAt: new Date().toISOString(),
        lastError: null,
      });
      emitAccountUpdate(accountId);
    },
    onDisconnected: (loggedOut: boolean, error: string | null) => {
      if (loggedOut) {
        qrByAccount.delete(accountId);
        rawQrByAccount.delete(accountId);
        connections.delete(accountId);
        channelRepo.updateAccount(accountId, {
          status: 'disconnected',
          selfId: null,
          lastError: error,
        });
      } else {
        channelRepo.updateAccount(accountId, { status: 'connecting', lastError: error });
      }
      emitAccountUpdate(accountId);
    },
    onMessage: (msg: InboundChannelMessage) => handleInbound(accountId, msg),
    onChoice: (from: string, choiceId: string) => {
      // Só tratamos escolha de workspace por enquanto.
      if (!choiceId.startsWith(WS_CHOICE_PREFIX)) return;
      if (!awaitingWorkspaceChoice.has(`${accountId}:${from}`)) return;
      startConversationInWorkspace(accountId, from, choiceId.slice(WS_CHOICE_PREFIX.length));
    },
  };

  let conn: ChannelConnection;
  if (account.channelType === 'discord') {
    const token = toolSecretRepo.get(discordTokenKey(accountId));
    if (!token) {
      channelRepo.updateAccount(accountId, {
        status: 'disconnected',
        lastError: 'Token do bot não configurado.',
      });
      emitAccountUpdate(accountId);
      return;
    }
    conn = new DiscordConnection(token, handlers); // Discord não usa onQr
  } else if (account.channelType === 'telegram') {
    const token = toolSecretRepo.get(telegramTokenKey(accountId));
    if (!token) {
      channelRepo.updateAccount(accountId, {
        status: 'disconnected',
        lastError: 'Token do bot não configurado.',
      });
      emitAccountUpdate(accountId);
      return;
    }
    conn = new TelegramConnection(token, handlers); // Telegram autentica por bot token (sem QR)
  } else if (account.channelType === 'msteams') {
    const creds = readTeamsCreds(accountId);
    if (!creds) {
      channelRepo.updateAccount(accountId, {
        status: 'disconnected',
        lastError: 'Credenciais do Teams não configuradas.',
      });
      emitAccountUpdate(accountId);
      return;
    }
    // Sobe o túnel embutido (cloudflared) e reaponta o endpoint do Azure pra ele.
    // A URL do quick tunnel é efêmera, então reapontamos a cada conexão.
    const port = creds.port ?? TEAMS_DEFAULT_PORT;
    try {
      const url = await startTunnel(port);
      if (creds.teamsAppId) {
        await teamsUpdateEndpoint(creds.teamsAppId, url).catch((err) =>
          console.error('[channels] falha ao reapontar o endpoint do Teams:', err),
        );
      }
    } catch (err) {
      stopTunnel(port);
      channelRepo.updateAccount(accountId, {
        status: 'disconnected',
        lastError: `Falha ao abrir o túnel: ${err instanceof Error ? err.message : String(err)}`,
      });
      emitAccountUpdate(accountId);
      return;
    }
    conn = new TeamsConnection(creds, handlers); // Teams autentica por credencial do app
  } else if (account.channelType === 'signal') {
    if (!isSignalCliInstalled()) {
      // Baixa o signal-cli (+JRE) sob demanda; ao terminar, reabre a conexão.
      channelRepo.updateAccount(accountId, {
        status: 'connecting',
        lastError: 'Baixando signal-cli…',
      });
      emitAccountUpdate(accountId);
      void installSignalCli()
        .then(() => openConnection(accountId))
        .catch((err) => {
          channelRepo.updateAccount(accountId, {
            status: 'disconnected',
            lastError: err instanceof Error ? err.message : String(err),
          });
          emitAccountUpdate(accountId);
        });
      return;
    }
    // selfId guarda o número já linkado (null = precisa linkar via QR).
    conn = new SignalConnection(signalConfigDir(accountId), account.selfId ?? null, handlers);
  } else {
    conn = new WhatsAppConnection(authDirFor(accountId), handlers);
  }

  connections.set(accountId, conn);
  channelRepo.updateAccount(accountId, { status: 'connecting', lastError: null });
  emitAccountUpdate(accountId);
  await conn.start();
}

// ---- API pública (usada pelos handlers IPC) --------------------------------

export const channelManager = {
  /**
   * Envia um arquivo (imagem/vídeo/doc) do disco pro interlocutor de uma sessão de
   * chat que veio de um canal. Usado pela tool MCP `send_whatsapp_image` — é assim
   * que o agente "manda um print" pro usuário no WhatsApp. Retorna true se enviou.
   */
  async sendMediaToSession(
    chatSessionId: string,
    filePath: string,
    caption?: string,
  ): Promise<boolean> {
    const link = channelRepo.getLinkByChatSession(chatSessionId);
    if (!link) return false;
    const conn = connections.get(link.accountId);
    if (!conn) return false;
    if (!existsSync(filePath)) throw new Error(`Arquivo não encontrado: ${filePath}`);
    const buffer = readFileSync(filePath);
    await conn.sendMedia(
      link.channelUserId,
      buffer,
      mimeFromPath(filePath),
      caption,
      basename(filePath),
    );
    return true;
  },

  /** True se a sessão de chat veio de um canal (tem interlocutor pra enviar mídia). */
  isChannelSession(chatSessionId: string): boolean {
    return channelRepo.getLinkByChatSession(chatSessionId) !== null;
  },

  listSnapshots(channelType?: ChannelType): ChannelAccountSnapshot[] {
    return channelRepo
      .listAccounts(channelType)
      .map((a) => buildSnapshot(a.id))
      .filter((s): s is ChannelAccountSnapshot => s !== null);
  },

  createAccount(input: {
    channelType: ChannelType;
    workspaceId: string;
    agentId: string;
  }): ChannelAccountSnapshot {
    const account = channelRepo.createAccount(input);
    return buildSnapshot(account.id)!;
  },

  /** Salva a config do canal (agente que responde + allowlist + credenciais do bot). */
  setConfig(
    accountId: string,
    input: {
      agentId: string;
      allowlist: string[];
      token?: string;
      teams?: Partial<TeamsCreds>;
    },
  ): ChannelAccountSnapshot | null {
    const isTeams = channelRepo.getAccount(accountId)?.channelType === 'msteams';
    channelRepo.updateAccount(accountId, {
      agentId: input.agentId,
      // Teams: AAD id / e-mail em minúsculo; demais canais: só dígitos (número/snowflake).
      allowlist: isTeams
        ? input.allowlist.map((n) => n.trim().toLowerCase()).filter(Boolean)
        : input.allowlist.map((n) => n.replace(/\D/g, '')).filter(Boolean),
    });
    // Token do bot (Discord ou Telegram) → secret store cifrado (nunca na tabela/renderer).
    if (input.token !== undefined && input.token.trim()) {
      const ct = channelRepo.getAccount(accountId)?.channelType;
      const key = ct === 'telegram' ? telegramTokenKey(accountId) : discordTokenKey(accountId);
      toolSecretRepo.set(key, input.token.trim());
    }
    // Credenciais do Teams → secret store cifrado (JSON). Merge parcial: campos
    // vazios não sobrescrevem (a senha só é reenviada quando o usuário a digita).
    if (input.teams) {
      const patch: Partial<TeamsCreds> = {};
      if (input.teams.appId?.trim()) patch.appId = input.teams.appId.trim();
      if (input.teams.appPassword?.trim()) patch.appPassword = input.teams.appPassword.trim();
      if (input.teams.tenantId?.trim()) patch.tenantId = input.teams.tenantId.trim();
      if (typeof input.teams.port === 'number' && input.teams.port > 0)
        patch.port = input.teams.port;
      const merged: Partial<TeamsCreds> = { ...(readTeamsCreds(accountId) ?? {}), ...patch };
      // writeTeamsCreds preserva o que já existe (ex.: teamsAppId vindo do create).
      if (merged.appId && merged.appPassword && merged.tenantId) {
        writeTeamsCreds(accountId, { ...patch, port: merged.port ?? TEAMS_DEFAULT_PORT });
      }
    }
    emitAccountUpdate(accountId);
    return buildSnapshot(accountId);
  },

  /** Salva o token do bot Telegram (cifrado) e devolve o snapshot atualizado. */
  setTelegramToken(accountId: string, token: string): ChannelAccountSnapshot | null {
    if (token.trim()) toolSecretRepo.set(telegramTokenKey(accountId), token.trim());
    emitAccountUpdate(accountId);
    return buildSnapshot(accountId);
  },

  /** Sobe o servidor/conexão (mostra QR ou reconecta). Só roda quando chamado. */
  async connect(accountId: string): Promise<ChannelAccountSnapshot | null> {
    if (!channelRepo.getAccount(accountId)) return null;
    await openConnection(accountId);
    return buildSnapshot(accountId);
  },

  /**
   * Cria o app/bot do Teams via CLI da Microsoft: sobe o túnel embutido, registra
   * no Azure com a URL pública e salva as credenciais (incl. teamsAppId). Devolve
   * só os dados NÃO-secretos pra UI preencher — o client secret fica cifrado no main.
   */
  async createTeamsApp(
    accountId: string,
    opts: { name?: string },
  ): Promise<{ appId: string; tenantId: string }> {
    // Garante o login (device code) ANTES do create — senão `teams app create`
    // dispara um login interativo no navegador (o bug do vscode.dev). O código de
    // login vai pra UI via evento; este await só resolve quando o login conclui.
    console.log('[teams][login-first] createTeamsApp: garantindo login ANTES do create…');
    await teamsEnsureLogin((dc) => broadcast('channels:teams-login-code', dc));
    console.log('[teams][login-first] login garantido — subindo túnel e criando o app');
    const port = teamsPort(accountId);
    const url = await startTunnel(port);
    const creds = await teamsCreateApp({ name: opts.name?.trim() || 'Orkestral', endpoint: url });
    writeTeamsCreds(accountId, {
      appId: creds.appId,
      appPassword: creds.appPassword,
      tenantId: creds.tenantId,
      ...(creds.teamsAppId ? { teamsAppId: creds.teamsAppId } : {}),
      port,
    });
    emitAccountUpdate(accountId);
    return { appId: creds.appId, tenantId: creds.tenantId };
  },

  /** Derruba a conexão SEM revogar a sessão (reconecta sem QR depois). */
  async disconnect(accountId: string): Promise<ChannelAccountSnapshot | null> {
    const conn = connections.get(accountId);
    if (conn) {
      await conn.stop();
      connections.delete(accountId);
    }
    if (channelRepo.getAccount(accountId)?.channelType === 'msteams') {
      stopTunnel(teamsPort(accountId));
    }
    qrByAccount.delete(accountId);
    rawQrByAccount.delete(accountId);
    channelRepo.updateAccount(accountId, { status: 'disconnected', lastError: null });
    emitAccountUpdate(accountId);
    return buildSnapshot(accountId);
  },

  async logout(accountId: string): Promise<ChannelAccountSnapshot | null> {
    const conn = connections.get(accountId);
    if (conn) {
      await conn.logout();
      connections.delete(accountId);
    }
    if (channelRepo.getAccount(accountId)?.channelType === 'msteams') {
      stopTunnel(teamsPort(accountId));
    }
    qrByAccount.delete(accountId);
    rawQrByAccount.delete(accountId);
    channelRepo.updateAccount(accountId, { status: 'disconnected', selfId: null, lastError: null });
    emitAccountUpdate(accountId);
    return buildSnapshot(accountId);
  },

  async deleteAccount(accountId: string): Promise<void> {
    const conn = connections.get(accountId);
    if (conn) {
      await conn.stop();
      connections.delete(accountId);
    }
    if (channelRepo.getAccount(accountId)?.channelType === 'msteams') {
      stopTunnel(teamsPort(accountId));
    }
    // Signal: apaga o dir de config do signal-cli (desvincula o dispositivo).
    if (channelRepo.getAccount(accountId)?.channelType === 'signal') {
      try {
        rmSync(signalConfigDir(accountId), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    qrByAccount.delete(accountId);
    rawQrByAccount.delete(accountId);
    channelRepo.deleteAccount(accountId);
  },

  /**
   * QR CRU atual de uma conta (string que o `qrcode-terminal` renderiza), ou null
   * se não está em pareamento. A GUI usa `qrDataUrl` no snapshot; o CLI headless
   * usa isto pra desenhar o QR no terminal. Efêmero — só existe durante `status==='qr'`.
   */
  getRawQr(accountId: string): string | null {
    return rawQrByAccount.get(accountId) ?? null;
  },
};

/**
 * Boot: liga o bus de saída e RELIGA as contas já pareadas (creds.json no disco)
 * pra MANTER a sessão entre reinícios do app — sem novo QR. Contas que nunca
 * pararam (sem creds) ficam 'disconnected' e só sobem quando o usuário clica em
 * Conectar (servidor não sobe sozinho pra conta não-pareada).
 */
export function initChannelService(): void {
  chatStreamBus.on('event', onChatStreamEvent);
  // Não deixa processos do cloudflared / login órfãos quando o app fecha.
  // No Electron o hook é will-quit; em Node puro (CLI standalone) é o exit do
  // processo — ambos os stops são síncronos (kill de child process), então
  // funcionam no handler de 'exit'.
  if (app) {
    app.on('will-quit', () => {
      stopAllTunnels();
      stopLogin();
    });
  } else {
    process.on('exit', () => {
      stopAllTunnels();
      stopLogin();
    });
  }
  for (const account of channelRepo.listAccounts()) {
    // Pareada/configurada = WhatsApp com creds.json no disco, ou Discord com token salvo.
    const configured =
      account.channelType === 'discord'
        ? toolSecretRepo.has(discordTokenKey(account.id))
        : account.channelType === 'telegram'
          ? toolSecretRepo.has(telegramTokenKey(account.id))
          : account.channelType === 'msteams'
            ? toolSecretRepo.has(teamsCredsKey(account.id))
            : account.channelType === 'signal'
              ? // Linkado = tem selfId (número) salvo E o signal-cli já baixado.
                !!account.selfId && isSignalCliInstalled()
              : existsSync(join(authDirFor(account.id), 'creds.json'));
    if (configured) {
      void openConnection(account.id).catch((err) => {
        console.error(`[channels] falha ao religar conta ${account.id} no boot:`, err);
      });
    } else if (account.status !== 'disconnected') {
      channelRepo.updateAccount(account.id, { status: 'disconnected' });
    }
  }
}
