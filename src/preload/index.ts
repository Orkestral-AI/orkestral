import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';
import { IPC_CHANNELS } from '../shared/ipc-contract';
import type { OrkestralApi } from '../shared/ipc-contract';
import type {
  ChatStreamEvent,
  ChatQueueItem,
  CodeReviewEvent,
  SourceCloneEvent,
  KbAnalyzeEvent,
  KbEmbeddingEvent,
  TraceEntry,
  AgentTraceEvent,
  VoiceInstallEvent,
  IssueExecutionEvent,
  ChannelAccountSnapshot,
} from '../shared/types';

/**
 * Monta dinamicamente `window.orkestral.<channel>` para cada canal declarado
 * no contrato compartilhado. Cada método invoca `ipcRenderer.invoke`.
 */
function buildOrkestralApi(): OrkestralApi {
  const api = {} as Record<string, (request?: unknown) => Promise<unknown>>;
  for (const channel of IPC_CHANNELS) {
    api[channel] = (request?: unknown) => ipcRenderer.invoke(channel, request);
  }
  return api as OrkestralApi;
}

/**
 * Canal de eventos do streaming de chat. Diferente do invoke/response — o main
 * envia eventos via `webContents.send('chat:stream', ChatStreamEvent)` e
 * o renderer escuta com onChatStream(listener). Retorna função de cleanup.
 */
export interface IssuesChangedEvent {
  workspaceId: string;
  reason: string;
}

export interface OrkestralEvents {
  onChatStream: (listener: (event: ChatStreamEvent) => void) => () => void;
  /** Fila de mensagens (persistida no MAIN) de uma sessão mudou. */
  onChatQueueChanged: (
    listener: (event: { sessionId: string; items: ChatQueueItem[] }) => void,
  ) => () => void;
  onCodeReviewEvent: (listener: (event: CodeReviewEvent) => void) => () => void;
  onSourceCloneEvent: (listener: (event: SourceCloneEvent) => void) => () => void;
  onIssuesChanged: (listener: (event: IssuesChangedEvent) => void) => () => void;
  onKbAnalyzeEvent: (listener: (event: KbAnalyzeEvent) => void) => () => void;
  onKbEmbeddingEvent: (listener: (event: KbEmbeddingEvent) => void) => () => void;
  onIssueExecutionEvent: (listener: (event: IssueExecutionEvent) => void) => () => void;
  onLogEntry: (listener: (event: TraceEntry) => void) => () => void;
  onAgentTraceEvent: (listener: (event: AgentTraceEvent) => void) => () => void;
  onVoiceInstallProgress: (listener: (event: VoiceInstallEvent) => void) => () => void;
  /** Sessão de chat criada em background (ex.: plano de contratação pós-onboarding)
   *  que o renderer deve abrir em tempo real. */
  onChatSessionReady: (
    listener: (event: { workspaceId: string; sessionId: string; reason: string }) => void,
  ) => () => void;
  /** Proposta nova na Caixa de entrada (ex.: especialista de source) — dispara
   *  um toast com ação onde quer que o usuário esteja. */
  onInboxProposal: (
    listener: (event: {
      workspaceId: string;
      sourceId: string;
      sourceLabel: string;
      recommendedAgentName: string | null;
      title: string;
    }) => void,
  ) => () => void;
  /** Conta do Orkestral Cloud conectada/desconectada (deep link do login web). */
  onCloudAuthChanged: (
    listener: (event: { account: { email: string; name: string | null } | null }) => void,
  ) => () => void;
  /** Preview do projeto mudou (subiu/parou/ficou disponível) — o painel re-consulta o status. */
  onPreviewChanged: (listener: (event: { workspaceId: string }) => void) => () => void;
  /** Callback de login chegou sem fluxo ativo (nonce perdido num restart) — o
   *  renderer pede pro usuário clicar em Entrar de novo em vez de falhar calado. */
  onCloudAuthError: (listener: (event: { reason: 'no-pending-state' }) => void) => () => void;
  /** Nova versão baixada pelo auto-updater (Win/Linux) — pronta pra reiniciar. */
  onUpdateDownloaded: (listener: (event: { version: string }) => void) => () => void;
  /** Progresso do download IN-APP da atualização (modal de update). */
  onUpdateDownloadProgress: (
    listener: (event: { percent: number; done: boolean; failed?: boolean }) => void,
  ) => () => void;
  /** Progresso do download dos modelos locais (embeddings + fast-apply) no 1º uso. */
  onModelDownloadProgress: (
    listener: (event: {
      label: string;
      index: number;
      total: number;
      percent: number;
      done: boolean;
      failed?: boolean;
    }) => void,
  ) => () => void;
  /** Output (stdout/stderr) de um terminal do PTY. */
  onTerminalData: (listener: (event: { id: string; data: string }) => void) => () => void;
  /** Um terminal terminou (processo saiu). */
  onTerminalExit: (listener: (event: { id: string; exitCode: number }) => void) => () => void;
  /** Terminal criado FORA do renderer (ex.: pelo agente via MCP) — pra aparecer ao vivo. */
  onTerminalCreated: (
    listener: (event: { id: string; sourceId: string; command: string }) => void,
  ) => () => void;
  /** URL de dev server detectada na saída de um terminal (pro Preview auto-abrir). */
  onTerminalUrlDetected: (listener: (event: { id: string; url: string }) => void) => () => void;
  /** Saída (logs) de um container Docker. */
  onDockerLogsData: (listener: (event: { id: string; chunk: string }) => void) => () => void;
  /** Métricas (CPU/RAM/Rede/Disco) de um container Docker. */
  onDockerStatsData: (
    listener: (event: {
      id: string;
      cpuPercent: number;
      memUsedMb: number;
      memLimitMb: number;
      netKbps: number;
      diskMbps: number;
    }) => void,
  ) => () => void;
  /** Saída de uma sessão exec (shell) num container Docker. */
  onDockerExecData: (listener: (event: { execId: string; data: string }) => void) => () => void;
  /** Sessão exec do Docker terminou. */
  onDockerExecExit: (listener: (event: { execId: string }) => void) => () => void;
  /** Algo mudou nos containers (nasceu/morreu) — pedir refetch da lista. */
  onDockerContainersChanged: (listener: (event: { reason: string }) => void) => () => void;
  /** O agente do chat editou um arquivo de FATO neste turno → recarregar o preview/editor
   *  (o HMR do dev server nem sempre pega a mudança). */
  onPreviewReload: (listener: () => void) => () => void;
  /** Conta de canal (WhatsApp) mudou de estado (QR novo, conectou, caiu) — a UI
   *  atualiza o card em tempo real com o snapshot recebido. */
  onChannelAccountUpdated: (listener: (event: ChannelAccountSnapshot) => void) => () => void;
  /** Teams: código de device login disponível durante o "Criar app" (a UI mostra
   *  o código + botão pra abrir a página, igual GitHub). */
  onTeamsLoginCode: (listener: (event: { code: string; url: string }) => void) => () => void;
  /** Tray (barra de menu) "Preferências…" → abre as Configurações no renderer. */
  onOpenSettings: (listener: () => void) => () => void;
}

function buildEvents(): OrkestralEvents {
  return {
    onChatStream(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: ChatStreamEvent) => listener(payload);
      ipcRenderer.on('chat:stream', wrapped);
      return () => ipcRenderer.removeListener('chat:stream', wrapped);
    },
    onPreviewReload(listener) {
      const wrapped = () => listener();
      ipcRenderer.on('preview:reload', wrapped);
      return () => ipcRenderer.removeListener('preview:reload', wrapped);
    },
    onChannelAccountUpdated(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: ChannelAccountSnapshot) => listener(payload);
      ipcRenderer.on('channels:account-updated', wrapped);
      return () => ipcRenderer.removeListener('channels:account-updated', wrapped);
    },
    onTeamsLoginCode(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { code: string; url: string }) =>
        listener(payload);
      ipcRenderer.on('channels:teams-login-code', wrapped);
      return () => ipcRenderer.removeListener('channels:teams-login-code', wrapped);
    },
    onOpenSettings(listener) {
      const wrapped = () => listener();
      ipcRenderer.on('app:open-settings', wrapped);
      return () => ipcRenderer.removeListener('app:open-settings', wrapped);
    },
    onChatQueueChanged(listener) {
      const wrapped = (
        _e: IpcRendererEvent,
        payload: { sessionId: string; items: ChatQueueItem[] },
      ) => listener(payload);
      ipcRenderer.on('chat:queue-changed', wrapped);
      return () => ipcRenderer.removeListener('chat:queue-changed', wrapped);
    },
    onCodeReviewEvent(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: CodeReviewEvent) => listener(payload);
      ipcRenderer.on('code-review:event', wrapped);
      return () => ipcRenderer.removeListener('code-review:event', wrapped);
    },
    onSourceCloneEvent(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: SourceCloneEvent) => listener(payload);
      ipcRenderer.on('source:clone-event', wrapped);
      return () => ipcRenderer.removeListener('source:clone-event', wrapped);
    },
    onKbAnalyzeEvent(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: KbAnalyzeEvent) => listener(payload);
      ipcRenderer.on('kb:analyze-event', wrapped);
      return () => ipcRenderer.removeListener('kb:analyze-event', wrapped);
    },
    onKbEmbeddingEvent(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: KbEmbeddingEvent) => listener(payload);
      ipcRenderer.on('kb:embedding-event', wrapped);
      return () => ipcRenderer.removeListener('kb:embedding-event', wrapped);
    },
    onIssueExecutionEvent(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: IssueExecutionEvent) => listener(payload);
      ipcRenderer.on('issue:execution-event', wrapped);
      return () => ipcRenderer.removeListener('issue:execution-event', wrapped);
    },
    onLogEntry(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: TraceEntry) => listener(payload);
      ipcRenderer.on('logs:entry', wrapped);
      return () => ipcRenderer.removeListener('logs:entry', wrapped);
    },
    onAgentTraceEvent(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: AgentTraceEvent) => listener(payload);
      ipcRenderer.on('agent-trace:event', wrapped);
      return () => ipcRenderer.removeListener('agent-trace:event', wrapped);
    },
    onVoiceInstallProgress(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: VoiceInstallEvent) => listener(payload);
      ipcRenderer.on('voice:install-progress', wrapped);
      return () => ipcRenderer.removeListener('voice:install-progress', wrapped);
    },
    onChatSessionReady(listener) {
      const wrapped = (
        _e: IpcRendererEvent,
        payload: { workspaceId: string; sessionId: string; reason: string },
      ) => listener(payload);
      ipcRenderer.on('chat:session-ready', wrapped);
      return () => ipcRenderer.removeListener('chat:session-ready', wrapped);
    },
    onInboxProposal(listener) {
      const wrapped = (
        _e: IpcRendererEvent,
        payload: {
          workspaceId: string;
          sourceId: string;
          sourceLabel: string;
          recommendedAgentName: string | null;
          title: string;
        },
      ) => listener(payload);
      ipcRenderer.on('inbox:proposal-created', wrapped);
      return () => ipcRenderer.removeListener('inbox:proposal-created', wrapped);
    },
    onIssuesChanged(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: IssuesChangedEvent) => listener(payload);
      ipcRenderer.on('issues:changed-by-mcp', wrapped);
      // Também escuta o canal de chat (criação via bloco markdown), encaminhando
      // pro mesmo handler — UI só precisa saber "algo mudou" + workspaceId.
      const wrapped2 = (_e: IpcRendererEvent, payload: { workspaceId: string; count: number }) =>
        listener({ workspaceId: payload.workspaceId, reason: 'chat-blocks' });
      ipcRenderer.on('issues:created-by-chat', wrapped2);
      return () => {
        ipcRenderer.removeListener('issues:changed-by-mcp', wrapped);
        ipcRenderer.removeListener('issues:created-by-chat', wrapped2);
      };
    },
    onCloudAuthChanged(listener) {
      const wrapped = (
        _e: IpcRendererEvent,
        payload: { account: { email: string; name: string | null } | null },
      ) => listener(payload);
      ipcRenderer.on('cloud:auth-changed', wrapped);
      return () => ipcRenderer.removeListener('cloud:auth-changed', wrapped);
    },
    onPreviewChanged(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { workspaceId: string }) => listener(payload);
      ipcRenderer.on('preview:changed', wrapped);
      return () => ipcRenderer.removeListener('preview:changed', wrapped);
    },
    onCloudAuthError(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { reason: 'no-pending-state' }) =>
        listener(payload);
      ipcRenderer.on('cloud:auth-error', wrapped);
      return () => ipcRenderer.removeListener('cloud:auth-error', wrapped);
    },
    onUpdateDownloaded(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { version: string }) => listener(payload);
      ipcRenderer.on('update:downloaded', wrapped);
      return () => ipcRenderer.removeListener('update:downloaded', wrapped);
    },
    onUpdateDownloadProgress(listener) {
      const wrapped = (
        _e: IpcRendererEvent,
        payload: { percent: number; done: boolean; failed?: boolean },
      ) => listener(payload);
      ipcRenderer.on('update:download-progress', wrapped);
      return () => ipcRenderer.removeListener('update:download-progress', wrapped);
    },
    onModelDownloadProgress(listener) {
      const wrapped = (
        _e: IpcRendererEvent,
        payload: {
          label: string;
          index: number;
          total: number;
          percent: number;
          done: boolean;
          failed?: boolean;
        },
      ) => listener(payload);
      ipcRenderer.on('models:download-progress', wrapped);
      return () => ipcRenderer.removeListener('models:download-progress', wrapped);
    },
    onTerminalData(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { id: string; data: string }) =>
        listener(payload);
      ipcRenderer.on('terminal:data', wrapped);
      return () => ipcRenderer.removeListener('terminal:data', wrapped);
    },
    onTerminalExit(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { id: string; exitCode: number }) =>
        listener(payload);
      ipcRenderer.on('terminal:exit', wrapped);
      return () => ipcRenderer.removeListener('terminal:exit', wrapped);
    },
    onTerminalCreated(listener) {
      const wrapped = (
        _e: IpcRendererEvent,
        payload: { id: string; sourceId: string; command: string },
      ) => listener(payload);
      ipcRenderer.on('terminal:created', wrapped);
      return () => ipcRenderer.removeListener('terminal:created', wrapped);
    },
    onTerminalUrlDetected(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { id: string; url: string }) =>
        listener(payload);
      ipcRenderer.on('terminal:url-detected', wrapped);
      return () => ipcRenderer.removeListener('terminal:url-detected', wrapped);
    },
    onDockerLogsData(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { id: string; chunk: string }) =>
        listener(payload);
      ipcRenderer.on('docker:logs-data', wrapped);
      return () => ipcRenderer.removeListener('docker:logs-data', wrapped);
    },
    onDockerStatsData(listener) {
      const wrapped = (
        _e: IpcRendererEvent,
        payload: {
          id: string;
          cpuPercent: number;
          memUsedMb: number;
          memLimitMb: number;
          netKbps: number;
          diskMbps: number;
        },
      ) => listener(payload);
      ipcRenderer.on('docker:stats-data', wrapped);
      return () => ipcRenderer.removeListener('docker:stats-data', wrapped);
    },
    onDockerExecData(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { execId: string; data: string }) =>
        listener(payload);
      ipcRenderer.on('docker:exec-data', wrapped);
      return () => ipcRenderer.removeListener('docker:exec-data', wrapped);
    },
    onDockerExecExit(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { execId: string }) => listener(payload);
      ipcRenderer.on('docker:exec-exit', wrapped);
      return () => ipcRenderer.removeListener('docker:exec-exit', wrapped);
    },
    onDockerContainersChanged(listener) {
      const wrapped = (_e: IpcRendererEvent, payload: { reason: string }) => listener(payload);
      ipcRenderer.on('docker:containers-changed', wrapped);
      return () => ipcRenderer.removeListener('docker:containers-changed', wrapped);
    },
  };
}

const orkestralApi = buildOrkestralApi();
const orkestralEvents = buildEvents();

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('orkestral', orkestralApi);
    contextBridge.exposeInMainWorld('orkestralEvents', orkestralEvents);
  } catch (error) {
    console.error('preload exposeInMainWorld failed', error);
  }
} else {
  (window as unknown as { electron: typeof electronAPI }).electron = electronAPI;
  (window as unknown as { orkestral: OrkestralApi }).orkestral = orkestralApi;
  (window as unknown as { orkestralEvents: OrkestralEvents }).orkestralEvents = orkestralEvents;
}
