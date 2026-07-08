import { useQuery } from '@tanstack/react-query';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import type { Plan } from '@shared/types';

/**
 * Fonte ÚNICA de verdade do plano comercial do usuário.
 *
 * Hoje o backend de cloud/billing NÃO existe — todo mundo é `free-local`. O
 * plano real vem de `onboarding.plan` (escolhido no Step 4) com cross-check no
 * `planMode` do workspace ativo. Quando o Orkestral Cloud existir, basta este
 * hook passar a refletir o estado vindo do backend e Assinatura/Equipe seguem
 * funcionando sem mudança.
 *
 * `isLocal` é o atalho usado pela UI pra decidir entre o estado real (local) e
 * o estado "em breve" (cloud).
 */
export function usePlan(): { plan: Plan; isLocal: boolean; isLoading: boolean } {
  const activeWorkspace = useWorkspaceStore((s) => s.active);

  const onboardingQuery = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => window.orkestral['onboarding:get'](),
  });

  // Ordem de precedência: onboarding.plan → planMode do workspace → free-local.
  const onboardingPlan = onboardingQuery.data?.plan ?? null;
  const workspaceIsTeam = activeWorkspace?.planMode === 'team';

  const plan: Plan = onboardingPlan ?? (workspaceIsTeam ? 'team-cloud' : 'free-local');

  return {
    plan,
    isLocal: plan === 'free-local',
    isLoading: onboardingQuery.isLoading,
  };
}
