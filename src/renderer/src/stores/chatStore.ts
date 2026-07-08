import { create } from 'zustand';
import type {
  ChatAttachment,
  ChatMessage,
  ChatQueueItem,
  ChatSession,
  ChatStreamEvent,
  MessagePart,
} from '@shared/types';
import { useSessionReadStore } from './sessionReadStore';
import {
  consumeChatCompletionNotification,
  notifyAgentReply,
  notifyChatTaskDone,
} from '@renderer/lib/notify';

export type PendingMessageKind = 'queue' | 'steer';

/**
 * Item da fila exibido no composer. A fila vive no MAIN (tabela `chat_queue`) e
 * é refletida aqui via evento `chat:queue-changed` — sobrevive a reload. É um
 * subconjunto estrutural de `ChatQueueItem`.
 */
export interface PendingMessage {
  id: string;
  content: string;
  attachments?: ChatAttachment[];
  kind: PendingMessageKind;
  createdAt: string;
}

interface SessionState {
  session: ChatSession;
  messages: ChatMessage[];
  /** Quando há um run ativo, o id da run sendo streamada. */
  streamingRunId: string | null;
  /** Mensagens pendentes pra despachar quando o stream atual terminar. */
  pendingQueue: PendingMessage[];
  /** Fase atual do stream — pra UI mostrar "Pensando...", "Usando ferramenta...", etc. */
  streamingPhase?: {
    messageId: string;
    phase: 'starting' | 'thinking' | 'tool' | 'writing';
    label?: string;
  } | null;
}

interface ChatStore {
  /** Mapa sessionId → estado. */
  sessions: Record<string, SessionState>;
  /** Lista resumida pra sidebar (não tem mensagens). */
  list: ChatSession[];

  setList: (sessions: ChatSession[]) => void;
  upsertSession: (session: ChatSession, messages?: ChatMessage[]) => void;
  removeSession: (sessionId: string) => void;
  applyStreamEvent: (event: ChatStreamEvent) => void;
  /** Adiciona mensagem otimista do usuário ao store imediatamente. */
  addOptimisticUserMessage: (
    sessionId: string,
    tempId: string,
    content: string,
    attachments?: ChatAttachment[],
  ) => void;
  /** Substitui o tempId da mensagem otimista pelo realId vindo do backend. */
  reconcileOptimisticUserMessage: (sessionId: string, tempId: string, realId: string) => void;
  /** Marca uma mensagem otimista como erro (falhou no envio). */
  failOptimisticUserMessage: (sessionId: string, tempId: string, error: string) => void;
  /**
   * Substitui a fila pendente de uma sessão pela vinda do MAIN (fonte da
   * verdade). Chamado no load (`chat:queue-list`) e a cada `chat:queue-changed`.
   */
  setSessionQueue: (sessionId: string, items: ChatQueueItem[]) => void;
}

function appendDeltaToText(parts: MessagePart[], delta: string): MessagePart[] {
  // Procura a part de texto principal e anexa o delta; se não existir, cria
  const idx = parts.findIndex((p) => p.type === 'text');
  if (idx >= 0) {
    const existing = parts[idx] as Extract<MessagePart, { type: 'text' }>;
    const updated: MessagePart = { type: 'text', text: existing.text + delta };
    return [...parts.slice(0, idx), updated, ...parts.slice(idx + 1)];
  }
  return [...parts, { type: 'text', text: delta }];
}

export const useChatStore = create<ChatStore>((set) => ({
  sessions: {},
  list: [],

  setList: (sessions) => set({ list: sessions }),

  upsertSession: (session, messages) =>
    set((state) => {
      const existing = state.sessions[session.id];
      // Preserva mensagens otimistas (tempIds começam com 'temp:') quando
      // o backend devolve a lista canônica — se a otimista ainda não foi
      // reconciliada, mantém ela visível.
      let mergedMessages = messages ?? existing?.messages ?? [];
      if (existing && messages) {
        const optimistic = existing.messages.filter(
          (m) => m.id.startsWith('temp:') && !messages.some((nm) => nm.id === m.id),
        );
        if (optimistic.length > 0) {
          mergedMessages = [...messages, ...optimistic];
        }
      }
      return {
        sessions: {
          ...state.sessions,
          [session.id]: {
            session,
            messages: mergedMessages,
            streamingRunId: existing?.streamingRunId ?? null,
            pendingQueue: existing?.pendingQueue ?? [],
          },
        },
        list: state.list.find((s) => s.id === session.id)
          ? state.list.map((s) => (s.id === session.id ? session : s))
          : [session, ...state.list],
      };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const rest = { ...state.sessions };
      delete rest[sessionId];
      return {
        sessions: rest,
        list: state.list.filter((s) => s.id !== sessionId),
      };
    }),

  addOptimisticUserMessage: (sessionId, tempId, content, attachments) =>
    set((state) => {
      const current = state.sessions[sessionId];
      if (!current) return state;
      const parts: MessagePart[] = [{ type: 'text', text: content }];
      for (const att of attachments ?? []) {
        parts.push({ type: 'attachment', attachment: att });
      }
      const optimisticMsg: ChatMessage = {
        id: tempId,
        sessionId,
        role: 'user',
        parts,
        status: 'done',
        createdAt: new Date().toISOString(),
      };
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            messages: [...current.messages, optimisticMsg],
          },
        },
      };
    }),

  reconcileOptimisticUserMessage: (sessionId, tempId, realId) =>
    set((state) => {
      const current = state.sessions[sessionId];
      if (!current) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            messages: current.messages.map((m) => (m.id === tempId ? { ...m, id: realId } : m)),
          },
        },
      };
    }),

  failOptimisticUserMessage: (sessionId, tempId, error) =>
    set((state) => {
      const current = state.sessions[sessionId];
      if (!current) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            messages: current.messages.map((m) =>
              m.id === tempId
                ? {
                    ...m,
                    status: 'error' as const,
                    parts: [...m.parts, { type: 'error' as const, message: error }],
                  }
                : m,
            ),
          },
        },
      };
    }),

  setSessionQueue: (sessionId, items) =>
    set((state) => {
      const current = state.sessions[sessionId];
      if (!current) return state;
      const pendingQueue: PendingMessage[] = items.map((it) => ({
        id: it.id,
        content: it.content,
        attachments: it.attachments,
        kind: it.kind,
        createdAt: it.createdAt,
      }));
      // Idempotente: se a fila não mudou, devolve o MESMO state (mesma
      // referência) — senão a hidratação no effect viraria loop infinito de
      // render (cada chamada recriava o objeto da sessão).
      const prev = current.pendingQueue;
      const unchanged =
        prev.length === pendingQueue.length &&
        prev.every((p, i) => {
          const n = pendingQueue[i];
          return p.id === n.id && p.content === n.content && p.kind === n.kind;
        });
      if (unchanged) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...current, pendingQueue },
        },
      };
    }),

  applyStreamEvent: (event) =>
    set((state) => {
      // Alguns eventos carregam sessionId direto; nos demais, procuramos pelo messageId.
      const fromStart =
        event.type === 'message-start' ||
        event.type === 'context-compact' ||
        event.type === 'user-message'
          ? state.sessions[event.sessionId]
          : null;
      let current =
        fromStart ??
        ('messageId' in event
          ? Object.values(state.sessions).find((s) =>
              s.messages.some((m) => m.id === event.messageId),
            )
          : null);

      // Fallback pra message-end / error / tool-call quando o message ainda não
      // foi plantado no store (race com o text-delta que não chegou). Procura
      // pelo runId nos streamingRunId das sessões — isso cobre o caso de a
      // run terminar antes de qualquer chunk chegar.
      if (!current && 'runId' in event) {
        current = Object.values(state.sessions).find((s) => s.streamingRunId === event.runId);
      }

      if (!current) return state;
      const sessionId = current.session.id;

      switch (event.type) {
        case 'context-compact':
        case 'user-message': {
          const alreadyHas = current.messages.some((m) => m.id === event.message.id);
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...current,
                messages: alreadyHas
                  ? current.messages.map((m) => (m.id === event.message.id ? event.message : m))
                  : [...current.messages, event.message],
              },
            },
          };
        }
        case 'message-start': {
          // Insere a mensagem assistant vazia ANTES do refetch — assim a UI
          // já mostra o "Pensando..." (TypingDots) imediatamente, sem esperar
          // o invalidate da query terminar.
          const synthetic = 'synthetic' in event && event.synthetic === true;
          const alreadyHas = current.messages.some((m) => m.id === event.messageId);
          const messages = alreadyHas
            ? current.messages
            : [
                ...current.messages,
                {
                  id: event.messageId,
                  sessionId,
                  role: 'assistant' as const,
                  parts: [],
                  status: 'streaming' as const,
                  runId: event.runId,
                  createdAt: new Date().toISOString(),
                  ...(synthetic ? { synthetic: true } : {}),
                },
              ];
          // Mirror sintético (execução de issue em background): aparece na lista mas
          // NÃO vira o streamingRunId/streamingPhase da sessão, pra não travar o
          // composer do chat (o usuário pode mandar mensagem enquanto o time executa).
          if (synthetic) {
            return {
              sessions: { ...state.sessions, [sessionId]: { ...current, messages } },
            };
          }
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...current,
                streamingRunId: event.runId,
                messages,
                streamingPhase: {
                  messageId: event.messageId,
                  phase: 'starting',
                  label: 'Inicializando…',
                },
              },
            },
          };
        }
        case 'thinking-delta': {
          let messages = current.messages.map((m) => {
            if (m.id !== event.messageId) return m;
            const idx = m.parts.findIndex((p) => p.type === 'thinking');
            if (idx >= 0) {
              const existing = m.parts[idx] as Extract<MessagePart, { type: 'thinking' }>;
              const updated: MessagePart = {
                type: 'thinking',
                text: existing.text + event.delta,
              };
              return {
                ...m,
                parts: [...m.parts.slice(0, idx), updated, ...m.parts.slice(idx + 1)],
                status: 'streaming' as const,
              };
            }
            return {
              ...m,
              parts: [{ type: 'thinking', text: event.delta } as MessagePart, ...m.parts],
              status: 'streaming' as const,
            };
          });
          if (!messages.some((m) => m.id === event.messageId)) {
            messages = [
              ...messages,
              {
                id: event.messageId,
                sessionId,
                role: 'assistant',
                parts: [{ type: 'thinking', text: event.delta }],
                status: 'streaming',
                runId: event.runId,
                createdAt: new Date().toISOString(),
              },
            ];
          }
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...current, messages },
            },
          };
        }
        case 'phase': {
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...current,
                streamingPhase: {
                  messageId: event.messageId,
                  phase: event.phase,
                  label: event.label,
                },
              },
            },
          };
        }
        case 'text-delta': {
          const messages = current.messages.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  parts: appendDeltaToText(m.parts, event.delta),
                  status: 'streaming' as const,
                }
              : m,
          );
          // Se a mensagem ainda não está no array (race condition), insere
          if (!messages.some((m) => m.id === event.messageId)) {
            messages.push({
              id: event.messageId,
              sessionId,
              role: 'assistant',
              parts: [{ type: 'text', text: event.delta }],
              status: 'streaming',
              runId: event.runId,
              createdAt: new Date().toISOString(),
            });
          }
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...current, messages },
            },
          };
        }
        case 'text-set': {
          // SUBSTITUI a part de texto (vs append) — o build do engine-v2 redesenha a
          // checklist marcando os checkboxes ao vivo.
          const messages = current.messages.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  parts: m.parts.some((p) => p.type === 'text')
                    ? m.parts.map((p) =>
                        p.type === 'text' ? ({ type: 'text', text: event.text } as MessagePart) : p,
                      )
                    : [...m.parts, { type: 'text', text: event.text } as MessagePart],
                  status: 'streaming' as const,
                }
              : m,
          );
          if (!messages.some((m) => m.id === event.messageId)) {
            messages.push({
              id: event.messageId,
              sessionId,
              role: 'assistant',
              parts: [{ type: 'text', text: event.text }],
              status: 'streaming',
              runId: event.runId,
              createdAt: new Date().toISOString(),
            });
          }
          return {
            sessions: { ...state.sessions, [sessionId]: { ...current, messages } },
          };
        }
        case 'tool-call': {
          // Upsert por id: a mesma tool emite uma vez no início (args vazios) e
          // de novo quando os args terminam de streamar — atualizamos a linha
          // em vez de duplicar. Parts sem id (ex: codex) sempre dão append.
          const partId = event.part.type === 'tool-call' ? event.part.id : undefined;
          const messages = current.messages.map((m) => {
            if (m.id !== event.messageId) return m;
            const existingIdx = partId
              ? m.parts.findIndex((p) => p.type === 'tool-call' && p.id === partId)
              : -1;
            if (existingIdx >= 0) {
              const parts = [...m.parts];
              parts[existingIdx] = event.part;
              return { ...m, parts };
            }
            return { ...m, parts: [...m.parts, event.part] };
          });
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...current, messages },
            },
          };
        }
        case 'message-final': {
          // Parts FINAIS canônicas do DB (finishRun reescreveu o texto: refs de
          // issues, restauração do textBuffer, avisos, fallback). Substitui as
          // parts do store pelas persistidas — a UI reflete o DB sem reload.
          const messages = current.messages.map((m) =>
            m.id === event.messageId ? { ...m, parts: event.parts } : m,
          );
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...current, messages },
            },
          };
        }
        case 'message-end': {
          // Marca a mensagem como done. Se ela ainda não está no array (run
          // sem nenhum chunk), insere um stub vazio só pra fechar o ciclo.
          // Ao fechar a run, qualquer tool-call que tenha ficado 'pending'
          // (sem evento de conclusão) é assentada como 'done'/'error' — assim
          // nenhuma linha fica presa em "Procurando…" depois do turno acabar.
          const settleToolParts = (parts: MessagePart[]): MessagePart[] =>
            parts.map((p) =>
              p.type === 'tool-call' && (p.status === 'pending' || !p.status)
                ? { ...p, status: event.status === 'error' ? 'error' : 'done' }
                : p,
            );
          let messages = current.messages.map((m) =>
            m.id === event.messageId
              ? { ...m, status: event.status, parts: settleToolParts(m.parts) }
              : m,
          );
          if (!messages.some((m) => m.id === event.messageId)) {
            messages = [
              ...messages,
              {
                id: event.messageId,
                sessionId,
                role: 'assistant',
                parts: [],
                status: event.status,
                runId: event.runId,
                createdAt: new Date().toISOString(),
              },
            ];
          }
          // Bolha VAZIA: um turno (ou mirror de execução de issue) que terminou
          // sem conteúdo visível — o MAIN já deletou do DB; remove da UI AO VIVO
          // também (senão fica uma bolha @CEO vazia até o reload). Só em 'done'
          // (erro precisa aparecer). Mantém qualquer turno com texto/thinking/tool.
          if (event.status === 'done') {
            const ended = messages.find((m) => m.id === event.messageId);
            const hasVisible =
              !!ended &&
              ended.parts.some(
                (p) =>
                  (p.type === 'text' && p.text.trim().length > 0) ||
                  p.type === 'tool-call' ||
                  (p.type === 'thinking' && p.text.trim().length > 0),
              );
            if (ended && ended.role === 'assistant' && !hasVisible) {
              messages = messages.filter((m) => m.id !== event.messageId);
            }
          }
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...current,
                messages,
                // Sempre que recebemos message-end, limpamos streamingRunId se
                // ele bate. Antes verificava só por runId mas isso travava se
                // ficasse out-of-sync.
                streamingRunId:
                  current.streamingRunId === event.runId || !current.streamingRunId
                    ? null
                    : current.streamingRunId,
                streamingPhase: null,
              },
            },
          };
        }
        case 'error': {
          const messages = current.messages.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  parts: [...m.parts, { type: 'error' as const, message: event.error }],
                  status: 'error' as const,
                }
              : m,
          );
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...current, messages, streamingRunId: null, streamingPhase: null },
            },
          };
        }
        default:
          return state;
      }
    }),
}));

/**
 * Liga o listener global de chat:stream events ao chatStore.
 * Chamado uma única vez no App root.
 *
 * Defensivo: se o preload ainda não expôs `window.orkestralEvents` (dev sem
 * restart completo), loga warning e retorna noop em vez de crashar a tela.
 */
export function attachChatStreamBridge(): () => void {
  const api = (window as Window & { orkestralEvents?: { onChatStream?: unknown } }).orkestralEvents;
  if (!api || typeof api.onChatStream !== 'function') {
    console.warn(
      '[chat] window.orkestralEvents não está disponível. Reinicie o app (npm run dev).',
    );
    return () => {};
  }
  const unsubscribe = window.orkestralEvents.onChatStream((event) => {
    useChatStore.getState().applyStreamEvent(event);
    // Run terminou e a sessão NÃO está aberta → marca não-lida (feedback no
    // menu Recentes de que o agente terminou e aguarda o usuário).
    if (event.type === 'message-end') {
      const st = useChatStore.getState();
      const session = Object.values(st.sessions).find((s) =>
        s.messages.some((m) => m.id === event.messageId),
      );
      const sid = session?.session.id;
      if (sid) {
        // Sessão em outra aba → marca não-lida (feedback no menu Recentes).
        if (!window.location.hash.includes(`/session/${sid}`)) {
          useSessionReadStore.getState().markUnread(sid);
        }
        if (consumeChatCompletionNotification(sid)) {
          notifyChatTaskDone({ title: session?.session.title ?? 'Agente', sessionId: sid });
        } else {
          // Notificação nativa + som (ambos gated nas settings; nunca lança).
          // Dispara SEMPRE que a janela estiver sem foco — inclusive na sessão
          // aberta: o usuário manda o prompt e troca de app esperando o fim.
          // notifyAgentReply checa o foco internamente.
          notifyAgentReply({ title: session?.session.title ?? 'Agente', sessionId: sid });
        }
      }
    }
  });
  // Fila persistida no MAIN → reflete no store sempre que mudar (enfileirou,
  // despachou, cancelou). Sobrevive a reload (o load hidrata via chat:queue-list).
  const unsubscribeQueue =
    typeof window.orkestralEvents.onChatQueueChanged === 'function'
      ? window.orkestralEvents.onChatQueueChanged((event) => {
          useChatStore.getState().setSessionQueue(event.sessionId, event.items);
        })
      : () => {};
  return () => {
    unsubscribe();
    unsubscribeQueue();
  };
}
