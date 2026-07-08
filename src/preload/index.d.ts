import type { ElectronAPI } from '@electron-toolkit/preload';
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

export interface IssuesChangedEvent {
  workspaceId: string;
  reason: string;
}

export interface OrkestralEvents {
  onChatStream: (listener: (event: ChatStreamEvent) => void) => () => void;
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
  onChatSessionReady: (
    listener: (event: { workspaceId: string; sessionId: string; reason: string }) => void,
  ) => () => void;
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
  /** O agente do chat editou um arquivo de FATO neste turno → recarregar o preview/editor. */
  onPreviewReload: (listener: () => void) => () => void;
  /** Conta de canal (WhatsApp) mudou de estado (QR novo, conectou, caiu). */
  onChannelAccountUpdated: (listener: (event: ChannelAccountSnapshot) => void) => () => void;
  /** Teams: código de device login durante o "Criar app" (mostra na UI). */
  onTeamsLoginCode: (listener: (event: { code: string; url: string }) => void) => () => void;
  /** Tray (barra de menu) "Preferências…" → abre as Configurações no renderer. */
  onOpenSettings: (listener: () => void) => () => void;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    orkestral: OrkestralApi;
    orkestralEvents: OrkestralEvents;
  }
}

export {};
