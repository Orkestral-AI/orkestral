import { create } from 'zustand';
import { humanizeExecTool } from './executionStore';

/**
 * Status de atividade dos agentes derivado dos eventos de execução de issues
 * (P1-02). Um agente está "trabalhando" enquanto houver ao menos uma issue ativa
 * atribuída a ele. Alimentado pelo listener global em App.tsx; consumido pela
 * sidebar pra mostrar a bolinha online/trabalhando + tooltip da task atual.
 *
 * Fonte de verdade = eventos `issue:execution-event` (started → working,
 * finished/error → idle). Mapeia por issueId pra fechar o estado certo mesmo com
 * vários agentes/issues simultâneos.
 */
interface ActiveEntry {
  agentId: string;
  agentName: string;
  task: string;
}

interface AgentStatusEvent {
  type: 'started' | 'phase' | 'tool-use' | 'finished' | 'error';
  issueId: string;
  agentId?: string;
  agentName?: string;
  message?: string;
  toolName?: string;
}

interface AgentStatusState {
  /** issueId → agente/atividade enquanto a issue executa. */
  activeByIssue: Record<string, ActiveEntry>;
  applyEvent: (event: AgentStatusEvent) => void;
}

export const useAgentStatusStore = create<AgentStatusState>((set) => ({
  activeByIssue: {},
  applyEvent: (event) =>
    set((s) => {
      if (event.type === 'started' && event.agentId) {
        return {
          activeByIssue: {
            ...s.activeByIssue,
            [event.issueId]: {
              agentId: event.agentId,
              agentName: event.agentName ?? '',
              task: event.message ?? '',
            },
          },
        };
      }
      // Atualiza "o que está fazendo agora" (tooltip) conforme as tools rodam.
      if (event.type === 'tool-use') {
        const prev = s.activeByIssue[event.issueId];
        if (!prev) return s;
        return {
          activeByIssue: {
            ...s.activeByIssue,
            [event.issueId]: {
              ...prev,
              task: event.toolName ? humanizeExecTool(event.toolName) : prev.task,
            },
          },
        };
      }
      // Fim do run → libera o agente desta issue.
      if (event.type === 'finished' || event.type === 'error') {
        if (!s.activeByIssue[event.issueId]) return s;
        const next = { ...s.activeByIssue };
        delete next[event.issueId];
        return { activeByIssue: next };
      }
      return s;
    }),
}));

/** Um agente está trabalhando agora (em alguma issue ativa)? Retorna primitivo (estável). */
export function useAgentWorking(agentId: string): boolean {
  return useAgentStatusStore((s) =>
    Object.values(s.activeByIssue).some((a) => a.agentId === agentId),
  );
}

/** Resumo da task atual de um agente (pro tooltip). Null = ocioso. */
export function useAgentTask(agentId: string): string | null {
  return useAgentStatusStore((s) => {
    const e = Object.values(s.activeByIssue).find((a) => a.agentId === agentId);
    return e?.task || null;
  });
}

/** Esta issue está sendo executada agora? (live, pro feedback no épico — P0-10). */
export function useIssueWorking(issueId: string): boolean {
  return useAgentStatusStore((s) => !!s.activeByIssue[issueId]);
}
