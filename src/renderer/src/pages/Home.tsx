import { useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, X } from 'lucide-react';
import { ChatPrompt } from '@renderer/components/chat/ChatPrompt';
import { SuggestionCards, type Suggestion } from '@renderer/components/chat/SuggestionCards';
import { MessagingChannelsBanner } from '@renderer/components/chat/MessagingChannelsBanner';
import { TopToolbar } from '@renderer/components/chat/TopToolbar';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useChatStore } from '@renderer/stores/chatStore';
import { toast } from '@renderer/stores/toastStore';
import { HOME_DRAFT_KEY } from '@renderer/stores/draftStore';
import { useT } from '@renderer/i18n';
import type { ChatAttachment, ChatSession } from '@shared/types';

export function Home() {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspace = useWorkspaceStore((s) => s.active);
  const upsertSession = useChatStore((s) => s.upsertSession);
  const addOptimisticUserMessage = useChatStore((s) => s.addOptimisticUserMessage);
  const reconcileOptimisticUserMessage = useChatStore((s) => s.reconcileOptimisticUserMessage);
  const failOptimisticUserMessage = useChatStore((s) => s.failOptimisticUserMessage);
  // Trava síncrona: navegamos na hora, mas blinda contra duplo-disparo no mesmo tick.
  const creatingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Sugestões GENÉRICAS baseadas no que o usuário escolheu no onboarding
  // (workspace.objectives). "Mais sugestões" rotaciona o pool; mais tarde o Forge
  // gera sugestões contextuais (próximo passo). Fallback: sugestões padrão.
  const [suggestionOffset, setSuggestionOffset] = useState(0);
  const suggestionPool = useMemo<Suggestion[]>(() => {
    const byObjective: Record<string, string> = {
      'code-review': t('dashboard.home.objectiveSuggestions.codeReview'),
      'code-build': t('dashboard.home.objectiveSuggestions.codeBuild'),
      bugfix: t('dashboard.home.objectiveSuggestions.bugfix'),
      architecture: t('dashboard.home.objectiveSuggestions.architecture'),
      refactor: t('dashboard.home.objectiveSuggestions.refactor'),
      performance: t('dashboard.home.objectiveSuggestions.performance'),
      docs: t('dashboard.home.objectiveSuggestions.docs'),
      tests: t('dashboard.home.objectiveSuggestions.tests'),
      security: t('dashboard.home.objectiveSuggestions.security'),
      'ci-cd': t('dashboard.home.objectiveSuggestions.cicd'),
    };
    const fromObjectives: Suggestion[] = (workspace?.objectives ?? [])
      .filter((id) => byObjective[id])
      .map((id) => ({ id, text: byObjective[id] }));
    const generic: Suggestion[] = [
      { id: 'memory', text: t('dashboard.home.suggestions.memory') },
      { id: 'routines', text: t('dashboard.home.suggestions.routines') },
      { id: 'createIssue', text: t('dashboard.home.suggestions.createIssue') },
    ];
    const seen = new Set<string>();
    return [...fromObjectives, ...generic].filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }, [workspace?.objectives, t]);
  const visibleSuggestions =
    suggestionPool.length <= 4
      ? suggestionPool
      : Array.from(
          { length: 4 },
          (_, i) => suggestionPool[(suggestionOffset + i) % suggestionPool.length],
        );

  // Lista de agentes do workspace (pro selector e pro padrão Orchestrator)
  const agentsQuery = useQuery({
    queryKey: ['agents', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: workspace!.id }),
  });

  const defaultAgent = agentsQuery.data?.find((a) => a.isOrchestrator) ?? agentsQuery.data?.[0];
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);
  const currentAgent = agentsQuery.data?.find((a) => a.id === selectedAgentId) ?? defaultAgent;

  // Cria a sessão no backend com o id que JÁ navegamos. Reconcilia o store ao
  // voltar; em erro, marca a mensagem otimista como falha + toast.
  const createSessionMutation = useMutation({
    mutationFn: async (input: {
      sessionId: string;
      tempId: string;
      content: string;
      attachments?: ChatAttachment[];
    }) => {
      if (!workspace || !currentAgent) {
        throw new Error(t('dashboard.home.workspaceOrAgentUnavailable'));
      }
      return window.orkestral['session:create']({
        workspaceId: workspace.id,
        agentId: currentAgent.id,
        sessionId: input.sessionId,
        firstMessage: input.content,
        attachments: input.attachments,
      });
    },
    onSuccess: ({ session, messages }, { sessionId, tempId }) => {
      // O backend devolve a lista canônica: reconcilia o id da msg otimista (1ª
      // user msg da sessão nova) pra o upsert não duplicar a mensagem.
      const realUserId = messages.find((m) => m.role === 'user')?.id;
      if (realUserId) reconcileOptimisticUserMessage(sessionId, tempId, realUserId);
      upsertSession(session, messages);
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err, { sessionId, tempId }) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[home] criar sessão falhou:', err);
      failOptimisticUserMessage(sessionId, tempId, message);
      toast.error(t('dashboard.home.startError'), message);
    },
    onSettled: () => {
      creatingRef.current = false;
    },
  });

  function handleSubmit(content: string, attachments?: ChatAttachment[]) {
    // Dedupe: sem isso, clicar 2x numa sugestão antes de navegar criava N chats.
    if (creatingRef.current) return;
    if (!workspace || !currentAgent) {
      setSubmitError(t('dashboard.home.workspaceOrAgentUnavailable'));
      return;
    }
    const hasContent = content.trim().length > 0 || (attachments && attachments.length > 0);
    if (!hasContent) return;

    creatingRef.current = true;
    setSubmitError(null);
    const sessionId = crypto.randomUUID();
    const tempId = `temp:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();
    const optimisticSession: ChatSession = {
      id: sessionId,
      workspaceId: workspace.id,
      agentId: currentAgent.id,
      title: content.trim().slice(0, 60) || 'Nova conversa',
      lastModel: null,
      lastDirectory: null,
      isArchived: false,
      channelType: null,
      createdAt: now,
      updatedAt: now,
    };
    // Pré-popula o store + navega NA HORA: o SessionPage lê do store (e o
    // session:get só hidrata quando o store está vazio), então a conversa e a
    // mensagem aparecem instantâneas, sem esperar o round-trip.
    upsertSession(optimisticSession, []);
    addOptimisticUserMessage(sessionId, tempId, content, attachments);
    navigate(`/session/${sessionId}`);
    createSessionMutation.mutate({ sessionId, tempId, content, attachments });
  }

  const isCreating = createSessionMutation.isPending;

  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <TopToolbar />
        <div className="window-no-drag flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-8 pt-8">
          <div className="w-full max-w-3xl mt-[10vh]">
            <h2 className="mb-6 text-center text-[22px] font-medium tracking-tight text-text-primary">
              {t('dashboard.home.greeting')}
            </h2>

            {submitError && (
              <div className="mx-auto mb-4 flex max-w-2xl items-start gap-2.5 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
                <div className="flex-1 text-[12.5px] text-text-primary">
                  <div className="font-medium text-accent-red">
                    {t('dashboard.home.startError')}
                  </div>
                  <div className="mt-0.5 text-text-secondary">{submitError}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setSubmitError(null)}
                  className="ml-1 grid h-5 w-5 place-items-center rounded text-text-muted hover:bg-surface-active hover:text-text-primary"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            <ChatPrompt
              placeholder={
                currentAgent
                  ? t('dashboard.home.askAgent', { name: currentAgent.name })
                  : t('dashboard.home.askOrkestral')
              }
              onSubmit={handleSubmit}
              streaming={isCreating}
              agents={agentsQuery.data}
              currentAgent={currentAgent}
              onAgentChange={setSelectedAgentId}
              draftKey={HOME_DRAFT_KEY}
              tall
              footer={<MessagingChannelsBanner />}
            />

            <div className="mt-6 px-6">
              <SuggestionCards
                suggestions={visibleSuggestions}
                onSelect={(value) => handleSubmit(value)}
                label={t('dashboard.home.suggestions.header')}
                onRefresh={
                  suggestionPool.length > 4
                    ? () => setSuggestionOffset((o) => (o + 4) % suggestionPool.length)
                    : undefined
                }
                refreshLabel={t('dashboard.home.suggestions.refresh')}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
