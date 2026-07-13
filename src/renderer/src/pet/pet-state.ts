/**
 * Estado visual do pet — LÓGICA PURA (testável com vitest, sem DOM/Electron).
 *
 * O pet consome eventos abstratos (PetEvent) — quem traduz os payloads crus do
 * pushBus (issue:execution-event etc.) em PetEvent é o hook usePetEvents. Essa
 * separação deixa a máquina de estados 100% determinística: mesmo input, mesmo
 * output, sem relógio embutido (o "agora" entra como parâmetro).
 */

export type PetVisualState = 'idle' | 'working' | 'done' | 'error' | 'attention';

export type PetEvent =
  | { kind: 'exec-started'; id: string }
  | { kind: 'exec-finished'; id: string }
  | { kind: 'exec-error'; id: string }
  | { kind: 'attention' }
  | { kind: 'attention-cleared' }
  | { kind: 'error-dismissed' }
  /** Re-hidratação (boot / safety-net): substitui o conjunto de execuções ativas. */
  | { kind: 'hydrate'; activeIds: string[] };

export interface PetState {
  /** Execuções ativas agora (ids únicos — started duplicado não conta 2x). */
  activeIds: readonly string[];
  /** Timestamp (ms) até quando o flash de "done" segura. 0 = sem flash. */
  doneUntil: number;
  /** Erro persistente (fica até dispensa manual do card). */
  hasError: boolean;
  /** Atenção pendente (ex.: proposta nova no inbox). */
  hasAttention: boolean;
}

export const INITIAL_PET_STATE: PetState = {
  activeIds: [],
  doneUntil: 0,
  hasError: false,
  hasAttention: false,
};

/** Quanto tempo o flash de celebração ("done") segura antes de voltar ao estado real. */
export const DONE_FLASH_MS = 5_000;

export function reducePetState(state: PetState, event: PetEvent, now: number): PetState {
  switch (event.kind) {
    case 'exec-started': {
      if (state.activeIds.includes(event.id)) return state;
      return { ...state, activeIds: [...state.activeIds, event.id] };
    }
    case 'exec-finished': {
      if (!state.activeIds.includes(event.id)) return state;
      return {
        ...state,
        activeIds: state.activeIds.filter((id) => id !== event.id),
        doneUntil: now + DONE_FLASH_MS,
      };
    }
    case 'exec-error': {
      return {
        ...state,
        activeIds: state.activeIds.filter((id) => id !== event.id),
        hasError: true,
      };
    }
    case 'attention':
      return { ...state, hasAttention: true };
    case 'attention-cleared':
      return { ...state, hasAttention: false };
    case 'error-dismissed':
      return { ...state, hasError: false };
    case 'hydrate':
      return { ...state, activeIds: [...new Set(event.activeIds)] };
  }
}

/**
 * Projeta o estado interno no visual do sprite. Prioridade:
 * erro (persistente) > trabalhando > flash de done > atenção > idle.
 * Erro na frente de working: agente pode ter falhado com outros ainda rodando —
 * o usuário precisa ver o vermelho.
 */
export function derivePetVisual(state: PetState, now: number): PetVisualState {
  if (state.hasError) return 'error';
  if (state.activeIds.length > 0) return 'working';
  if (state.doneUntil > now) return 'done';
  if (state.hasAttention) return 'attention';
  return 'idle';
}
