import { useEffect, useRef } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { Router } from '@renderer/router';
import { SettingsModal } from '@renderer/components/settings/SettingsModal';
import { OnboardingGate } from '@renderer/components/onboarding/OnboardingGate';
import { NewAgentDialog } from '@renderer/components/agents/NewAgentDialog';
import { NewProjectDialog } from '@renderer/components/projects/NewProjectDialog';
import { AddSourceDialog } from '@renderer/components/sources/AddSourceDialog';
import { CommandPalette } from '@renderer/components/command/CommandPalette';
import { Toaster } from '@renderer/components/ui/Toaster';
import { ErrorBoundary } from '@renderer/components/error-boundary';
import { queryClient } from '@renderer/lib/queryClient';
import { attachChatStreamBridge } from '@renderer/stores/chatStore';
import { useUIStore } from '@renderer/stores/uiStore';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useExecutionStore } from '@renderer/stores/executionStore';
import { useKnowledgeProgressStore } from '@renderer/stores/knowledgeProgressStore';
import { notifyDataCleanupSuggested, notifyNewIssue } from '@renderer/lib/notify';
import { toast, useToastStore } from '@renderer/stores/toastStore';
import { useT } from '@renderer/i18n';
import type { ActivityEntry } from '@shared/types';

function sourceSpecialistProposalsBySource(activity: ActivityEntry[]): Map<string, ActivityEntry> {
  const out = new Map<string, ActivityEntry>();
  for (const entry of activity) {
    if (entry.kind !== 'proposal.pending') continue;
    const payload = entry.payload as { type?: string; sourceId?: string };
    if (payload.type !== 'source-specialist' || !payload.sourceId) continue;
    const prev = out.get(payload.sourceId);
    if (!prev || entry.createdAt > prev.createdAt) out.set(payload.sourceId, entry);
  }
  return out;
}

export function App() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  // Assinatura do último estado de propostas que ESBOÇAMOS no toast consolidado.
  // Serve pra respeitar o fechamento manual: se o usuário fecha o toast e nada
  // mudou no próximo poll, não reabrimos — só reaparece quando surge novidade.
  const lastSpecialistSignatureRef = useRef<string | null>(null);
  useEffect(() => attachChatStreamBridge(), []);

  // Carrega as configurações e aplica a aparência (accent, fonte, densidade…)
  // o quanto antes no boot, antes de pintar o resto do app.
  useEffect(() => {
    void useSettingsStore.getState().hydrate();
  }, []);

  useEffect(() => {
    if (!activeWorkspace) return;
    const workspaceId = activeWorkspace.id;
    void useKnowledgeProgressStore.getState().hydrateWorkspaceStatus(workspaceId);
    const timer = window.setTimeout(() => {
      window.orkestral['data:cleanup-preview']({ workspaceId })
        .then((preview) => {
          if (preview.totalItems < 1000 && preview.totalBytes < 50 * 1024 * 1024) return;
          const today = new Date().toISOString().slice(0, 10);
          const key = `orkestral.cleanup-notified.${workspaceId}.${today}`;
          if (localStorage.getItem(key)) return;
          localStorage.setItem(key, '1');
          notifyDataCleanupSuggested(
            t('settings.data.cleanupNotifyBody', {
              items: preview.totalItems,
              bytes: `${Math.round(preview.totalBytes / 1024 / 1024)} MB`,
            }),
          );
        })
        .catch((err) => console.warn('[data-cleanup] preview falhou:', err));
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [activeWorkspace, t]);

  useEffect(() => {
    if (!activeWorkspace) return;
    const workspaceId = activeWorkspace.id;
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const [activity, assignments] = await Promise.all([
          window.orkestral['activity:list']({ workspaceId, limit: 80 }),
          window.orkestral['agent:source-assignments']({ workspaceId }),
        ]);
        if (cancelled) return;
        const proposalsBySource = sourceSpecialistProposalsBySource(activity);
        // Consolida TUDO num ÚNICO toast persistente (sem barra de progresso e
        // sem um toast por source) — "chat é chat, issues são issues": isto é só
        // um aviso discreto de que há proposta(s) de especialista no Inbox. A
        // aprovação acontece no Inbox, não aqui.
        const CONSOLIDATED_KEY = `orkestral.agent-specialists.${workspaceId}`;
        // Só contam propostas ACIONÁVEIS (já existe a proposal pendente). Não há
        // estado "preparando" — proposta de especialista é criada na hora pelo
        // sync; sem proposta = nada a mostrar (zero nag persistente).
        const pendingIds: string[] = [];
        for (const assignment of assignments) {
          if (!assignment.needsNewAgent) continue;
          const proposal = proposalsBySource.get(assignment.sourceId);
          if (proposal) pendingIds.push(proposal.id);
        }
        const signature = pendingIds.sort().join(',');

        if (pendingIds.length === 0) {
          toast.dismissKey(CONSOLIDATED_KEY);
          lastSpecialistSignatureRef.current = null;
          return;
        }

        // Nada mudou desde a última emissão → não re-dispara no polling (respeita
        // o usuário ter fechado). Só notifica quando surge proposta nova.
        if (signature === lastSpecialistSignatureRef.current) return;
        lastSpecialistSignatureRef.current = signature;

        // Notificação que SOME sozinha (não fica fixa): o badge do Inbox segura o
        // sinal. Clicar leva pra Caixa de entrada, onde a aprovação acontece.
        toast.info(
          pendingIds.length === 1
            ? '1 agente especialista aguardando aprovação'
            : `${pendingIds.length} agentes especialistas aguardando aprovação`,
          'Revise e aprove na Caixa de entrada.',
          {
            key: CONSOLIDATED_KEY,
            durationMs: 9_000,
            action: {
              label: 'Abrir Inbox',
              onClick: () => {
                queryClient.invalidateQueries({ queryKey: ['activity', workspaceId] });
                queryClient.invalidateQueries({
                  queryKey: ['agent-source-assignments', workspaceId],
                });
                window.location.hash = '#/inbox';
              },
            },
          },
        );
        queryClient.invalidateQueries({ queryKey: ['activity', workspaceId] });
        queryClient.invalidateQueries({ queryKey: ['agent-source-assignments', workspaceId] });
      } catch (err) {
        console.warn('[agent-proposal-watch] falhou:', err);
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeWorkspace]);

  // Bridge global: qualquer mudança de issues (via MCP tool OU bloco markdown
  // no chat) invalida o cache da query 'issues' — todas as telas que listam
  // issues atualizam em tempo real, sem polling.
  useEffect(() => {
    const api = (window as Window & { orkestralEvents?: { onIssuesChanged?: unknown } })
      .orkestralEvents;
    if (!api || typeof (api as { onIssuesChanged?: unknown }).onIssuesChanged !== 'function') {
      return;
    }
    const unsubscribe = window.orkestralEvents.onIssuesChanged((event) => {
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      queryClient.invalidateQueries({ queryKey: ['issues', event.workspaceId] });
      // Issue nova criada via blocos no chat (agente) → alerta (visual + som)
      // quando o app está sem foco. Só em criação (reason 'chat-blocks') — não
      // em updates de status (que também passam por aqui). Criação manual pela
      // UI não dispara este evento. Gated nas settings dentro de notifyNewIssue.
      if (event.reason === 'chat-blocks') {
        notifyNewIssue(t('layout.notify.newIssue'));
      }
    });
    return unsubscribe;
  }, [t]);

  // Login Cloud → o backend sincroniza o PERFIL local (nome/email) com a conta
  // web. Invalida a query 'user' pra Configurações/sidebar/saudações refletirem
  // a conta logada na hora (sem reload).
  useEffect(() => {
    if (typeof window.orkestralEvents?.onCloudAuthChanged !== 'function') return;
    return window.orkestralEvents.onCloudAuthChanged(() => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
    });
  }, []);

  // Tray (barra de menu) "Preferências…" → abre as Configurações. O main mostra a
  // janela e dispara este evento; aqui só abrimos o modal via store.
  useEffect(() => {
    if (typeof window.orkestralEvents?.onOpenSettings !== 'function') return;
    return window.orkestralEvents.onOpenSettings(() => {
      useUIStore.getState().openSettings();
    });
  }, []);

  // Desktop pet: clique num card → main foca esta janela e pede a navegação.
  useEffect(() => {
    if (typeof window.orkestralEvents?.onAppNavigate !== 'function') return;
    return window.orkestralEvents.onAppNavigate(({ hash }) => {
      window.location.hash = hash;
    });
  }, []);

  // Auto-update (Win/Linux): nova versão baixada em background → toast persistente
  // com "Reiniciar agora" (aplica a atualização e reabre o app).
  useEffect(() => {
    if (typeof window.orkestralEvents?.onUpdateDownloaded !== 'function') return;
    return window.orkestralEvents.onUpdateDownloaded(({ version }) => {
      toast.custom({
        key: 'update-ready',
        tone: 'info',
        title: t('layout.update.readyTitle'),
        description: t('layout.update.readyBody', { version }),
        durationMs: null,
        action: {
          label: t('layout.update.restart'),
          onClick: () => void window.orkestral['update:quit-and-install'](),
        },
      });
    });
  }, [t]);

  // Modelos locais (Forge + embeddings) baixando no 1º uso → toast com barra de
  // progresso. Ao concluir, troca por um aviso curto (ou erro, se a rede falhar).
  useEffect(() => {
    if (typeof window.orkestralEvents?.onModelDownloadProgress !== 'function') return;
    return window.orkestralEvents.onModelDownloadProgress((p) => {
      if (p.done) {
        useToastStore.getState().dismissKey('models-download');
        if (p.failed) toast.error(t('layout.models.failed'));
        else toast.success(t('layout.models.ready'));
        return;
      }
      const counter = p.total > 1 ? ` (${p.index}/${p.total})` : '';
      toast.custom({
        key: 'models-download',
        tone: 'info',
        title: t('layout.models.downloading'),
        description: `${p.label}${counter} · ${p.percent}%`,
        progress: p.percent,
        durationMs: null,
      });
    });
  }, [t]);

  // Bridge global de execução de issues: acumula os eventos por issue num store
  // de sessão, pra o trace persistir ao navegar (e ser capturado mesmo fora da
  // página da issue). A IssueDetailPage só LÊ desse store.
  useEffect(() => {
    const api = (window as Window & { orkestralEvents?: { onIssueExecutionEvent?: unknown } })
      .orkestralEvents;
    if (
      !api ||
      typeof (api as { onIssueExecutionEvent?: unknown }).onIssueExecutionEvent !== 'function'
    ) {
      return;
    }
    const unsubscribe = window.orkestralEvents.onIssueExecutionEvent((event) => {
      useExecutionStore.getState().ingest(event);
      queryClient.invalidateQueries({ queryKey: ['session-issue-latest-runs'] });
      queryClient.invalidateQueries({ queryKey: ['issue-execution-events'] });
      queryClient.invalidateQueries({ queryKey: ['issue-runs', event.issueId] });
      queryClient.invalidateQueries({ queryKey: ['issue-comments', event.issueId] });
      queryClient.invalidateQueries({ queryKey: ['qa-validation', event.issueId] });
      queryClient.invalidateQueries({ queryKey: ['issue-by-key'] });
      queryClient.invalidateQueries({ queryKey: ['issue-children'] });
      if (event.workspaceId) {
        queryClient.invalidateQueries({ queryKey: ['issues', event.workspaceId] });
      }
      if (event.type === 'finished' || event.type === 'error' || event.type === 'file-change') {
        queryClient.invalidateQueries({ queryKey: ['issues'] });
      }
    });
    return unsubscribe;
  }, []);

  // Bridge KB analyze events — invalida cache de árvore quando termina
  useEffect(() => {
    const api = (window as Window & { orkestralEvents?: { onKbAnalyzeEvent?: unknown } })
      .orkestralEvents;
    if (!api || typeof (api as { onKbAnalyzeEvent?: unknown }).onKbAnalyzeEvent !== 'function') {
      return;
    }
    const unsubscribe = window.orkestralEvents.onKbAnalyzeEvent((event) => {
      useKnowledgeProgressStore.getState().handleAnalyzeEvent(event);
      if (event.type === 'analyze-done' || event.type === 'analyze-error') {
        queryClient.invalidateQueries({ queryKey: ['kb-tree'] });
        queryClient.invalidateQueries({ queryKey: ['kb-graph'] });
        queryClient.invalidateQueries({ queryKey: ['kb-source-coverage', event.workspaceId] });
      }
      if (event.type === 'analyze-error') {
        toast.error(
          t('knowledge.progress.analyzeFailed', { source: event.sourceLabel ?? '' }),
          event.error,
        );
      }
    });
    return unsubscribe;
  }, [t]);

  useEffect(() => {
    const api = (window as Window & { orkestralEvents?: { onKbEmbeddingEvent?: unknown } })
      .orkestralEvents;
    if (
      !api ||
      typeof (api as { onKbEmbeddingEvent?: unknown }).onKbEmbeddingEvent !== 'function'
    ) {
      return;
    }
    const unsubscribe = window.orkestralEvents.onKbEmbeddingEvent((event) => {
      useKnowledgeProgressStore.getState().handleEmbeddingEvent(event);
      queryClient.invalidateQueries({ queryKey: ['kb-embedding-status', event.job.workspaceId] });
      if (
        event.type === 'embedding-done' ||
        event.type === 'embedding-error' ||
        event.type === 'embedding-cancelled'
      ) {
        queryClient.invalidateQueries({ queryKey: ['data-stats'] });
        queryClient.invalidateQueries({ queryKey: ['kb-source-coverage', event.job.workspaceId] });
      }
      // Indexação/embeddings rodam em BACKGROUND — sem toast por página (era spam:
      // o agente cria N páginas no chat e cada uma disparava "Base integrada").
      // O progresso fica só no dock (canto superior direito); só ERRO vira toast.
      if (event.type === 'embedding-error') {
        const source = event.job.sourceLabel ?? t('knowledge.title');
        toast.error(t('knowledge.progress.embeddingFailed', { source }), event.error);
      }
    });
    return unsubscribe;
  }, [t]);

  // Sessão criada em background (ex.: plano de contratação pós-onboarding) →
  // abre o chat AO VIVO. App está fora do Router (HashRouter mora dentro de
  // <Router/>), então navega pelo hash; o HashRouter reage ao hashchange.
  useEffect(() => {
    const api = (window as Window & { orkestralEvents?: { onChatSessionReady?: unknown } })
      .orkestralEvents;
    if (
      !api ||
      typeof (api as { onChatSessionReady?: unknown }).onChatSessionReady !== 'function'
    ) {
      return;
    }
    const unsubscribe = window.orkestralEvents.onChatSessionReady((event) => {
      // Só navega se for o workspace ativo (não tira o usuário do que ele está
      // olhando caso tenha trocado de workspace). Após o onboarding, é o novo.
      const active = useWorkspaceStore.getState().active;
      if (active && event.workspaceId !== active.id) return;
      window.location.hash = `#/session/${event.sessionId}`;
    });
    return unsubscribe;
  }, []);

  // Proposta nova no Inbox → SEM toast individual (o aviso consolidado do poll
  // acima já cobre, e a aprovação acontece no Inbox). Aqui só invalidamos as
  // queries pra o Inbox/contador atualizarem na hora. "chat é chat, issues são
  // issues": a proposta vive no Inbox, não em vários toasts redundantes.
  useEffect(() => {
    const api = window.orkestralEvents;
    if (!api || typeof api.onInboxProposal !== 'function') return;
    return api.onInboxProposal((event) => {
      const active = useWorkspaceStore.getState().active;
      if (active && event.workspaceId !== active.id) return;
      queryClient.invalidateQueries({ queryKey: ['activity', event.workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['agent-source-assignments', event.workspaceId] });
    });
  }, []);

  const newAgentOpen = useUIStore((s) => s.newAgentOpen);
  const closeNewAgent = useUIStore((s) => s.closeNewAgent);
  const newProjectOpen = useUIStore((s) => s.newProjectOpen);
  const closeNewProject = useUIStore((s) => s.closeNewProject);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <OnboardingGate>
            <Router />
            <SettingsModal />
            {/* Modais globais — abertos via useUIStore de qualquer lugar */}
            <NewAgentDialog open={newAgentOpen} onOpenChange={(o) => !o && closeNewAgent()} />
            <NewProjectDialog open={newProjectOpen} onOpenChange={(o) => !o && closeNewProject()} />
            <AddSourceDialog />
            <CommandPalette />
            <Toaster />
          </OnboardingGate>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
