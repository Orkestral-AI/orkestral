/**
 * Web bridge — faz a UI rodar num BROWSER PURO falando com o gateway HTTP
 * (`orkestral serve`), sem tocar em nenhuma página.
 *
 * No app desktop o preload injeta `window.orkestral` (ipcRenderer.invoke) e
 * `window.orkestralEvents` (webContents.send). Aqui, quando o preload NÃO
 * existe, instalamos os mesmos dois globais com o mesmo formato:
 *   - window.orkestral[canal](request)  →  POST /api/ipc/<canal>
 *   - window.orkestralEvents.onX(fn)    →  SSE /api/events filtrado por canal
 *
 * IMPORTANTE: este módulo precisa ser o PRIMEIRO import do main.tsx — os
 * globais têm que existir antes de qualquer store/página avaliar.
 *
 * Evento push novo no preload exige espelhar o mapeamento onX→canal aqui
 * (mesma regra do getChatExpectedHandles: os dois lados andam juntos).
 */
import { IPC_CHANNELS, type OrkestralApi } from '@shared/ipc-contract';
import { GATEWAY_API_IPC_PATH, GATEWAY_EVENTS_PATH } from '@shared/gateway';

type OrkestralEvents = Window['orkestralEvents'];
type PushListener = (payload: unknown) => void;

const TOKEN_STORAGE_KEY = 'orkestral:gateway-token';

/**
 * Token vem no fragment da URL impressa pelo CLI (`/#token=<hex>`) — fragment
 * nunca chega ao servidor/logs. Persistimos e limpamos o hash ANTES do
 * HashRouter montar, senão ele leria `token=...` como rota.
 */
function resolveToken(): string | null {
  const match = window.location.hash.match(/token=([0-9a-f]{32,})/i);
  if (match) {
    localStorage.setItem(TOKEN_STORAGE_KEY, match[1]);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return match[1];
  }
  const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (stored) return stored;
  // Sem token salvo nem na URL: pede uma vez (o CLI imprime o token no boot).
  const typed = window.prompt('Token do gateway Orkestral (veja a saída de `orkestral serve`):');
  if (typed?.trim()) {
    localStorage.setItem(TOKEN_STORAGE_KEY, typed.trim());
    return typed.trim();
  }
  return null;
}

function installWebBridge(): void {
  const token = resolveToken();
  if (!token) {
    console.error('[web-bridge] sem token do gateway — toda chamada à API vai falhar com 401.');
  }

  async function invoke(channel: string, request?: unknown): Promise<unknown> {
    const res = await fetch(`${GATEWAY_API_IPC_PATH}/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      // {"request": ...} preserva undefined (chave ausente) vs null explícito
      body: JSON.stringify(request === undefined ? {} : { request }),
    });
    if (res.status === 401) {
      // token revogado/errado: limpa pra próxima visita pedir de novo
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      response?: unknown;
      error?: string;
    } | null;
    if (!res.ok || !body?.ok) {
      throw new Error(body?.error ?? `gateway respondeu HTTP ${res.status}`);
    }
    return body.response;
  }

  // --- window.orkestral: mesmo shape do preload (um método por canal) -------
  const api = {} as Record<string, (request?: unknown) => Promise<unknown>>;
  for (const channel of IPC_CHANNELS) {
    api[channel] = (request?: unknown) => invoke(channel, request);
  }

  // --- window.orkestralEvents: UM EventSource, dispatch por canal -----------
  const listeners = new Map<string, Set<PushListener>>();
  let source: EventSource | null = null;

  function ensureSource(): void {
    if (source) return;
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    source = new EventSource(`${GATEWAY_EVENTS_PATH}${qs}`);
    source.onmessage = (e: MessageEvent<string>) => {
      let parsed: { channel: string; payload: unknown };
      try {
        parsed = JSON.parse(e.data) as { channel: string; payload: unknown };
      } catch {
        return;
      }
      listeners.get(parsed.channel)?.forEach((listener) => listener(parsed.payload));
    };
    // EventSource reconecta sozinho; só logamos pra debug
    source.onerror = () => console.warn('[web-bridge] SSE caiu — reconectando…');
  }

  function subscribe(channel: string, listener: PushListener): () => void {
    ensureSource();
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(listener);
    return () => listeners.get(channel)?.delete(listener);
  }

  const events: OrkestralEvents = {
    onChatStream: (l) => subscribe('chat:stream', l as PushListener),
    onChatQueueChanged: (l) => subscribe('chat:queue-changed', l as PushListener),
    onCodeReviewEvent: (l) => subscribe('code-review:event', l as PushListener),
    onSourceCloneEvent: (l) => subscribe('source:clone-event', l as PushListener),
    onKbAnalyzeEvent: (l) => subscribe('kb:analyze-event', l as PushListener),
    onKbEmbeddingEvent: (l) => subscribe('kb:embedding-event', l as PushListener),
    onIssueExecutionEvent: (l) => subscribe('issue:execution-event', l as PushListener),
    onLogEntry: (l) => subscribe('logs:entry', l as PushListener),
    onAgentTraceEvent: (l) => subscribe('agent-trace:event', l as PushListener),
    onVoiceInstallProgress: (l) => subscribe('voice:install-progress', l as PushListener),
    onChatSessionReady: (l) => subscribe('chat:session-ready', l as PushListener),
    onInboxProposal: (l) => subscribe('inbox:proposal-created', l as PushListener),
    onCloudAuthChanged: (l) => subscribe('cloud:auth-changed', l as PushListener),
    onPreviewChanged: (l) => subscribe('preview:changed', l as PushListener),
    onCloudAuthError: (l) => subscribe('cloud:auth-error', l as PushListener),
    onUpdateDownloaded: (l) => subscribe('update:downloaded', l as PushListener),
    onUpdateDownloadProgress: (l) => subscribe('update:download-progress', l as PushListener),
    onModelDownloadProgress: (l) => subscribe('models:download-progress', l as PushListener),
    onTerminalData: (l) => subscribe('terminal:data', l as PushListener),
    onTerminalExit: (l) => subscribe('terminal:exit', l as PushListener),
    onTerminalCreated: (l) => subscribe('terminal:created', l as PushListener),
    onTerminalUrlDetected: (l) => subscribe('terminal:url-detected', l as PushListener),
    onDockerLogsData: (l) => subscribe('docker:logs-data', l as PushListener),
    onDockerStatsData: (l) => subscribe('docker:stats-data', l as PushListener),
    onDockerExecData: (l) => subscribe('docker:exec-data', l as PushListener),
    onDockerExecExit: (l) => subscribe('docker:exec-exit', l as PushListener),
    onDockerContainersChanged: (l) => subscribe('docker:containers-changed', l as PushListener),
    onPreviewReload: (l) => subscribe('preview:reload', l as PushListener),
    onChannelAccountUpdated: (l) => subscribe('channels:account-updated', l as PushListener),
    onTeamsLoginCode: (l) => subscribe('channels:teams-login-code', l as PushListener),
    onOpenSettings: (l) => subscribe('app:open-settings', l as PushListener),
    // Espelha o preload: dois canais alimentam o mesmo handler, com o payload
    // de `issues:created-by-chat` normalizado pro shape de IssuesChangedEvent.
    onIssuesChanged: (l) => {
      const un1 = subscribe('issues:changed-by-mcp', l as PushListener);
      const un2 = subscribe('issues:created-by-chat', (payload) => {
        const p = payload as { workspaceId: string; count: number };
        l({ workspaceId: p.workspaceId, reason: 'chat-blocks' });
      });
      return () => {
        un1();
        un2();
      };
    },
  };

  window.orkestral = api as OrkestralApi;
  window.orkestralEvents = events;
}

// Browser puro = preload ausente = window.orkestral não existe.
if (typeof window !== 'undefined' && !window.orkestral) {
  installWebBridge();
}

export {};
