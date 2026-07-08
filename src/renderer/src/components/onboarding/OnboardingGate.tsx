import { useState, type ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { OnboardingWizard } from './OnboardingWizard';
import { LaunchTransition } from './LaunchTransition';
import { CloningOverlay } from './CloningOverlay';
import { LoadingState } from '@renderer/components/ui/loading-state';
import { WorkspaceEntryScreen } from '@renderer/components/workspace/WorkspaceEntryScreen';
import { useOnboardingStore } from '@renderer/stores/onboardingStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT } from '@renderer/i18n';

/**
 * Gate que decide se mostra Onboarding ou o app normal.
 *
 * Fluxos:
 *  - Sem onboarding completo OU sem workspaces  → mostra wizard
 *  - Wizard finalizado com sucesso              → mostra LaunchTransition por ~2.6s
 *  - Após transição                              → libera o dashboard
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActive);
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const requiresWorkspaceSelection = useWorkspaceStore((s) => s.requiresWorkspaceSelection);
  const resetWizard = useOnboardingStore((s) => s.reset);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [cloningRepo, setCloningRepo] = useState<string | null>(null);

  const onboardingQuery = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => window.orkestral['onboarding:get'](),
  });

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => window.orkestral['workspace:list'](),
  });

  const completeMutation = useMutation({
    mutationFn: async () => {
      const draft = useOnboardingStore.getState();
      const submission = draft.toSubmission();
      const result = await window.orkestral['onboarding:complete'](submission);

      const remoteSources = normalizeRemoteOnboardingSources(draft);
      if (remoteSources.length > 0) {
        let firstClonedPath: string | null = null;
        setCloningRepo(remoteSources[0].label);
        try {
          for (const [index, sourceDraft] of remoteSources.entries()) {
            setCloningRepo(sourceDraft.label);
            const source = await window.orkestral['source:create']({
              workspaceId: result.workspace.id,
              kind: sourceDraft.kind,
              label: sourceDraft.label,
              repoFullName: sourceDraft.repoFullName,
              githubAccountLogin: sourceDraft.githubAccountLogin,
              isPrimary: index === 0,
              waitForClone: true,
              runHiringPlanAfterCreate: false,
              runKnowledgeAnalysisAfterCreate: true,
            });
            if (!firstClonedPath && source.path) firstClonedPath = source.path;
          }

          if (firstClonedPath) {
            const updated = await window.orkestral['workspace:finalize-github']({
              workspaceId: result.workspace.id,
              clonedPath: firstClonedPath,
              runInitialHiringPlan: submission.runInitialHiringPlan,
            });
            return { ...result, workspace: updated };
          }
          return result;
        } finally {
          setCloningRepo(null);
        }
      }

      return result;
    },
    onSuccess: ({ workspace, project }) => {
      setActiveWorkspace(workspace);
      setActiveProject(project);
      resetWizard();
      setError(null);
      // Dispara a transição animada antes de revelar o dashboard.
      // O launching=true mantém o overlay no topo; quando ele termina,
      // os queries são invalidados e a UI revela o app.
      setLaunching(true);
    },
    onError: (err) => {
      setCloningRepo(null);
      // Mensagem amigável em vez do erro cru do main. O detalhe técnico fica no
      // console pra debug, mas o usuário vê uma orientação clara.
      console.error('[onboarding] falhou:', err);
      setError(t('onboarding.completeError'));
    },
  });

  if (onboardingQuery.isLoading || workspacesQuery.isLoading) {
    return <LoadingState label={t('onboarding.loadingApp')} />;
  }

  const workspaceCount = workspacesQuery.data?.length ?? 0;
  const hasWorkspaces = workspaceCount > 0;
  const completed = onboardingQuery.data?.completed ?? false;
  // "Refazer onboarding" (Settings → Advanced) zera `completed` sem apagar os
  // workspaces. Sem checar `!completed` aqui, o wizard nunca reaparecia.
  const needsOnboarding = !hasWorkspaces || !completed;
  const needsWorkspaceSelection =
    !needsOnboarding && !activeWorkspace && hasWorkspaces && requiresWorkspaceSelection;

  // Enquanto a transição roda, mantemos o wizard montado por baixo do overlay
  // (pra ele continuar existindo quando o gate decidir mostrar o dashboard).
  // O LaunchTransition sai com fade revelando o dashboard que já carregou.
  const handleLaunchDone = () => {
    setLaunching(false);
    // Invalida agora que a transição terminou — provoca o gate a re-renderizar
    // já mostrando o dashboard, sem flash entre estados.
    queryClient.invalidateQueries({ queryKey: ['onboarding'] });
    queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    queryClient.invalidateQueries({ queryKey: ['user'] });
    queryClient.invalidateQueries({ queryKey: ['agents'] });
  };

  return (
    <>
      {needsWorkspaceSelection && !launching ? (
        <WorkspaceEntryScreen />
      ) : needsOnboarding && !launching ? (
        <OnboardingWizard
          error={error}
          onDismissError={() => setError(null)}
          onComplete={async () => {
            await completeMutation.mutateAsync();
          }}
        />
      ) : (
        children
      )}

      {/* Overlay de clonagem do repo — fica ativo enquanto o git clone roda */}
      <AnimatePresence>
        {cloningRepo && <CloningOverlay key="cloning" repoFullName={cloningRepo} />}
      </AnimatePresence>

      {/* Overlay de transição — sai com fade automático quando termina */}
      <AnimatePresence>
        {launching && <LaunchTransition key="launch" onDone={handleLaunchDone} />}
      </AnimatePresence>
    </>
  );
}

function normalizeRemoteOnboardingSources(draft: ReturnType<typeof useOnboardingStore.getState>) {
  const fromList = draft.company.sources
    .filter((source) => source.kind === 'github_repo' || source.kind === 'azure_repo')
    // Repos com PATH local já foram criados pelo main (apontados pro existente, sem
    // clone). Aqui ficam só os remotos SEM path, que precisam ser clonados.
    .filter((source) => !source.path)
    .filter((source): source is typeof source & { repoFullName: string } => !!source.repoFullName)
    .map((source) => ({
      kind: source.kind,
      label: source.label,
      repoFullName: source.repoFullName,
      githubAccountLogin: source.githubAccountLogin ?? null,
    }));
  if (fromList.length > 0) return fromList;

  if (draft.company.provider === 'github' && draft.company.githubRepoFullName) {
    return [
      {
        kind: 'github_repo' as const,
        label:
          draft.company.githubRepoFullName.split('/').pop() || draft.company.name || 'GitHub Repo',
        repoFullName: draft.company.githubRepoFullName,
        githubAccountLogin: null,
      },
    ];
  }
  if (draft.company.provider === 'azure' && draft.company.azureRepoRemoteUrl) {
    return [
      {
        kind: 'azure_repo' as const,
        label:
          draft.company.azureRepoFullName.split('/').pop() || draft.company.name || 'Azure Repo',
        repoFullName: draft.company.azureRepoRemoteUrl,
        githubAccountLogin: null,
      },
    ];
  }
  return [];
}
