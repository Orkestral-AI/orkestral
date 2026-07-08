import { create } from 'zustand';
import type { IssueExecutionEvent } from '@shared/types';

/**
 * Eventos de execução de issues acumulados POR issue, na sessão.
 *
 * Antes ficavam em useState dentro da IssueDetailPage → sumiam ao trocar de
 * página e não eram capturados enquanto você estava noutra tela. Agora um
 * listener global (App.tsx) alimenta este store, então o trace de cada issue
 * persiste durante a sessão inteira (sobrevive a navegação).
 */
export interface LiveExecEvent {
  id: string;
  kind:
    | 'queued'
    | 'started'
    | 'phase'
    | 'tool-use'
    | 'file-change'
    | 'model-route'
    | 'finished'
    | 'error';
  label: string;
  at: number;
  runId?: string;
  toolName?: string;
  toolStatus?: 'pending' | 'done' | 'error';
  filePath?: string;
  additions?: number;
  deletions?: number;
  sourceLabel?: string | null;
  agentName?: string | null;
}

interface ExecState {
  byIssue: Record<string, LiveExecEvent[]>;
  push: (issueId: string, ev: LiveExecEvent) => void;
  ingest: (event: IssueExecutionEvent) => void;
  reset: (issueId: string) => void;
}

function mergeEvents(list: LiveExecEvent[], ev: LiveExecEvent): LiveExecEvent[] {
  const idx = list.findIndex((item) => item.id === ev.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = { ...next[idx], ...ev };
    return next.slice(-200);
  }
  const last = list.at(-1);
  if (
    last &&
    last.kind === ev.kind &&
    last.runId === ev.runId &&
    last.label === ev.label &&
    ev.at - last.at < 1500
  ) {
    return list;
  }
  return [...list, ev].slice(-200);
}

export const useExecutionStore = create<ExecState>((set) => ({
  byIssue: {},
  push: (issueId, ev) =>
    set((s) => ({
      byIssue: {
        ...s.byIssue,
        [issueId]: mergeEvents(s.byIssue[issueId] ?? [], ev),
      },
    })),
  ingest: (event) => {
    const live = execEventToLive(event);
    if (!live) return;
    useExecutionStore.getState().push(event.issueId, live);
  },
  reset: (issueId) => set((s) => ({ byIssue: { ...s.byIssue, [issueId]: [] } })),
}));

/** Nome técnico da tool → rótulo legível pro trace de execução. */
export function humanizeExecTool(name: string): string {
  const map: Record<string, string> = {
    kb_create_page: 'Criando página na knowledge base',
    kb_search: 'Buscando na knowledge base',
    kb_get_page: 'Lendo página da knowledge base',
    kb_get_page_tree: 'Listando árvore da knowledge base',
    kb_link_pages: 'Ligando páginas com wikilink',
    kb_get_backlinks: 'Buscando backlinks',
    comment_on_issue: 'Adicionando comentário',
    update_issue_status: 'Atualizando status da issue',
    list_agents: 'Listando agentes do workspace',
    list_sources: 'Listando sources do workspace',
    list_issues: 'Listando issues',
    create_issue: 'Criando sub-issue',
    Read: 'Lendo arquivo do repo',
    Glob: 'Procurando arquivos no repo',
    Grep: 'Buscando texto no repo',
    Bash: 'Executando comando',
  };
  return map[name] ?? name;
}

/** Converte um IssueExecutionEvent (preload) num LiveExecEvent exibível. */
export function execEventToLive(event: IssueExecutionEvent): LiveExecEvent | null {
  const kind = event.type as LiveExecEvent['kind'];
  const runKey = event.runId ?? 'no-run';
  const id =
    event.type === 'tool-use'
      ? (event.toolCallId ?? `${runKey}:tool:${event.toolCallCount ?? event.toolName ?? 'tool'}`)
      : event.type === 'file-change'
        ? `${runKey}:file:${event.filePath ?? event.message ?? 'file'}`
        : event.type === 'model-route'
          ? `${runKey}:route:${event.modelRoute?.from ?? ''}:${event.modelRoute?.to ?? ''}`
          : `${runKey}:${event.type}`;
  const label =
    kind === 'queued'
      ? (event.message ?? 'Aguardando janela segura de execução')
      : kind === 'started'
        ? 'Agente começou a trabalhar'
        : kind === 'phase'
          ? (event.message ?? 'Executando etapa da task')
          : kind === 'tool-use'
            ? `${humanizeExecTool(event.toolName ?? 'tool')}${
                event.toolStatus === 'pending' ? '…' : ''
              }`
            : kind === 'file-change'
              ? `Editing ${event.filePath ?? 'arquivo'} +${event.additions ?? 0} -${event.deletions ?? 0}`
              : kind === 'model-route'
                ? (event.message ?? 'Roteando modelo')
                : kind === 'finished'
                  ? (event.message ?? 'Concluído')
                  : kind === 'error'
                    ? (event.error ?? 'Erro')
                    : 'Evento';
  return {
    id,
    kind,
    label,
    at: event.createdAt ? Date.parse(event.createdAt) || Date.now() : Date.now(),
    runId: event.runId,
    toolName: event.toolName,
    toolStatus: event.toolStatus,
    filePath: event.filePath,
    additions: event.additions,
    deletions: event.deletions,
    sourceLabel: event.sourceLabel,
    agentName: event.agentName,
  };
}
