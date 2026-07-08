import { create } from 'zustand';
import type {
  AdapterType,
  OnboardingObjective,
  OnboardingSubmission,
  PerformancePreset,
  Plan,
  WorkspaceSourceKind,
} from '@shared/types';
import { DEFAULT_PERFORMANCE_PRESET } from '@shared/performance-presets';

/**
 * Fluxo novo (4 steps + welcome):
 *   0 - Welcome (galáxia)
 *   1 - Dados pessoais + Company (name, mission opcional)
 *   2 - Agente (name, adapter type, model, test)
 *   3 - Tarefas (multi-select)
 *   4 - Plano (free-local | team-cloud)
 */
interface OnboardingDraft {
  step: number;
  user: { name: string; email: string };
  /**
   * O workspace É o projeto — guarda nome + path local OU git remote.
   * Provider: 'local' (pasta), 'github' ou 'azure' (repo clonado).
   */
  company: {
    name: string;
    mission: string;
    icon?: string;
    color: string;
    provider: 'local' | 'github' | 'azure' | null;
    path: string;
    gitRemote: string;
    /** Quando provider=github e o user selecionou um repo: "owner/name". */
    githubRepoFullName: string;
    /** Default branch do repo selecionado — usado no clone (opcional). */
    githubBranch: string;
    /** URL remota do Azure Repo selecionado. */
    azureRepoRemoteUrl: string;
    /** Nome exibivel org/project/repo do Azure Repo selecionado. */
    azureRepoFullName: string;
    sources: Array<{
      kind: WorkspaceSourceKind;
      label: string;
      path?: string | null;
      repoFullName?: string | null;
      branch?: string | null;
      githubAccountLogin?: string | null;
    }>;
  };
  agent: {
    name: string;
    adapterType: AdapterType;
    model: string;
    adapterConfig: Record<string, unknown>;
    autonomyLevel: 'low' | 'medium' | 'high';
  };
  objectives: OnboardingObjective[];
  plan: Plan;
  runInitialHiringPlan: boolean;
  /** Preset de desempenho/memória — footprint dos modelos locais (fast-apply/embeddings),
   * auto-aplicado pela RAM detectada. */
  performancePreset: PerformancePreset;
  /** True quando o preset foi setado manualmente — trava o auto-detect de sobrescrever. */
  performancePresetTouched: boolean;
}

interface OnboardingStore extends OnboardingDraft {
  setStep: (step: number) => void;
  next: () => void;
  prev: () => void;
  patchUser: (patch: Partial<OnboardingDraft['user']>) => void;
  patchCompany: (patch: Partial<OnboardingDraft['company']>) => void;
  patchAgent: (patch: Partial<OnboardingDraft['agent']>) => void;
  toggleObjective: (obj: OnboardingObjective) => void;
  /** Define a lista inteira de objetivos de uma vez (marcar/desmarcar todos). */
  setObjectives: (objs: OnboardingObjective[]) => void;
  setPlan: (plan: Plan) => void;
  /** Escolha MANUAL do slider — trava o auto-detect. */
  setPerformancePreset: (preset: PerformancePreset) => void;
  /** Auto-detect pela RAM — só aplica se o usuário ainda não mexeu no slider. */
  applyRecommendedPreset: (preset: PerformancePreset) => void;
  toSubmission: () => OnboardingSubmission;
  reset: () => void;
}

const TOTAL_STEPS = 5; // welcome + 4 steps reais

const initial: OnboardingDraft = {
  step: 0,
  user: { name: '', email: '' },
  company: {
    name: '',
    mission: '',
    color: '#A78BFA',
    provider: null,
    path: '',
    gitRemote: '',
    githubRepoFullName: '',
    githubBranch: '',
    azureRepoRemoteUrl: '',
    azureRepoFullName: '',
    sources: [],
  },
  agent: {
    name: 'CEO',
    adapterType: 'claude_local',
    model: 'default',
    adapterConfig: {},
    autonomyLevel: 'medium',
  },
  objectives: [],
  plan: 'free-local',
  runInitialHiringPlan: true,
  performancePreset: DEFAULT_PERFORMANCE_PRESET,
  performancePresetTouched: false,
};

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  ...initial,
  setStep: (step) => set({ step: Math.max(0, Math.min(step, TOTAL_STEPS - 1)) }),
  next: () => set((s) => ({ step: Math.min(s.step + 1, TOTAL_STEPS - 1) })),
  prev: () => set((s) => ({ step: Math.max(s.step - 1, 0) })),
  patchUser: (patch) => set((s) => ({ user: { ...s.user, ...patch } })),
  patchCompany: (patch) => set((s) => ({ company: { ...s.company, ...patch } })),
  patchAgent: (patch) => set((s) => ({ agent: { ...s.agent, ...patch } })),
  toggleObjective: (obj) =>
    set((s) => ({
      objectives: s.objectives.includes(obj)
        ? s.objectives.filter((o) => o !== obj)
        : [...s.objectives, obj],
    })),
  setObjectives: (objs) => set({ objectives: [...objs] }),
  setPlan: (plan) => set({ plan }),
  setPerformancePreset: (performancePreset) =>
    set({ performancePreset, performancePresetTouched: true }),
  applyRecommendedPreset: (preset) =>
    set((s) => (s.performancePresetTouched ? {} : { performancePreset: preset })),
  toSubmission: () => {
    const s = get();
    return {
      user: {
        name: s.user.name.trim(),
        email: s.user.email.trim() || undefined,
      },
      company: {
        name: s.company.name.trim(),
        mission: s.company.mission.trim() || undefined,
        icon: s.company.icon,
        color: s.company.color,
        provider: s.company.provider ?? undefined,
        path: s.company.path.trim() || undefined,
        gitRemote: s.company.gitRemote.trim() || undefined,
        sources: s.company.sources,
      },
      agent: {
        name: s.agent.name.trim() || 'CEO',
        adapterType: s.agent.adapterType,
        model: s.agent.model === 'default' ? undefined : s.agent.model,
        adapterConfig: s.agent.adapterConfig,
        autonomyLevel: s.agent.autonomyLevel,
      },
      objectives: s.objectives,
      plan: s.plan,
      runInitialHiringPlan: s.runInitialHiringPlan,
      performancePreset: s.performancePreset,
    };
  },
  reset: () => set({ ...initial }),
}));

export { TOTAL_STEPS };
