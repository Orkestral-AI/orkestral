/**
 * ChatSurface — slim reusable chat surface (message list + composer) bound to a
 * sessionId. Designed to be embedded in contexts like an IDE drawer.
 *
 * - Reuses existing MessageList and ChatPrompt without reinventing them.
 * - Mirrors the minimal send path from SessionPage (optimistic + IPC).
 * - When sessionId === 'new', creates a session via session:create IPC on first
 *   submit, then calls onSessionCreated(newId).
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatAttachment, ChatMessage } from '@shared/types';
import { useChatStore } from '@renderer/stores/chatStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { HOME_DRAFT_KEY } from '@renderer/stores/draftStore';
import { MessageList } from './MessageList';
import { ChatPrompt } from './ChatPrompt';
import { chatModelLabel } from './chat-labels';

// Referência ESTÁVEL — selector do zustand não pode retornar um [] novo a cada
// render (gera loop infinito de re-render via useSyncExternalStore).
const EMPTY_MESSAGES: ChatMessage[] = [];

// ─────────────────────────────────────────────────────────────────────────────

export interface ChatSurfaceProps {
  /**
   * The session to display and send to. Pass `'new'` to start a brand-new
   * session: on first submit it will be created via `session:create` IPC and
   * `onSessionCreated` will be called with the resulting id.
   */
  sessionId: string | 'new';
  /** Called after the new session is created (only relevant when sessionId === 'new'). */
  onSessionCreated?: (id: string) => void;
  /** Rendered just above the ChatPrompt input (e.g. selection chips). */
  composerExtras?: React.ReactNode;
  /** Optional transform applied to the content string before it is sent. */
  transformContent?: (content: string) => string;
  /** Called after a successful send (both new-session and existing-session paths). */
  afterSend?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────

export function ChatSurface({
  sessionId,
  onSessionCreated,
  composerExtras,
  transformContent,
  afterSend,
}: ChatSurfaceProps) {
  const queryClient = useQueryClient();
  const workspace = useWorkspaceStore((s) => s.active);

  // ── Store actions ──────────────────────────────────────────────────────────
  const messages = useChatStore((s) =>
    sessionId === 'new' ? EMPTY_MESSAGES : (s.sessions[sessionId]?.messages ?? EMPTY_MESSAGES),
  );
  const addOptimisticUserMessage = useChatStore((s) => s.addOptimisticUserMessage);
  const reconcileOptimisticUserMessage = useChatStore((s) => s.reconcileOptimisticUserMessage);
  const failOptimisticUserMessage = useChatStore((s) => s.failOptimisticUserMessage);
  const upsertSession = useChatStore((s) => s.upsertSession);
  const removeSession = useChatStore((s) => s.removeSession);

  // Carrega o histórico da sessão escolhida (mesmo chat do app) — sem isso o drawer
  // só veria mensagens de sessões já abertas na SessionPage. Espelha a SessionPage.
  const sessionQuery = useQuery({
    queryKey: ['session', sessionId],
    enabled: sessionId !== 'new',
    queryFn: () => window.orkestral['session:get']({ sessionId: sessionId as string }),
  });
  useEffect(() => {
    if (sessionQuery.data) upsertSession(sessionQuery.data.session, sessionQuery.data.messages);
  }, [sessionQuery.data, upsertSession]);

  // ── Agents (for ChatPrompt agent picker) ──────────────────────────────────
  const agentsQuery = useQuery({
    queryKey: ['agents', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: workspace!.id }),
  });

  // Nome do usuário pro subtítulo das mensagens (mesma queryKey da SessionPage → cache compartilhado).
  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: () => window.orkestral['user:get'](),
  });

  // For an existing session, pick the session's own agent; for 'new', use the
  // orchestrator / first available agent (same as Home.tsx).
  const sessionState = useChatStore((s) =>
    sessionId !== 'new' ? s.sessions[sessionId] : undefined,
  );
  const defaultAgent = agentsQuery.data?.find((a) => a.isOrchestrator) ?? agentsQuery.data?.[0];
  // Sessão nova: o usuário pode trocar o agente no picker antes de mandar (default =
  // orquestrador). Sessão existente: trava no agente da própria sessão.
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);
  const currentAgent =
    sessionId !== 'new'
      ? agentsQuery.data?.find((a) => a.id === sessionState?.session.agentId)
      : (agentsQuery.data?.find((a) => a.id === pickedAgentId) ?? defaultAgent);

  // ── Error state ────────────────────────────────────────────────────────────
  const [sendError, setSendError] = useState<string | null>(null);

  // ── Send handler ──────────────────────────────────────────────────────────
  const onSend = useCallback(
    async (rawContent: string, attachments?: ChatAttachment[]) => {
      const content = transformContent ? transformContent(rawContent) : rawContent;

      // ── NEW SESSION path ─────────────────────────────────────────────────
      if (sessionId === 'new') {
        if (!workspace || !currentAgent) {
          setSendError('Workspace or agent not available.');
          return;
        }
        setSendError(null);
        // Otimismo imediato: planta uma sessão placeholder + bolha do usuário no
        // store ANTES do round-trip de `session:create` e aponta o drawer pra ela,
        // pra bolha aparecer na hora (a query do `messages` é gated em sessionId
        // !== 'new'). Reconciliação acontece quando o id real chega.
        const tempSessionId = `temp:session:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
        const tempMessageId = `temp:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
        const now = new Date().toISOString();
        const placeholderSession = {
          id: tempSessionId,
          workspaceId: workspace.id,
          agentId: currentAgent.id,
          title: content,
          createdAt: now,
          updatedAt: now,
        };
        upsertSession(placeholderSession);
        addOptimisticUserMessage(tempSessionId, tempMessageId, content, attachments);
        onSessionCreated?.(tempSessionId);
        try {
          const { session, messages: initialMessages } = await window.orkestral['session:create']({
            workspaceId: workspace.id,
            agentId: currentAgent.id,
            firstMessage: content,
            attachments,
          });
          // Reconcilia: cria a sessão real (initialMessages já traz a mensagem do
          // user persistida), aponta o drawer pra ela e remove o placeholder temp.
          upsertSession(session, initialMessages);
          onSessionCreated?.(session.id);
          removeSession(tempSessionId);
          queryClient.invalidateQueries({ queryKey: ['sessions'] });
          afterSend?.();
        } catch (err) {
          // Mantém a bolha visível marcada como falha (não some o que o usuário
          // digitou) — o drawer segue apontado pro placeholder temp.
          const message = err instanceof Error ? err.message : String(err);
          failOptimisticUserMessage(tempSessionId, tempMessageId, message);
          setSendError(message);
        }
        return;
      }

      // ── EXISTING SESSION path ─────────────────────────────────────────────
      setSendError(null);
      const tempId = `temp:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
      addOptimisticUserMessage(sessionId, tempId, content, attachments);
      try {
        const result = await window.orkestral['chat:send']({
          sessionId,
          content,
          attachments,
        });
        reconcileOptimisticUserMessage(sessionId, tempId, result.userMessageId);
        queryClient.invalidateQueries({ queryKey: ['sessions'] });
        afterSend?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failOptimisticUserMessage(sessionId, tempId, message);
        setSendError(message);
      }
    },
    [
      sessionId,
      workspace,
      currentAgent,
      transformContent,
      afterSend,
      addOptimisticUserMessage,
      reconcileOptimisticUserMessage,
      failOptimisticUserMessage,
      upsertSession,
      removeSession,
      queryClient,
      onSessionCreated,
    ],
  );

  // ── Draft key ──────────────────────────────────────────────────────────────
  const draftKey = sessionId === 'new' ? HOME_DRAFT_KEY : sessionId;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Scrollable message area */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MessageList
          messages={messages}
          agentName={currentAgent?.name}
          agentAvatarSeed={currentAgent?.avatarSeed ?? null}
          allAgents={agentsQuery.data ?? []}
          userName={userQuery.data?.name}
          buildLabel="Build"
          modelLabel={chatModelLabel(currentAgent, agentsQuery.data ?? [])}
          compact
        />
      </div>

      {/* Optional extras above the composer (e.g. selection chips) */}
      {composerExtras}

      {/* Error banner */}
      {sendError && (
        <div className="mx-4 mb-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-400">
          {sendError}
        </div>
      )}

      {/* Composer */}
      <ChatPrompt
        onSubmit={onSend}
        draftKey={draftKey}
        expand
        agents={agentsQuery.data}
        currentAgent={currentAgent}
        onAgentChange={sessionId === 'new' ? setPickedAgentId : undefined}
      />
    </div>
  );
}
