import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertCircle,
  X,
  ClipboardCheck,
  ChevronRight,
  CheckCircle2,
  Circle,
  Loader2,
  Bell,
  Undo2,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { fileIconFor } from '@renderer/lib/file-icons';
import type { Issue, ChatMessage, IssueRun } from '@shared/types';
import { readPlanState } from '@shared/plan';
import {
  buildSessionCodeChangeSummary,
  type SessionCodeChangeSummary,
} from '@shared/session-progress-ui';
import { MessageList } from '@renderer/components/chat/MessageList';
import { QuestionWizard } from '@renderer/components/chat/QuestionWizard';
import {
  findLatestAskUserPayload,
  isWizardResolved,
  wizardKey,
} from '@renderer/components/chat/ask-user';
import { chatModelLabel } from '@renderer/components/chat/chat-labels';
import { renderTitleMentions } from '@renderer/components/chat/mentions';
import { ChatPrompt, type SlashCommand } from '@renderer/components/chat/ChatPrompt';
import { SessionSpecialistProposals } from '@renderer/components/chat/SessionSpecialistProposals';
import { TopToolbar } from '@renderer/components/chat/TopToolbar';
import { SessionWorkspace, type WorkspaceTab } from '@renderer/components/chat/SessionWorkspace';
import { SelectionChips, buildTransformContent } from '@renderer/components/code-ide/IdeChatDrawer';
import { useIdeChatStore } from '@renderer/stores/ideChatStore';
import { useChatStore } from '@renderer/stores/chatStore';
import { useSessionReadStore } from '@renderer/stores/sessionReadStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { ChannelIcon } from '@renderer/components/chat/ChannelIcon';
import { useScopeStore } from '@renderer/stores/scopeStore';
import { useExecutionStore } from '@renderer/stores/executionStore';
import { useT } from '@renderer/i18n';
import type { ChatAttachment } from '@shared/types';
import { armChatCompletionNotification } from '@renderer/lib/notify';
import { toast } from '@renderer/stores/toastStore';
import type { ChannelType } from '@shared/types';

/** Nome de exibição de cada canal (label "via {channel}" no cabeçalho da conversa). */
const CHANNEL_LABEL: Record<ChannelType, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
  msteams: 'Microsoft Teams',
  signal: 'Signal',
};

export function SessionPage() {
  const { t } = useT();
  const { sessionId } = useParams<{ sessionId: string }>();
  const queryClient = useQueryClient();
  const workspace = useWorkspaceStore((s) => s.active);
  const scope = useScopeStore((s) => (workspace ? s.getScope(workspace.id) : 'all'));

  const sessionState = useChatStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const upsertSession = useChatStore((s) => s.upsertSession);
  const addOptimisticUserMessage = useChatStore((s) => s.addOptimisticUserMessage);
  const reconcileOptimisticUserMessage = useChatStore((s) => s.reconcileOptimisticUserMessage);
  const failOptimisticUserMessage = useChatStore((s) => s.failOptimisticUserMessage);
  const setSessionQueue = useChatStore((s) => s.setSessionQueue);
  // Streaming = tem alguma mensagem em streaming OU runId ativo no store. Mirrors
  // sintéticos (execução de issue em background) NÃO contam: o composer fica livre
  // pra mandar mensagem enquanto o time executa as issues.
  const streaming =
    (sessionState?.messages.some((m) => m.status === 'streaming' && !m.synthetic) ?? false) ||
    !!sessionState?.streamingRunId;
  const pendingQueue = sessionState?.pendingQueue ?? [];

  const [sendError, setSendError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [wsTab, setWsTab] = useState<WorkspaceTab>('issues');
  const [planDrawerOpen, setPlanDrawerOpen] = useState(false);
  const [questionsDrawerOpen, setQuestionsDrawerOpen] = useState(false);
  // localStorage não é reativo: bump força recalcular "respondido" após o wizard enviar.
  const [questionsResolvedTick, setQuestionsResolvedTick] = useState(0);
  const [notifyPromptRunId, setNotifyPromptRunId] = useState<string | null>(null);
  const [undoneChangeSignature, setUndoneChangeSignature] = useState<string | null>(null);
  const [notifyDismissedRunId, setNotifyDismissedRunId] = useState<string | null>(null);
  const [notifyArmedRunId, setNotifyArmedRunId] = useState<string | null>(null);
  const streamingRunId = sessionState?.streamingRunId ?? null;

  const sessionQuery = useQuery({
    queryKey: ['session', sessionId],
    enabled: !!sessionId,
    queryFn: () => window.orkestral['session:get']({ sessionId: sessionId! }),
  });

  useEffect(() => {
    if (sessionQuery.data && !sessionState) {
      upsertSession(sessionQuery.data.session, sessionQuery.data.messages);
    }
  }, [sessionQuery.data, sessionState, upsertSession]);

  // Hidrata a fila persistida do MAIN ao abrir/montar a sessão (sobrevive a
  // reload). Atualizações subsequentes chegam via evento `chat:queue-changed`.
  const queueQuery = useQuery({
    queryKey: ['chat-queue', sessionId],
    enabled: !!sessionId,
    queryFn: () => window.orkestral['chat:queue-list']({ sessionId: sessionId! }),
  });
  // Dep em `hasSession` (boolean) e NÃO em `sessionState` (objeto): setSessionQueue
  // recria a sessão, então depender da referência re-dispararia o effect em loop.
  const hasSession = !!sessionState;
  useEffect(() => {
    if (sessionId && hasSession && queueQuery.data) {
      setSessionQueue(sessionId, queueQuery.data.items);
    }
  }, [sessionId, hasSession, queueQuery.data, setSessionQueue]);

  const agentsQuery = useQuery({
    queryKey: ['agents', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: workspace!.id }),
  });

  // Proveniência de canal desta sessão (se veio do WhatsApp etc.).
  const channelMetaQuery = useQuery({
    queryKey: ['channel-session-meta', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['channels:session-meta']({ workspaceId: workspace!.id }),
  });
  const channelInfo = channelMetaQuery.data?.find((m) => m.chatSessionId === sessionId);

  const currentAgent = agentsQuery.data?.find((a) => a.id === sessionState?.session.agentId);

  // Plano pendente desta sessão → banner de aprovação no chat.
  const issuesQuery = useQuery({
    queryKey: ['issues', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['issue:list']({ workspaceId: workspace!.id }),
  });
  const executionByIssue = useExecutionStore((s) => s.byIssue);
  const ingestExecutionEvent = useExecutionStore((s) => s.ingest);
  // TODOS os épicos pendentes da sessão — o drawer mostra o plano inteiro e aprova de uma vez,
  // em vez de abrir um card por épico ("um atrás do outro").
  const pendingPlanEpics = (issuesQuery.data ?? []).filter((i) => {
    const p = readPlanState(i);
    return p?.status === 'pending' && p.sessionId === sessionId;
  });
  // Primeiro pendente — usado pelo banner colapsado e pelo auto-open.
  const pendingPlanEpic = pendingPlanEpics[0] ?? null;
  const planChildrenOf = (epicId: string): Issue[] =>
    (issuesQuery.data ?? []).filter((i) => i.parentIssueId === epicId);
  // Total de sub-issues somando todos os épicos pendentes.
  const totalPlanSubIssues = pendingPlanEpics.reduce((n, e) => n + planChildrenOf(e.id).length, 0);
  // Auto-abre o drawer do plano UMA vez, assim que um plano novo fica pronto pra
  // aprovar (o `pendingPlanEpic` só aparece quando o turno finaliza o plano). Se o
  // usuário fechar, não reabre (a ref já marcou esse épico).
  const autoOpenedPlanRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingPlanEpic && autoOpenedPlanRef.current !== pendingPlanEpic.id) {
      autoOpenedPlanRef.current = pendingPlanEpic.id;
      setPlanDrawerOpen(true);
    }
  }, [pendingPlanEpic]);

  // Wizard de PERGUNTAS sobre o projeto (<orkestral:ask-user>): o CEO pergunta ANTES
  // de planejar algo grande/ambíguo. Igual o plano, vive num banner/drawer ACIMA do
  // chat (não inline na mensagem). Pega o último bloco emitido na sessão.
  const askUserPayload = useMemo(
    () => findLatestAskUserPayload(sessionState?.messages ?? []),
    [sessionState?.messages],
  );
  const askUserResolved = useMemo(
    () => (askUserPayload && sessionId ? isWizardResolved(sessionId, askUserPayload) : false),
    [askUserPayload, sessionId, questionsResolvedTick],
  );
  // Auto-abre o drawer das perguntas UMA vez quando aparecem perguntas ainda não
  // respondidas (mesmo padrão do plano). Se o usuário fechar, não reabre.
  const autoOpenedQuestionsRef = useRef<string | null>(null);
  useEffect(() => {
    if (askUserPayload && !askUserResolved && sessionId) {
      const k = wizardKey(sessionId, askUserPayload);
      if (autoOpenedQuestionsRef.current !== k) {
        autoOpenedQuestionsRef.current = k;
        setQuestionsDrawerOpen(true);
      }
    }
  }, [askUserPayload, askUserResolved, sessionId]);
  // Aprovar+executar o plano direto do drawer (mesmo backend do IssueDetailPage):
  // libera as sub-issues e dispara a execução automática das elegíveis.
  const decidePlanMut = useMutation({
    // Aprova TODOS os épicos pendentes de uma vez (em vez de um por um).
    mutationFn: async (epicIds: string[]) => {
      let executed = 0;
      for (const id of epicIds) {
        const r = await window.orkestral['issue:decide-plan']({
          epicIssueId: id,
          decision: 'approve',
        });
        executed += r.executed;
      }
      return { executed };
    },
    onSuccess: (res) => {
      setPlanDrawerOpen(false);
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      toast.success(
        t('chat.planBanner.approvedTitle'),
        t('chat.planBanner.approvedBody', { n: res.executed }),
      );
    },
    onError: (err) => {
      toast.error(
        t('chat.planBanner.approveError'),
        err instanceof Error ? err.message : String(err),
      );
    },
  });
  // Páginas da KB do workspace → resolve o page_id/slug das tool-calls em título
  // legível (a página que o agente REALMENTE abriu). Sem isso só sobraria o UUID
  // cru ou a query de busca (que não é a base recuperada).
  const kbPagesQuery = useQuery({
    queryKey: ['kb-pages', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['kb:list-pages']({ workspaceId: workspace!.id }),
  });
  const kbIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of kbPagesQuery.data ?? []) {
      m.set(p.id, p.title);
      m.set(p.slug, p.title);
    }
    return m;
  }, [kbPagesQuery.data]);

  // Issues criadas a partir DESTA sessão → drawer de Progresso (substitui o
  // antigo painel de "Alterações"). Abre sozinho quando aparecem itens.
  const sessionIssues = (issuesQuery.data ?? []).filter(
    (i) => (i.metadata as { originSessionId?: string } | null)?.originSessionId === sessionId,
  );
  const sessionIssueIdsSig = sessionIssues
    .map((issue) => issue.id)
    .sort()
    .join('|');
  const latestRunsQuery = useQuery({
    queryKey: ['session-issue-latest-runs', sessionIssueIdsSig],
    enabled: sessionIssues.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        sessionIssues.map(async (issue) => {
          const runs = await window.orkestral['issue:list-runs']({ issueId: issue.id });
          return [issue.id, runs[0] ?? null] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, IssueRun | null>;
    },
    refetchInterval: 5_000,
  });
  const executionEventsQuery = useQuery({
    queryKey: ['issue-execution-events', sessionIssueIdsSig],
    enabled: sessionIssues.length > 0,
    queryFn: () =>
      window.orkestral['issue:list-execution-events']({
        issueIds: sessionIssues.map((issue) => issue.id),
        limitPerIssue: 200,
      }),
  });
  useEffect(() => {
    if (!executionEventsQuery.data) return;
    for (const events of Object.values(executionEventsQuery.data)) {
      for (const event of events) ingestExecutionEvent(event);
    }
  }, [executionEventsQuery.data, ingestExecutionEvent]);
  const runChangeSummary = useMemo(
    () => buildSessionCodeChangeSummary(sessionIssues),
    [sessionIssues],
  );
  const runChangeSignature = useMemo(() => {
    if (!runChangeSummary) return null;
    return runChangeSummary.changes
      .map((change) => `${change.sourceId}:${change.issueId}:${change.snapshotId ?? 'files'}`)
      .sort()
      .join('|');
  }, [runChangeSummary]);
  const visibleRunChangeSummary =
    runChangeSummary && runChangeSignature !== undoneChangeSignature ? runChangeSummary : null;
  const discardRunChanges = useMutation({
    mutationFn: async () => {
      if (!runChangeSummary) return;
      for (const change of runChangeSummary.changes) {
        await window.orkestral['git:discard']({
          sourceId: change.sourceId,
          files: change.files,
          issueId: change.issueId,
          snapshotId: change.snapshotId,
        });
      }
      const undoneFiles = new Set(
        runChangeSummary.changes.flatMap((change) =>
          change.files.map((file) => `${change.sourceId}:${file}`),
        ),
      );
      const bySource = new Map<string, Set<string>>();
      for (const file of runChangeSummary.files) {
        if (undoneFiles.has(`${file.sourceId}:${file.path}`)) continue;
        if (!file.sourceId) continue;
        const files = bySource.get(file.sourceId) ?? new Set<string>();
        files.add(file.path);
        bySource.set(file.sourceId, files);
      }
      for (const [sourceId, files] of bySource) {
        await window.orkestral['git:discard']({
          sourceId,
          files: [...files],
        });
      }
    },
    onSuccess: () => {
      setUndoneChangeSignature(runChangeSignature);
      toast.success(
        t('chat.discardChanges.successTitle'),
        t('chat.discardChanges.successDescription'),
      );
      queryClient.invalidateQueries({ queryKey: ['git-status'] });
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session-issue-latest-runs'] });
      queryClient.invalidateQueries({ queryKey: ['issue-execution-events'] });
    },
    onError: (err) =>
      toast.error(
        t('chat.discardChanges.errorTitle'),
        err instanceof Error ? err.message : undefined,
      ),
  });
  // Contexto recuperado nesta sessão (páginas de KB abertas + arquivos lidos/
  // editados), derivado das tool-calls das mensagens + dos arquivos das issues.
  const sessionContext = useMemo(() => {
    const affected = sessionIssues.flatMap(
      (i) => (i.metadata as { affectedFiles?: string[] } | null)?.affectedFiles ?? [],
    );
    return extractSessionContext(sessionState?.messages ?? [], affected, kbIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionState?.messages, issuesQuery.data, sessionId, kbIndex]);
  const hasProgress =
    sessionIssues.length > 0 || sessionContext.kb.length > 0 || sessionContext.files.length > 0;
  useEffect(() => {
    if (!hasProgress) return undefined;
    const frame = requestAnimationFrame(() => setReviewOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [hasProgress]);

  // Banner de notificação é por sessão: trocar de sessão zera o estado pra não
  // vazar o prompt (nem o tracking de dismiss/arm de outro run) na próxima.
  useEffect(() => {
    setNotifyPromptRunId(null);
    setNotifyDismissedRunId(null);
    setNotifyArmedRunId(null);
  }, [sessionId]);

  useEffect(() => {
    if (!streamingRunId || !sessionId) return;
    const storageKey = `orkestral.notify-run-prompt.${sessionId}`;
    if (localStorage.getItem(storageKey)) return;
    if (notifyDismissedRunId === streamingRunId || notifyArmedRunId === streamingRunId) return;
    const timer = window.setTimeout(() => {
      setNotifyPromptRunId(streamingRunId);
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [streamingRunId, sessionId, notifyDismissedRunId, notifyArmedRunId]);

  // Atualiza o painel ao vivo: cada evento de execução de issue invalida a query
  // de issues na hora (em vez de esperar o refetch de 15s) — status muda na cara.
  useEffect(() => {
    if (!workspace) return;
    const api = (window as Window & { orkestralEvents?: { onIssueExecutionEvent?: unknown } })
      .orkestralEvents;
    if (
      !api ||
      typeof (api as { onIssueExecutionEvent?: unknown }).onIssueExecutionEvent !== 'function'
    ) {
      return;
    }
    return window.orkestralEvents.onIssueExecutionEvent(() => {
      queryClient.invalidateQueries({ queryKey: ['issues', workspace.id] });
      queryClient.invalidateQueries({ queryKey: ['session-issue-latest-runs'] });
    });
  }, [workspace, queryClient]);

  // Profile do usuário pra exibir nome + avatar nas mensagens do user
  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: () => window.orkestral['user:get'](),
  });
  const currentUser = userQuery.data;

  /**
   * Envia mensagem com otimismo imediato + fila pra mensagens enviadas
   * durante streaming. Se já há run ativa, enfileira; senão dispara.
   */
  async function dispatchMessage(content: string, attachments?: ChatAttachment[]) {
    if (!sessionId) return;
    setSendError(null);
    const tempId = `temp:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
    addOptimisticUserMessage(sessionId, tempId, content, attachments);
    try {
      const result = await window.orkestral['chat:send']({
        sessionId,
        content,
        scope,
        attachments,
      });
      // Backend devolve o id real da mensagem do user — reconcilia
      reconcileOptimisticUserMessage(sessionId, tempId, result.userMessageId);
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failOptimisticUserMessage(sessionId, tempId, message);
      setSendError(message);
    }
  }

  async function handleSend(content: string, attachments?: ChatAttachment[]) {
    if (!sessionId) return;
    // Estilo Claude Code: se há run ativo, NÃO interrompe — só ENFILEIRA. A fila
    // vive no MAIN (persistida): `chat:enqueue` grava a pendência (sobrevive a
    // reload) e o evento `chat:queue-changed` reflete o chip "Na fila" no
    // composer. Sem run ativo, `chat:enqueue` despacha na hora (enqueued=false).
    if (streaming) {
      try {
        await window.orkestral['chat:enqueue']({ sessionId, content, scope, attachments });
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    await dispatchMessage(content, attachments);
  }

  // Quando o streaming termina, o MAIN despacha a próxima da fila sozinho (não
  // depende da UI montada). Aqui só invalidamos caches: a sessão (texto pode ter
  // sido reescrito quando o CEO cria issues automáticas) e a página de issues.
  useEffect(() => {
    if (streaming) return;
    if (!sessionId) return;
    queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['issues'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, sessionId]);

  // Abrir a sessão (ou ela parar de streamar enquanto aberta) limpa o "não-lida".
  useEffect(() => {
    if (sessionId) useSessionReadStore.getState().markRead(sessionId);
  }, [sessionId, streaming]);

  async function handleCancel() {
    // STOP GLOBAL: para TUDO no workspace AGORA — mata todos os runs de issue ativos +
    // halta o auto-avanço do plano (não só o stream do chat). Roda mesmo sem stream.
    if (workspace) {
      try {
        await window.orkestral['exec:stop-all']({ workspaceId: workspace.id });
      } catch (err) {
        console.warn('[stop] exec:stop-all falhou:', err);
      }
    }
    // E cancela o stream do chat em si (pause: o MAIN não auto-despacha a próxima).
    if (sessionState?.streamingRunId) {
      await window.orkestral['chat:cancel']({
        runId: sessionState.streamingRunId,
        pause: true,
      });
    }
  }

  async function handlePendingSendNow(pendingId: string): Promise<void> {
    if (!sessionId) return;
    // HONESTO: não há checkpoint mid-turn (os adapters rodam o CLI one-shot, sem
    // canal pra injetar input no meio). "Enviar agora" com run ativo REINICIA o
    // turno com esta orientação adicionada — não continua de onde parou. O
    // contexto anterior NÃO se perde: o run cancelado é finalizado preservando o
    // texto/tools parciais (status 'cancelled') e o próximo turno reinjeta o
    // histórico da conversa. Marca como steer (prioridade) e cancela SEM pause —
    // o MAIN então despacha o steer (à frente da fila) automaticamente.
    await window.orkestral['chat:queue-set-kind']({ itemId: pendingId, kind: 'steer' });
    if (sessionState?.streamingRunId) {
      await window.orkestral['chat:cancel']({ runId: sessionState.streamingRunId });
    }
  }

  function enableCompletionNotification(): void {
    // Arma/limpa mesmo se o run acabou de terminar (streamingRunId já null): o
    // arm é por sessão, não por run. Sem `streamingRunId` o botão ficava morto.
    if (!sessionId) return;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission();
      }
    } catch {
      // ignore
    }
    armChatCompletionNotification(sessionId);
    localStorage.setItem(`orkestral.notify-run-prompt.${sessionId}`, 'armed');
    if (streamingRunId) setNotifyArmedRunId(streamingRunId);
    setNotifyPromptRunId(null);
  }

  function dismissCompletionNotification(): void {
    if (sessionId) localStorage.setItem(`orkestral.notify-run-prompt.${sessionId}`, 'dismissed');
    if (streamingRunId) setNotifyDismissedRunId(streamingRunId);
    setNotifyPromptRunId(null);
  }

  function handleSlashCommand(cmd: SlashCommand) {
    if (cmd === 'new' || cmd === 'clear') {
      window.location.hash = '#/';
      return;
    }
    if (cmd === 'help') {
      toast.info(t('chat.help.title'), t('chat.help.body'));
    }
  }

  function issuePrefix(name: string): string {
    return (
      (name || 'ORK')
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 3)
        .toUpperCase() || 'ORK'
    );
  }

  if (sessionQuery.isLoading) {
    return (
      <CardShell>
        <TopToolbar />
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('chat.session.loading')}
        </div>
      </CardShell>
    );
  }

  if (!sessionQuery.data) {
    return (
      <CardShell>
        <TopToolbar />
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('chat.session.notFound')}
        </div>
      </CardShell>
    );
  }

  const messages = sessionState?.messages ?? sessionQuery.data.messages;
  const session = sessionQuery.data.session;

  return (
    <CardShell>
      {/* Toolbar única — abrange a largura do card */}
      <TopToolbar
        centerLabel={renderTitleMentions(
          session.title,
          (agentsQuery.data ?? []).map((a) => ({
            id: a.id,
            name: a.name,
            avatarSeed: a.avatarSeed,
          })),
        )}
        centerSubtitle={agentSubtitle(currentAgent)}
        reviewOpen={reviewOpen}
        onToggleReview={hasProgress ? () => setReviewOpen((v) => !v) : undefined}
        reviewToggleLabel={hasProgress ? t('chat.workspace.openLabel') : undefined}
      />

      {/* Conteúdo: chat à esquerda + workspace à direita (mesmo card) */}
      <div className="flex min-h-0 flex-1">
        {/* COLUNA: chat — com o workspace aberto vira coluna fixa (estilo Lovable) */}
        <div
          className={cn(
            'relative flex min-w-0 flex-col',
            reviewOpen && hasProgress ? 'flex-1 lg:w-[520px] lg:flex-none' : 'flex-1',
          )}
        >
          {sendError && (
            <div className="mx-6 mt-3 flex items-start gap-2.5 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
              <div className="flex-1 text-[12px] text-text-primary">
                <div className="font-medium text-accent-red">
                  {t('chat.session.sendErrorTitle')}
                </div>
                <div className="mt-0.5 text-text-secondary">{sendError}</div>
              </div>
              <button
                type="button"
                onClick={() => setSendError(null)}
                className="ml-1 grid h-5 w-5 place-items-center rounded text-text-muted hover:bg-surface-active hover:text-text-primary"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {channelInfo && (
            <div className="mx-6 mt-3 flex items-center gap-2.5 rounded-lg border border-hairline bg-surface px-3 py-2">
              {channelInfo.photoUrl ? (
                <img
                  src={channelInfo.photoUrl}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-full object-cover"
                />
              ) : (
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-strong">
                  <ChannelIcon channel={channelInfo.channelType} className="h-4 w-4" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-text-primary">
                  {channelInfo.displayName || channelInfo.phone || t('chat.session.channelContact')}
                </div>
                <div className="text-[11px] text-text-muted">
                  {t('chat.session.viaChannel', {
                    channel: CHANNEL_LABEL[channelInfo.channelType],
                  })}
                  {/* No WhatsApp o id É o telefone (+número). Nos demais (Discord/Telegram)
                      é id opaco — não prefixa com '+'. */}
                  {channelInfo.channelType === 'whatsapp' &&
                    channelInfo.phone &&
                    ` · +${channelInfo.phone}`}
                </div>
              </div>
            </div>
          )}

          <MessageList
            key={sessionId}
            messages={messages}
            agentName={currentAgent?.name}
            agentAvatarSeed={currentAgent?.avatarSeed ?? null}
            allAgents={agentsQuery.data ?? []}
            userName={currentUser?.name}
            buildLabel="Build"
            modelLabel={chatModelLabel(currentAgent, agentsQuery.data ?? [])}
          />

          {visibleRunChangeSummary && (
            <div className="mx-auto mb-2 w-full max-w-3xl px-6">
              <SessionCodeChangesBar
                summary={visibleRunChangeSummary}
                busy={discardRunChanges.isPending}
                onUndo={() => discardRunChanges.mutate()}
                onReview={() => {
                  if (visibleRunChangeSummary.sourceIds.length === 1) {
                    window.location.hash = `#/sources/${visibleRunChangeSummary.sourceIds[0]}`;
                  } else {
                    setReviewOpen(true);
                  }
                }}
              />
            </div>
          )}

          {workspace && sessionId && (
            <SessionSpecialistProposals workspaceId={workspace.id} sessionId={sessionId} />
          )}

          {askUserPayload && (
            <div className="mx-auto mb-2 w-full max-w-3xl px-6">
              <button
                type="button"
                onClick={() => setQuestionsDrawerOpen(true)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors',
                  askUserResolved
                    ? 'border-hairline-strong bg-surface-elevated hover:bg-surface-active'
                    : 'border-accent-blue/30 bg-accent-blue/10 hover:bg-accent-blue/15',
                )}
              >
                {askUserResolved ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-accent-green" />
                ) : (
                  <ClipboardCheck className="h-4 w-4 shrink-0 text-accent-blue" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-text-primary">
                    {t(
                      askUserResolved
                        ? 'chat.questionsBanner.answeredTitle'
                        : 'chat.questionsBanner.title',
                    )}
                  </div>
                  <div className="truncate text-[11.5px] text-text-secondary">
                    {askUserResolved
                      ? t('chat.questionsBanner.answeredSubtitle')
                      : t('chat.questionsBanner.subtitle', { n: askUserPayload.questions.length })}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 -rotate-90 text-text-muted" />
              </button>
            </div>
          )}

          {pendingPlanEpic && (
            <div className="mx-auto mb-2 w-full max-w-3xl px-6">
              <button
                type="button"
                onClick={() => setPlanDrawerOpen(true)}
                className="flex w-full items-center gap-2.5 rounded-md border border-accent-blue/30 bg-accent-blue/10 px-3 py-2.5 text-left transition-colors hover:bg-accent-blue/15"
              >
                <ClipboardCheck className="h-4 w-4 shrink-0 text-accent-blue" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-text-primary">
                    {t('chat.planBanner.title')}
                  </div>
                  <div className="truncate text-[11.5px] text-text-secondary">
                    {t('chat.planBanner.subtitle', { title: pendingPlanEpic.title })}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 -rotate-90 text-text-muted" />
              </button>
            </div>
          )}

          <AnimatePresence>
            {notifyPromptRunId && streamingRunId && (
              <motion.div
                key="notify-run"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.18 }}
                className="mx-auto mb-2 w-full max-w-3xl px-6"
              >
                <div className="flex items-center gap-3 rounded-xl border border-hairline-strong bg-surface-elevated px-3.5 py-2.5 shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
                  <div className="min-w-0 flex-1 text-[13px] leading-snug text-text-primary">
                    {t('chat.notifyRun.question', {
                      agent: currentAgent?.name ?? 'Orkestral',
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={enableCompletionNotification}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-[12.5px] font-medium text-background transition-colors hover:bg-text-primary/90"
                  >
                    <Bell className="h-3.5 w-3.5" />
                    {t('chat.notifyRun.action')}
                  </button>
                  <button
                    type="button"
                    onClick={dismissCompletionNotification}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
                    aria-label={t('chat.notifyRun.dismiss')}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* A fila de follow-ups durante o streaming é renderizada de forma
              compacta dentro do próprio card do input (PendingQueueStrip). */}
          <ChatPrompt
            onSubmit={(content, attachments) => {
              // Seleções de componente do preview (workspace) viram refs no texto —
              // mesmo formato do chat bubble da IDE — e limpam os chips ao enviar.
              const withRefs = buildTransformContent()(content);
              if (withRefs !== content) useIdeChatStore.getState().clearSelections();
              handleSend(withRefs, attachments);
            }}
            onCancel={handleCancel}
            streaming={streaming}
            agents={agentsQuery.data}
            currentAgent={currentAgent}
            onCommand={handleSlashCommand}
            footer={<SelectionChips />}
            pendingQueue={pendingQueue}
            onPendingKindChange={(pendingId, kind) => {
              void window.orkestral['chat:queue-set-kind']({ itemId: pendingId, kind });
            }}
            onPendingRemove={(pendingId) => {
              void window.orkestral['chat:queue-cancel']({ itemId: pendingId });
            }}
            onPendingSendNow={handlePendingSendNow}
          />

          {/* DRAWER das PERGUNTAS — mesmo padrão do plano: sheet de baixo, ACIMA do
              chat. Contém o QuestionWizard (perguntas ou card de decisões). */}
          <AnimatePresence>
            {questionsDrawerOpen && askUserPayload && sessionId && (
              <>
                <motion.div
                  key="questions-backdrop"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="absolute inset-0 z-20 bg-black/40"
                  onClick={() => setQuestionsDrawerOpen(false)}
                />
                <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center px-6">
                  <motion.div
                    key="questions-sheet"
                    initial={{ y: '100%' }}
                    animate={{ y: 0 }}
                    exit={{ y: '100%' }}
                    transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
                    className="flex max-h-[72vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-b-0 border-hairline-strong bg-surface shadow-[0_-18px_60px_rgba(0,0,0,0.4)]"
                  >
                    <div className="mx-auto mb-1 mt-3 h-1 w-9 shrink-0 rounded-full bg-hairline-heavy" />
                    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-4 pt-2">
                      <QuestionWizard
                        sessionId={sessionId}
                        payload={askUserPayload}
                        onResolved={() => {
                          // Respondeu → minimiza: fecha o drawer e deixa só o banner
                          // "Respostas enviadas" (clicável pra rever as decisões).
                          setQuestionsResolvedTick((n) => n + 1);
                          setQuestionsDrawerOpen(false);
                        }}
                      />
                    </div>
                  </motion.div>
                </div>
              </>
            )}
          </AnimatePresence>

          {/* DRAWER do PLANO — sobe de baixo cobrindo só a área do chat (não a
              sidebar): revisar a épica + sub-issues sem sair da conversa, com
              atalho pra abrir a issue. */}
          <AnimatePresence>
            {planDrawerOpen && pendingPlanEpic && (
              <>
                <motion.div
                  key="plan-backdrop"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="absolute inset-0 z-20 bg-black/40"
                  onClick={() => setPlanDrawerOpen(false)}
                />
                <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center px-6">
                  <motion.div
                    key="plan-sheet"
                    initial={{ y: '100%' }}
                    animate={{ y: 0 }}
                    exit={{ y: '100%' }}
                    transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
                    className="flex max-h-[50vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-b-0 border-hairline-strong bg-surface shadow-[0_-18px_60px_rgba(0,0,0,0.4)]"
                  >
                    <div className="flex h-full flex-col px-5 pb-4 pt-3">
                      {/* Grip + header */}
                      <div className="mx-auto mb-3 h-1 w-9 shrink-0 rounded-full bg-hairline-heavy" />
                      <div className="flex items-start gap-2.5">
                        <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-blue" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-semibold text-text-primary">
                            {t('chat.planBanner.planReady')}
                          </div>
                          <div className="text-[11.5px] text-text-muted">
                            {t('chat.planBanner.epicsAndTasks', {
                              epics: pendingPlanEpics.length,
                              tasks: totalPlanSubIssues,
                            })}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setPlanDrawerOpen(false)}
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
                          aria-label={t('chat.planBanner.close')}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>

                      {/* Rolável: TODOS os épicos pendentes, cada um com suas sub-issues */}
                      <div className="no-scrollbar mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto">
                        {pendingPlanEpics.map((epic) => (
                          <div key={epic.id} className="space-y-1.5">
                            <div className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-text-primary">
                                {epic.title}
                              </span>
                              <span className="shrink-0 font-mono text-[10.5px] text-text-faint">
                                {issuePrefix(workspace?.name ?? '')}-{epic.issueKey}
                              </span>
                            </div>
                            {epic.description && (
                              <div className="whitespace-pre-wrap rounded-lg border border-hairline bg-surface-faint px-3 py-2 text-[12px] leading-relaxed text-text-secondary">
                                {epic.description}
                              </div>
                            )}
                            <div className="space-y-1">
                              {planChildrenOf(epic.id).map((iss) => (
                                <div
                                  key={iss.id}
                                  className="flex items-start gap-2.5 rounded-md border border-hairline bg-surface-faint px-3 py-2"
                                >
                                  <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-faint" />
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[12.5px] text-text-primary">
                                      {iss.title}
                                    </div>
                                    {iss.description && (
                                      <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-text-muted">
                                        {iss.description}
                                      </div>
                                    )}
                                  </div>
                                  <span className="shrink-0 font-mono text-[10.5px] text-text-faint">
                                    {issuePrefix(workspace?.name ?? '')}-{iss.issueKey}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Footer: aprovar TODOS os épicos de uma vez */}
                      <div className="mt-3 flex shrink-0 items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={decidePlanMut.isPending}
                          onClick={() => decidePlanMut.mutate(pendingPlanEpics.map((e) => e.id))}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent-green px-3.5 text-[13px] font-semibold text-white transition-opacity hover:bg-accent-green/90 disabled:opacity-50"
                        >
                          {decidePlanMut.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-4 w-4" />
                          )}
                          {t('chat.issuePlan.approveAll')}
                        </button>
                      </div>
                    </div>
                  </motion.div>
                </div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* WORKSPACE (estilo Lovable) — Preview | Código | Issues ao lado do chat.
            Auto-abre quando surgem itens; o chat vira coluna fixa à esquerda. */}
        <AnimatePresence initial={false}>
          {reviewOpen && hasProgress && workspace && (
            <motion.div
              key="workspace"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="hidden min-w-0 flex-1 lg:flex"
            >
              <div className="h-full min-h-0 w-full">
                <SessionWorkspace
                  workspaceId={workspace.id}
                  issues={sessionIssues}
                  prefix={issuePrefix(workspace.name)}
                  executionByIssue={executionByIssue}
                  latestRunsByIssue={latestRunsQuery.data ?? {}}
                  agents={agentsQuery.data ?? []}
                  tab={wsTab}
                  onTabChange={setWsTab}
                  onClose={() => setReviewOpen(false)}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </CardShell>
  );
}

/**
 * Drawer de PROGRESSO — checklist das issues abertas nesta sessão (épicas +
 * sub-issues), com barra de progresso. Substitui o antigo painel de diffs.
 */
interface SessionContext {
  /** Bases de conhecimento consultadas (query/título). */
  kb: string[];
  /** Arquivos lidos/editados nesta sessão. */
  files: { path: string; edited: boolean }[];
}

function SessionCodeChangesBar({
  summary,
  busy,
  onUndo,
  onReview,
}: {
  summary: SessionCodeChangeSummary;
  busy: boolean;
  onUndo: () => void;
  onReview: () => void;
}) {
  const { t } = useT();
  const fileLabel =
    summary.files.length === 1
      ? t('chat.codeChangesBar.fileChanged')
      : t('chat.codeChangesBar.filesChanged', { n: summary.files.length });
  const visibleFiles = summary.files.slice(0, 2);
  const hiddenCount = Math.max(0, summary.files.length - visibleFiles.length);
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-white/[0.015]">
      <div className="flex items-center gap-2.5 px-3.5 py-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-[12px] font-medium text-text-secondary">{fileLabel}</span>
          <span className="shrink-0 font-mono text-[11px] text-accent-green">
            +{summary.additions}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-accent-red">
            -{summary.deletions}
          </span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onUndo}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
          {t('chat.codeChangesBar.undo')}
        </button>
        <button
          type="button"
          onClick={onReview}
          className="inline-flex h-7 items-center rounded-md px-2.5 text-[11.5px] font-medium text-text-primary transition-colors hover:bg-surface-2"
        >
          {t('chat.codeChangesBar.review')}
        </button>
      </div>
      <div className="border-t border-hairline-soft py-1">
        {visibleFiles.map((file) => {
          const Icon = fileIconFor(file.path);
          return (
            <div
              key={`${file.sourceId}:${file.path}`}
              className="flex items-center gap-2.5 px-3.5 py-0.5"
            >
              <Icon className="h-3 w-3 shrink-0 text-text-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted">
                {shortenRelPath(file.path)}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-accent-green">
                +{file.additions}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-accent-red">
                -{file.deletions}
              </span>
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={onReview}
            className="flex w-full items-center gap-1.5 px-3.5 py-0.5 text-left text-[11px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            <span>{t('chat.codeChangesBar.showMore', { n: hiddenCount })}</span>
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Segmento UUID — denuncia path de anexo/cache (não é arquivo de código) ou
 *  page_id cru da KB. Filtramos pra não poluir o painel com hash ilegível. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Varre as mensagens da sessão e extrai o contexto recuperado pelos agentes:
 * PÁGINAS de KB abertas (kb_get_page/backlinks) resolvidas pra título via
 * `kbIndex`, e arquivos lidos/editados (read/edit/write/patch + affectedFiles das
 * issues). A query do kb_search NÃO entra — não é a base recuperada e o CLI do
 * Claude não captura o resultado da busca. Dedup + cap; ignora paths-UUID (anexo).
 */
function extractSessionContext(
  messages: ChatMessage[],
  affectedFiles: string[],
  kbIndex: Map<string, string>,
): SessionContext {
  const kb = new Set<string>();
  const fileMap = new Map<string, boolean>(); // path → editado?
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== 'tool-call') continue;
      const raw = p.toolName.toLowerCase();
      const args = p.args ?? {};
      if (raw.includes('kb_') || raw.includes('knowledge')) {
        // Página que o agente abriu, resolvida pra título legível (id OU slug).
        const ref = str(args.page_id) ?? str(args.slug) ?? str(args.id);
        const title = ref ? kbIndex.get(ref) : undefined;
        if (title) kb.add(title);
        continue;
      }
      const path = str(args.file_path) ?? str(args.filePath) ?? str(args.path);
      const touches =
        raw.includes('read') ||
        raw.includes('edit') ||
        raw.includes('write') ||
        raw.includes('patch');
      if (path && touches && !UUID_RE.test(path)) {
        const edited = raw.includes('edit') || raw.includes('write') || raw.includes('patch');
        fileMap.set(path, (fileMap.get(path) ?? false) || edited);
      }
    }
  }
  for (const f of affectedFiles) {
    if (f && !UUID_RE.test(f) && !fileMap.has(f)) fileMap.set(f, true);
  }
  return {
    kb: [...kb].slice(0, 30),
    files: [...fileMap].map(([path, edited]) => ({ path, edited })).slice(0, 50),
  };
}

/** Abrevia path longo mostrando só os 2 últimos segmentos. */
function shortenRelPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return '…/' + parts.slice(-2).join('/');
}

/**
 * Wrapper do card principal — único container que abriga tudo (toolbar +
 * chat + separator + progresso). Mantém o padrão "card sobre fundo escuro"
 * usado em todas as páginas do app.
 */
function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {children}
      </div>
    </div>
  );
}

function agentSubtitle(
  agent: { name?: string; adapterType?: string | null; model?: string | null } | undefined,
): string {
  if (!agent) return '';
  const parts = [agent.name, agent.adapterType ?? undefined];
  if (agent.model && agent.model !== 'default') parts.push(agent.model);
  return parts.filter(Boolean).join(' · ');
}

// chatModelLabel foi pra components/chat/chat-labels.ts (compartilhado com o ChatSurface).
