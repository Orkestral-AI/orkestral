import { useState, useMemo, useEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CircleDot,
  Plus,
  Search,
  Loader2,
  X,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  ArrowUp,
  Minus,
  Flag,
  Bot,
  Circle,
  CircleDashed,
  CircleCheck,
  CircleSlash,
  Layers,
  Trash2,
  Lock,
  Target,
  CornerDownRight,
  GitPullRequestArrow,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT, type TFunction } from '@renderer/i18n';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useIssuesViewStore } from '@renderer/stores/issuesViewStore';
import { useIssueReadStore } from '@renderer/stores/issueReadStore';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { ConfirmDialog } from '@renderer/components/ui/confirm-dialog';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import type { Agent, Issue, IssuePriority, IssueStatus } from '@shared/types';

const STATUS_ORDER: IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
];

const STATUS_META: Record<
  IssueStatus,
  {
    icon: typeof Circle;
    dot: string;
    text: string;
    bg: string;
  }
> = {
  backlog: {
    icon: CircleDashed,
    dot: 'bg-text-muted',
    text: 'text-text-muted',
    bg: 'bg-surface-faint',
  },
  todo: {
    icon: Circle,
    dot: 'bg-text-secondary',
    text: 'text-text-secondary',
    bg: 'bg-surface-hover',
  },
  in_progress: {
    icon: CircleDot,
    dot: 'bg-accent-yellow',
    text: 'text-accent-yellow',
    bg: 'bg-accent-yellow/5',
  },
  in_review: {
    icon: CircleDot,
    dot: 'bg-accent-purple',
    text: 'text-accent-purple',
    bg: 'bg-accent-purple/5',
  },
  blocked: {
    icon: CircleSlash,
    dot: 'bg-accent-red',
    text: 'text-accent-red',
    bg: 'bg-accent-red/5',
  },
  done: {
    icon: CircleCheck,
    dot: 'bg-accent-green',
    text: 'text-accent-green',
    bg: 'bg-accent-green/5',
  },
  cancelled: {
    icon: CircleSlash,
    dot: 'bg-text-faint',
    text: 'text-text-faint',
    bg: 'bg-surface-ghost',
  },
};

/** Label de status traduzida. */
const statusLabel = (t: TFunction, s: IssueStatus): string => t(`issues.status.${s}`);
/** Label de prioridade traduzida. */
const priorityLabel = (t: TFunction, p: IssuePriority): string => t(`issues.priority.${p}`);

/** Prefixo do workspace ("EzChat" → "EZC"). */
function issuePrefix(workspaceName: string | undefined): string {
  return (
    (workspaceName ?? 'ORK')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'ORK'
  );
}

/**
 * Identifier INTERNO (rota/URL/busca legada) — sempre PREFIX-{issueKey}. NÃO
 * usar pra exibir: o label visível é hierárquico (ver buildDisplayIds).
 */
function issueIdentifier(workspaceName: string | undefined, issueKey: number): string {
  return `${issuePrefix(workspaceName)}-${issueKey}`;
}

/**
 * Identificador HUMANO (display) de cada issue, montado a partir da lista
 * completa do workspace:
 *  - top-level: PREFIX-{displayKey ?? issueKey} (fallback issueKey p/ dados
 *    pré-migração).
 *  - sub-issue: {display do pai}.{childOrdinal} — recursivo, qualquer
 *    profundidade (EZC-4.1, EZC-4.1.2…). Guard de profundidade contra ciclo.
 * Desacoplado do issueIdentifier: a rota/URL continua por issueKey.
 */
function buildDisplayIds(
  allIssues: Issue[],
  workspaceName: string | undefined,
): Map<string, string> {
  const prefix = issuePrefix(workspaceName);
  const byId = new Map(allIssues.map((i) => [i.id, i]));
  const cache = new Map<string, string>();
  function disp(i: Issue, depth: number): string {
    const cached = cache.get(i.id);
    if (cached) return cached;
    const parent = i.parentIssueId ? byId.get(i.parentIssueId) : null;
    const label =
      parent && i.childOrdinal != null && depth < 20
        ? `${disp(parent, depth + 1)}.${i.childOrdinal}`
        : `${prefix}-${i.displayKey ?? i.issueKey}`;
    cache.set(i.id, label);
    return label;
  }
  const out = new Map<string, string>();
  for (const i of allIssues) out.set(i.id, disp(i, 0));
  return out;
}

const PRIORITY_META: Record<IssuePriority, { icon: typeof Flag; cls: string }> = {
  critical: { icon: AlertCircle, cls: 'text-accent-red' },
  high: { icon: ArrowUp, cls: 'text-accent-yellow' },
  medium: { icon: Flag, cls: 'text-text-secondary' },
  low: { icon: Minus, cls: 'text-text-muted' },
};

type GroupMode = 'status' | 'assignee' | 'priority' | 'none';
type SortMode = 'updated' | 'created' | 'priority' | 'number';

export function IssuesPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  // Seleção em massa (multi-select na lista). Set de issue ids selecionados.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const navigate = useNavigate();
  function openIssue(issueKey: number, workspaceName: string | undefined) {
    const ref = issueIdentifier(workspaceName, issueKey);
    navigate(`/issues/${ref}`);
  }
  const view = useIssuesViewStore((s) => s.view);
  const setView = useIssuesViewStore((s) => s.setView);
  const group = useIssuesViewStore((s) => s.group);
  const setGroup = useIssuesViewStore((s) => s.setGroup);
  const sortBy = useIssuesViewStore((s) => s.sortBy);
  const setSortBy = useIssuesViewStore((s) => s.setSortBy);

  const issuesQuery = useQuery({
    queryKey: ['issues', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['issue:list']({ workspaceId: activeWorkspace!.id }),
  });
  const issues = useMemo(() => issuesQuery.data ?? [], [issuesQuery.data]);

  // Ao SAIR da página de Issues, marca todas as visíveis como lidas → zera o
  // badge da sidebar. O destaque (dot + negrito) fica enquanto você olha a
  // lista e some quando sai ("entrei e vi, sai"). Issues que mudarem depois
  // voltam a ficar não-lidas. Usa ref pra pegar a lista mais recente no unmount.
  const markAllIssuesRead = useIssueReadStore((s) => s.markAllRead);
  const issuesRef = useRef(issues);
  useEffect(() => {
    issuesRef.current = issues;
  }, [issues]);
  useEffect(() => {
    return () => {
      const list = issuesRef.current;
      if (list.length > 0)
        markAllIssuesRead(list.map((i) => ({ id: i.id, updatedAt: i.updatedAt })));
    };
  }, [markAllIssuesRead]);

  const agentsQuery = useQuery({
    queryKey: ['agents', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: activeWorkspace!.id }),
  });
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);

  const updateMutation = useMutation({
    mutationFn: ({
      issueId,
      patch,
    }: {
      issueId: string;
      patch: Parameters<(typeof window.orkestral)['issue:update']>[0]['patch'];
    }) => window.orkestral['issue:update']({ issueId, patch }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      queryClient.invalidateQueries({ queryKey: ['issue'] });
    },
  });

  const wsName = activeWorkspace?.name;
  // Mapa id → label humano (EZC-4 / EZC-4.1) montado da lista completa. Usado
  // na lista, no kanban e na busca. Rota/URL continuam por issueKey.
  const displayIds = useMemo(() => buildDisplayIds(issues, wsName), [issues, wsName]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return issues.filter((i) => {
      if (q) {
        const idf = issueIdentifier(wsName, i.issueKey).toLowerCase();
        const human = (displayIds.get(i.id) ?? '').toLowerCase();
        if (
          !i.title.toLowerCase().includes(q) &&
          !idf.includes(q) &&
          !human.includes(q) &&
          !(i.description ?? '').toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [issues, query, wsName, displayIds]);

  // Ordenação dentro de cada grupo
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sortBy === 'number') return b.issueKey - a.issueKey;
      if (sortBy === 'created')
        // Ordem de criação: ascendente por issueKey (proxy mais confiável que
        // createdAt), de modo que EZC-1, EZC-2, EZC-3… apareçam de cima pra
        // baixo. Desempata por createdAt asc.
        return (
          a.issueKey - b.issueKey ||
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      if (sortBy === 'priority') {
        const order = { critical: 0, high: 1, medium: 2, low: 3 };
        return (order[a.priority] ?? 9) - (order[b.priority] ?? 9);
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return arr;
  }, [filtered, sortBy]);

  // ---- Seleção em massa ----
  const selectionActive = selectedIds.size > 0;
  const visibleIds = useMemo(() => sorted.map((i) => i.id), [sorted]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const toggleSelect = (id: string): void =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAllVisible = (): void => setSelectedIds(new Set(visibleIds));
  const clearSelection = (): void => setSelectedIds(new Set());
  // Marca/desmarca um conjunto de ids de uma vez (cabeçalho do grupo "marcar tudo").
  const selectMany = (ids: string[], selected: boolean): void =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  // Mapa pai → filhos (só do workspace) pra expandir a deleção: apagar uma épica
  // sem os filhos os deixaria órfãos. Incluímos todos os descendentes.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const i of issues) {
      if (!i.parentIssueId) continue;
      const list = map.get(i.parentIssueId) ?? [];
      list.push(i.id);
      map.set(i.parentIssueId, list);
    }
    return map;
  }, [issues]);
  const expandWithDescendants = (ids: Set<string>): string[] => {
    const out = new Set(ids);
    const stack = [...ids];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const child of childrenByParent.get(id) ?? []) {
        if (!out.has(child)) {
          out.add(child);
          stack.push(child);
        }
      }
    }
    return [...out];
  };
  // ids finais da deleção (selecionados + descendentes), memoizado pro confirm.
  const deleteIds = useMemo(
    () => expandWithDescendants(selectedIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedIds, childrenByParent],
  );

  const bulkDeleteMutation = useMutation({
    mutationFn: (issueIds: string[]) => window.orkestral['issue:bulk-delete']({ issueIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      queryClient.invalidateQueries({ queryKey: ['issue'] });
      clearSelection();
      setConfirmingBulkDelete(false);
    },
  });
  const bulkStatusMutation = useMutation({
    mutationFn: ({ issueIds, status }: { issueIds: string[]; status: IssueStatus }) =>
      window.orkestral['issue:bulk-set-status']({ issueIds, status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      queryClient.invalidateQueries({ queryKey: ['issue'] });
      clearSelection();
    },
  });

  // Sai do modo seleção ao trocar de workspace ou de view (checkboxes só na lista).
  useEffect(() => {
    setSelectedIds(new Set());
  }, [activeWorkspace?.id, view]);
  // Esc limpa a seleção (atalho esperado).
  useEffect(() => {
    if (!selectionActive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelectedIds(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectionActive]);

  // Agrupamento
  const grouped = useMemo(() => {
    if (group === 'none') return [{ key: 'all', label: t('issues.group.all'), issues: sorted }];
    if (group === 'status') {
      // Mostra todos os status (incluindo done/cancelled). Grupos vazios
      // são filtrados visualmente no PaperclipListView.
      return STATUS_ORDER.map((status) => ({
        key: status,
        label: statusLabel(t, status),
        status,
        issues: sorted.filter((i) => i.status === status),
      }));
    }
    if (group === 'assignee') {
      const map = new Map<string, { key: string; label: string; issues: Issue[] }>();
      for (const i of sorted) {
        const k = i.assigneeAgentId ?? '__unassigned__';
        const agent = agents.find((a) => a.id === i.assigneeAgentId);
        const label = agent?.name ?? t('issues.group.unassigned');
        const g = map.get(k) ?? { key: k, label, issues: [] };
        g.issues.push(i);
        map.set(k, g);
      }
      return Array.from(map.values());
    }
    if (group === 'priority') {
      const order: IssuePriority[] = ['critical', 'high', 'medium', 'low'];
      return order.map((p) => ({
        key: p,
        label: priorityLabel(t, p),
        issues: sorted.filter((i) => i.priority === p),
      }));
    }
    return [];
  }, [sorted, group, agents, t]);

  if (!activeWorkspace) {
    return (
      <PageShell title={t('issues.title')} description={t('issues.description')}>
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('issues.noActiveWorkspace')}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      title={t('issues.title')}
      description={
        sorted.length > 0
          ? t('issues.countInWorkspace', {
              n: sorted.length,
              label: sorted.length === 1 ? t('issues.issueSingular') : t('issues.issuePlural'),
            })
          : t('issues.description')
      }
    >
      {/* Toolbar minimalista estilo paperclip */}
      <div className="flex items-center gap-2 border-b border-hairline-faint px-6 py-2.5">
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 text-[12px] font-medium text-text-primary transition-colors hover:bg-surface-2"
        >
          <Plus className="h-3 w-3" />
          {t('issues.toolbar.newIssue')}
        </button>

        {/* Input de busca cresce e ocupa todo o espaço vago entre o botão
            "Nova issue" e os controles de view/sort/group à direita. Sem
            max-width restrito — preenche o que sobra do toolbar. */}
        <div className="relative ml-1 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('issues.toolbar.searchPlaceholder')}
            className="h-7 w-full rounded-md border border-transparent bg-transparent pl-7 pr-3 text-[12px] text-text-primary placeholder:text-text-muted hover:bg-surface-subtle focus:border-hairline-strong focus:bg-surface-subtle focus:outline-none"
          />
        </div>

        {/* View toggle */}
        <div className="flex h-7 items-stretch overflow-hidden rounded-md border border-hairline-strong">
          {(['list', 'board'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                'inline-flex items-center px-2 text-[10.5px] uppercase tracking-wider transition-colors',
                v !== 'list' && 'border-l border-hairline-strong',
                view === v
                  ? 'bg-surface-active text-text-primary'
                  : 'text-text-muted hover:bg-surface-1 hover:text-text-primary',
              )}
            >
              {v === 'list' ? t('issues.view.list') : t('issues.view.board')}
            </button>
          ))}
        </div>

        {/* Sort */}
        <DSSelect
          value={sortBy}
          onChange={(v) => setSortBy(v as SortMode)}
          options={[
            { value: 'created', label: t('issues.sort.created') },
            { value: 'updated', label: t('issues.sort.updated') },
            { value: 'priority', label: t('issues.sort.priority') },
            { value: 'number', label: t('issues.sort.number') },
          ]}
          className="h-7 w-32 text-[11.5px]"
        />

        {/* Group */}
        <DSSelect
          value={group}
          onChange={(v) => setGroup(v as GroupMode)}
          options={[
            { value: 'status', label: t('issues.group.byStatus') },
            { value: 'assignee', label: t('issues.group.byAssignee') },
            { value: 'priority', label: t('issues.group.byPriority') },
            { value: 'none', label: t('issues.group.none') },
          ]}
          className="h-7 w-32 text-[11.5px]"
        />
      </div>

      {/* Barra de ações em massa — só na lista, com seleção ativa. */}
      {view === 'list' && selectionActive && (
        <div className="flex items-center gap-3 border-b border-hairline-faint bg-surface-subtle px-6 py-2">
          <Checkbox
            checked={allVisibleSelected}
            indeterminate={!allVisibleSelected}
            onChange={() => (allVisibleSelected ? clearSelection() : selectAllVisible())}
            aria-label={t('issues.bulk.selectAll')}
          />
          <span className="text-[12px] font-medium text-text-primary">
            {t('issues.bulk.selectedCount', { n: selectedIds.size })}
          </span>
          <button
            type="button"
            onClick={() => (allVisibleSelected ? clearSelection() : selectAllVisible())}
            className="text-[11.5px] text-text-secondary transition-colors hover:text-text-primary"
          >
            {allVisibleSelected
              ? t('issues.bulk.clearAll')
              : t('issues.bulk.selectAllN', { n: visibleIds.length })}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <DSSelect
              value=""
              placeholder={t('issues.bulk.changeStatus')}
              onChange={(s) => {
                if (s)
                  bulkStatusMutation.mutate({
                    issueIds: [...selectedIds],
                    status: s as IssueStatus,
                  });
              }}
              options={STATUS_ORDER.map((s) => ({ value: s, label: statusLabel(t, s) }))}
              className="h-7 w-36 text-[11.5px]"
            />
            <button
              type="button"
              onClick={() => setConfirmingBulkDelete(true)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-accent-red/30 bg-accent-red/5 px-2.5 text-[11.5px] font-medium text-accent-red transition-colors hover:bg-accent-red/10"
            >
              <Trash2 className="h-3 w-3" />
              {t('issues.bulk.delete')}
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
              title={t('issues.bulk.clear')}
              aria-label={t('issues.bulk.clear')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Body */}
      {issuesQuery.isPending ? (
        <IssuesListSkeleton t={t} />
      ) : sorted.length === 0 ? (
        <EmptyIssues onCreate={() => setCreating(true)} t={t} />
      ) : view === 'board' ? (
        <KanbanView
          issues={sorted}
          agents={agents}
          displayIds={displayIds}
          onClickIssue={(i) => openIssue(i.issueKey, activeWorkspace.name)}
          onMove={(issueId, status) => updateMutation.mutate({ issueId, patch: { status } })}
          t={t}
        />
      ) : (
        <PaperclipListView
          groups={grouped}
          agents={agents}
          workspaceName={activeWorkspace.name}
          workspaceId={activeWorkspace.id}
          displayIds={displayIds}
          onClickIssue={(i) => openIssue(i.issueKey, activeWorkspace.name)}
          onQuickCreate={() => setCreating(true)}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectMany={selectMany}
          t={t}
        />
      )}

      {creating && (
        <CreateIssueModal
          agents={agents}
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
          t={t}
          onClose={() => setCreating(false)}
          onCreated={(issue) => {
            setCreating(false);
            queryClient.invalidateQueries({ queryKey: ['issues'] });
            openIssue(issue.issueKey, activeWorkspace.name);
          }}
        />
      )}

      {confirmingBulkDelete && (
        <ConfirmDialog
          title={t('issues.bulk.deleteTitle', { n: deleteIds.length })}
          body={
            deleteIds.length > selectedIds.size
              ? t('issues.bulk.deleteBodyChildren', {
                  selected: selectedIds.size,
                  extra: deleteIds.length - selectedIds.size,
                })
              : t('issues.bulk.deleteBody')
          }
          variant="danger"
          confirmLabel={t('issues.bulk.deleteConfirm')}
          busy={bulkDeleteMutation.isPending}
          onConfirm={() => bulkDeleteMutation.mutate(deleteIds)}
          onCancel={() => setConfirmingBulkDelete(false)}
        />
      )}
    </PageShell>
  );
}

/** Lista agrupada estilo paperclip — cabeçalho colapsável por grupo + linhas compactas. */
function PaperclipListView({
  groups,
  agents,
  workspaceName,
  workspaceId,
  displayIds,
  onClickIssue,
  onQuickCreate,
  selectedIds,
  onToggleSelect,
  onSelectMany,
  t,
}: {
  groups: Array<{ key: string; label: string; status?: IssueStatus; issues: Issue[] }>;
  agents: Agent[];
  workspaceName: string;
  workspaceId: string;
  displayIds: Map<string, string>;
  onClickIssue: (i: Issue) => void;
  onQuickCreate: () => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectMany: (ids: string[], selected: boolean) => void;
  t: TFunction;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setCollapsed((s) => ({ ...s, [k]: !s[k] }));

  // Expand POR ISSUE-PAI: começa vazio = tudo minimizado (só as issues-pai
  // aparecem). Persistido por workspace em localStorage. Uma linha só é visível
  // se TODOS os seus ancestrais estão expandidos.
  const expandKey = `ork:issues:expanded:${workspaceId}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(expandKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  // Recarrega ao trocar de workspace (o componente pode não remontar).
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const raw = localStorage.getItem(`ork:issues:expanded:${workspaceId}`);
        setExpanded(new Set(raw ? (JSON.parse(raw) as string[]) : []));
      } catch {
        setExpanded(new Set());
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [workspaceId]);
  const toggleExpand = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(`ork:issues:expanded:${workspaceId}`, JSON.stringify([...next]));
      } catch {
        /* localStorage indisponível — segue só em memória */
      }
      return next;
    });

  // Pré-computa a ordem em árvore (DFS hierárquico) de cada grupo uma única vez
  // por mudança em `groups`, em vez de rodar buildTreeOrder a cada render dentro
  // do .map(). Keyed só em `groups` — a derivação não depende de mais nada.
  const treeOrders = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildTreeOrder>>();
    for (const g of groups) {
      if (g.issues.length > 0) map.set(g.key, buildTreeOrder(g.issues));
    }
    return map;
  }, [groups]);

  return (
    <div className="thin-scrollbar flex-1 overflow-y-auto">
      {groups
        .filter((g) => g.issues.length > 0)
        .map((g) => {
          const isOpen = !collapsed[g.key];
          // Usa o status carregado no grupo (quando agrupado por status) pra colorir o dot.
          const statusMeta = g.status ? STATUS_META[g.status] : null;
          // Estado de seleção do grupo → checkbox "marcar tudo" no cabeçalho.
          const groupIds = g.issues.map((i) => i.id);
          const groupSelectedCount = groupIds.reduce(
            (n, id) => n + (selectedIds.has(id) ? 1 : 0),
            0,
          );
          const allGroupSelected = groupIds.length > 0 && groupSelectedCount === groupIds.length;
          return (
            <section key={g.key}>
              <div className="group flex w-full items-center gap-2 bg-surface-whisper px-6 py-1.5 transition-colors hover:bg-surface-subtle">
                <Checkbox
                  checked={allGroupSelected}
                  indeterminate={groupSelectedCount > 0 && !allGroupSelected}
                  onChange={() => onSelectMany(groupIds, !allGroupSelected)}
                  aria-label={t('issues.bulk.selectAll')}
                  className="border-border-strong bg-surface-elevated"
                />
                <button
                  type="button"
                  onClick={() => toggle(g.key)}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3 w-3 text-text-faint" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-text-faint" />
                  )}
                  {statusMeta && (
                    <span className={cn('h-1.5 w-1.5 rounded-full', statusMeta.dot)} />
                  )}
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                    {g.label}
                  </span>
                  <span className="text-[10.5px] text-text-faint">{g.issues.length}</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onQuickCreate();
                  }}
                  className="grid h-5 w-5 place-items-center rounded text-text-faint opacity-0 transition-opacity hover:bg-surface-active hover:text-text-primary group-hover:opacity-100"
                  title={t('issues.list.newIssueTooltip')}
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
              {isOpen &&
                (treeOrders.get(g.key) ?? [])
                  // Esconde linha se algum ancestral está colapsado.
                  .filter((r) => r.ancestorIds.every((aid) => expanded.has(aid)))
                  .map(({ issue, depth, isOrphanChild, parentRef, hasChildren }) => (
                    <PaperclipIssueRow
                      key={issue.id}
                      issue={issue}
                      agents={agents}
                      displayId={
                        displayIds.get(issue.id) ?? issueIdentifier(workspaceName, issue.issueKey)
                      }
                      depth={depth}
                      isOrphanChild={isOrphanChild}
                      parentRef={parentRef}
                      hasChildren={hasChildren}
                      isExpanded={expanded.has(issue.id)}
                      onToggleExpand={() => toggleExpand(issue.id)}
                      onClick={() => onClickIssue(issue)}
                      selected={selectedIds.has(issue.id)}
                      onToggleSelect={() => onToggleSelect(issue.id)}
                      t={t}
                    />
                  ))}
            </section>
          );
        })}
    </div>
  );
}

/**
 * Ordena issues do grupo em DFS hierárquico — épica primeiro, depois suas
 * sub-issues indentadas (depth+1). Issues cujo parent está em OUTRO grupo
 * de status são marcadas `isOrphanChild` — aparecem no nível 0 do grupo
 * delas mas mostram um chip "↳ subtask de EZC-N" pra contexto.
 */
function buildTreeOrder(issues: Issue[]): Array<{
  issue: Issue;
  depth: number;
  isOrphanChild: boolean;
  parentRef: Issue | null;
  /** Tem filhos no MESMO grupo → ganha chevron de expandir/colapsar. */
  hasChildren: boolean;
  /** IDs dos ancestrais (do mais distante ao pai direto) — usado pra esconder a
   * linha quando algum ancestral está colapsado. */
  ancestorIds: string[];
}> {
  const byId = new Map(issues.map((i) => [i.id, i]));
  // Ordem de criação dentro da árvore: ascendente por issueKey. Isso garante
  // que épicas e suas sub-issues fiquem em ordem de criação (EZC-3 antes de
  // EZC-4, EZC-5…) independente do sort ativo na toolbar.
  const byCreation = (a: Issue, b: Issue): number => a.issueKey - b.issueKey;
  // childrenOf parents que estão no MESMO grupo
  const childrenOf = new Map<string, Issue[]>();
  for (const i of issues) {
    if (i.parentIssueId && byId.has(i.parentIssueId)) {
      const list = childrenOf.get(i.parentIssueId) ?? [];
      list.push(i);
      childrenOf.set(i.parentIssueId, list);
    }
  }
  // Ordena os filhos de cada parent por ordem de criação.
  for (const list of childrenOf.values()) list.sort(byCreation);
  const roots = issues
    .filter((i) => !i.parentIssueId || !byId.has(i.parentIssueId))
    .sort(byCreation);
  const out: ReturnType<typeof buildTreeOrder> = [];
  function walk(i: Issue, depth: number, ancestorIds: string[]): void {
    const isOrphanChild = !!i.parentIssueId && !byId.has(i.parentIssueId) && depth === 0;
    const kids = childrenOf.get(i.id) ?? [];
    out.push({
      issue: i,
      depth,
      isOrphanChild,
      parentRef: null,
      hasChildren: kids.length > 0,
      ancestorIds,
    });
    for (const k of kids) walk(k, depth + 1, [...ancestorIds, i.id]);
  }
  for (const r of roots) walk(r, 0, []);
  return out;
}

/** Linha de issue estilo paperclip: [status icon] [PREFIX-N] [título] [...assignee] [data]. */
function PaperclipIssueRow({
  issue,
  agents,
  displayId,
  depth = 0,
  isOrphanChild = false,
  hasChildren = false,
  isExpanded = false,
  onToggleExpand,
  onClick,
  selected = false,
  onToggleSelect,
  t,
}: {
  issue: Issue;
  agents: Agent[];
  displayId: string;
  depth?: number;
  isOrphanChild?: boolean;
  parentRef?: Issue | null;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onClick: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
  t: TFunction;
}) {
  const statusMeta = STATUS_META[issue.status];
  const StatusIcon = statusMeta.icon;
  const priorityMeta = PRIORITY_META[issue.priority];
  const PriorityIcon = priorityMeta.icon;
  const assignee = agents.find((a) => a.id === issue.assigneeAgentId);
  // Não-lida = nunca aberta OU teve update depois da última visita. Lê o
  // mesmo store que o IssueDetailPage marca via markRead ao abrir.
  const isUnread = useIssueReadStore((s) => {
    const r = s.readAt[issue.id];
    return !r || issue.updatedAt > r;
  });

  // Marcador (chevron/↳) fica ABSOLUTO na sarjeta esquerda, fora do fluxo flex,
  // pra NÃO empurrar o ícone de status — assim o ícone verde alinha em todas as
  // linhas, com ou sem chevron. Posicionado ~18px à esquerda do conteúdo.
  const contentLeft = depth > 0 ? 24 + depth * 20 : 24;
  const markerLeft = contentLeft - 18;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'group/row relative flex w-full cursor-pointer items-center gap-3 border-b border-hairline-ghost px-6 py-2 text-left transition-colors',
        selected ? 'bg-accent/[0.06] hover:bg-accent/[0.09]' : 'hover:bg-surface-faint',
      )}
      style={depth > 0 ? { paddingLeft: contentLeft } : undefined}
    >
      {hasChildren ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand?.();
          }}
          className="absolute top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded text-text-faint transition-colors hover:bg-surface-active hover:text-text-primary"
          style={{ left: markerLeft }}
          title={t(isExpanded ? 'issues.list.collapse' : 'issues.list.expand')}
          aria-label={t(isExpanded ? 'issues.list.collapse' : 'issues.list.expand')}
        >
          {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
      ) : depth > 0 ? (
        <span
          className="absolute top-1/2 -translate-y-1/2 select-none text-[12px] text-text-faint"
          style={{ left: markerLeft }}
          aria-hidden
        >
          ↳
        </span>
      ) : null}
      {/* Seleção: checkbox SEMPRE visível (sutil — fundo cinza + borda clara);
          dot de não-lida (azul) só aparece quando a issue está não-lida. */}
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          className={cn('h-1.5 w-1.5 rounded-full', isUnread ? 'bg-accent-blue' : 'bg-transparent')}
          aria-hidden
        />
        <Checkbox
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggleSelect?.()}
          aria-label={t('issues.bulk.selectRow')}
          className="border-border-strong bg-surface-elevated"
        />
      </span>
      <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', statusMeta.text)} />
      <span
        className="w-20 shrink-0 truncate font-mono text-[10.5px] text-text-faint"
        title={displayId}
      >
        {displayId}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[12.5px]',
          isUnread ? 'font-semibold text-text-primary' : 'text-text-primary',
        )}
      >
        {issue.title}
      </span>
      {isOrphanChild && (
        <span
          className="hidden shrink-0 rounded border border-hairline-faint bg-surface-faint px-1.5 py-0.5 text-[9.5px] text-text-faint sm:inline"
          title={t('issues.list.subtaskTooltip')}
        >
          {t('issues.list.subtask')}
        </span>
      )}
      {issue.priority !== 'medium' && (
        <PriorityIcon
          className={cn('h-3 w-3 shrink-0', priorityMeta.cls)}
          aria-label={priorityLabel(t, issue.priority)}
        />
      )}
      {assignee ? (
        <span
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-hairline-strong bg-surface-faint py-px pl-px pr-1.5 text-[10px] text-text-secondary"
          title={assignee.name}
        >
          <AgentAvatar
            seed={assignee.avatarSeed}
            name={assignee.name}
            size={16}
            rounded="full"
            className="ring-0"
          />
          <span className="max-w-[100px] truncate">{assignee.name}</span>
        </span>
      ) : (
        <span className="text-[10px] text-text-faint">{t('issues.list.unassigned')}</span>
      )}
      <span className="w-16 shrink-0 text-right text-[10.5px] text-text-faint">
        {fmtRelative(issue.updatedAt, t)}
      </span>
    </div>
  );
}

/** Skeleton de carregamento da lista — linhas em pulse no mesmo gabarito das
 *  rows reais (status icon + identifier + título + assignee + data). */
function IssuesListSkeleton({ t }: { t: TFunction }) {
  return (
    <div
      className="thin-scrollbar flex-1 overflow-y-auto"
      aria-busy="true"
      aria-label={t('issues.list.loadingAria')}
    >
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex w-full items-center gap-3 border-b border-hairline-ghost px-6 py-2.5"
        >
          <Skeleton className="h-3.5 w-3.5 rounded-full" />
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 flex-1" style={{ maxWidth: `${40 + ((i * 13) % 45)}%` }} />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

function EmptyIssues({ onCreate, t }: { onCreate: () => void; t: TFunction }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <Layers className="h-7 w-7 text-text-muted" />
      <div className="mt-3 text-[14px] font-medium text-text-primary">
        {t('issues.empty.title')}
      </div>
      <div className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-text-muted">
        {t('issues.empty.body')}
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-4 text-[12.5px] font-medium text-text-primary transition-colors hover:bg-surface-2"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('issues.empty.cta')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------

function KanbanView({
  issues,
  agents,
  displayIds,
  onClickIssue,
  onMove,
  t,
}: {
  issues: Issue[];
  agents: Agent[];
  displayIds: Map<string, string>;
  onClickIssue: (i: Issue) => void;
  onMove: (issueId: string, status: IssueStatus) => void;
  t: TFunction;
}) {
  const byStatus = useMemo(() => {
    const map: Record<IssueStatus, Issue[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      in_review: [],
      blocked: [],
      done: [],
      cancelled: [],
    };
    for (const i of issues) {
      map[i.status]?.push(i);
    }
    return map;
  }, [issues]);

  // Mapas pra enriquecer o card sem query extra: pai (displayId) e nº de sub-issues.
  const { childCount } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of issues) {
      if (i.parentIssueId) counts.set(i.parentIssueId, (counts.get(i.parentIssueId) ?? 0) + 1);
    }
    return { childCount: counts };
  }, [issues]);
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues]);

  return (
    <div className="thin-scrollbar flex flex-1 gap-3 overflow-x-auto px-6 py-4">
      {STATUS_ORDER.map((status) => {
        const meta = STATUS_META[status];
        const list = byStatus[status] ?? [];
        return (
          <div
            key={status}
            className="flex w-72 shrink-0 flex-col rounded-lg border border-hairline-faint bg-surface-whisper"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              const issueId = e.dataTransfer.getData('issueId');
              if (issueId) onMove(issueId, status);
            }}
          >
            <div className="flex items-center gap-2 border-b border-hairline-faint px-3 py-2">
              <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
              <span className={cn('text-[11px] font-medium uppercase tracking-wider', meta.text)}>
                {statusLabel(t, status)}
              </span>
              <span className="text-[10.5px] text-text-faint">{list.length}</span>
            </div>
            <div className="thin-scrollbar flex flex-1 flex-col gap-1.5 overflow-y-auto p-2">
              {list.map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  displayId={displayIds.get(issue.id) ?? `#${issue.issueKey}`}
                  agent={agents.find((a) => a.id === issue.assigneeAgentId)}
                  parentDisplayId={
                    issue.parentIssueId && byId.has(issue.parentIssueId)
                      ? (displayIds.get(issue.parentIssueId) ?? null)
                      : null
                  }
                  childCount={childCount.get(issue.id) ?? 0}
                  onClick={() => onClickIssue(issue)}
                  t={t}
                />
              ))}
              {list.length === 0 && (
                <div className="px-2 py-3 text-center text-[11px] text-text-faint">
                  {t('issues.kanban.noIssues')}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function IssueCard({
  issue,
  agent,
  displayId,
  parentDisplayId,
  childCount = 0,
  onClick,
  t,
}: {
  issue: Issue;
  displayId: string;
  agent?: Agent;
  parentDisplayId?: string | null;
  childCount?: number;
  onClick: () => void;
  t: TFunction;
}) {
  const priority = PRIORITY_META[issue.priority];
  const PriorityIcon = priority.icon;
  const blocked = issue.status === 'blocked';
  const inReview = issue.status === 'in_review';
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => e.dataTransfer.setData('issueId', issue.id)}
      onClick={onClick}
      className={cn(
        'group rounded-md border bg-surface-faint p-2.5 text-left transition-colors hover:bg-surface-1',
        blocked ? 'border-accent-red/35' : 'border-hairline',
      )}
    >
      {/* Topo: id + ref do pai (sub-issue) + status especial + prioridade */}
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10.5px] text-text-faint">{displayId}</span>
        {parentDisplayId && (
          <span
            className="inline-flex items-center gap-0.5 truncate font-mono text-[10px] text-text-faint"
            title={`${t('issues.card.parent')}: ${parentDisplayId}`}
          >
            <CornerDownRight className="h-2.5 w-2.5 shrink-0" />
            {parentDisplayId}
          </span>
        )}
        <span className="flex-1" />
        {blocked && <Lock className="h-3 w-3 text-accent-red" />}
        {inReview && <GitPullRequestArrow className="h-3 w-3 text-accent-purple" />}
        {issue.goalId && <Target className="h-3 w-3 text-accent-purple/80" />}
        <PriorityIcon className={cn('h-3 w-3', priority.cls)} />
      </div>

      <div className="mt-1.5 line-clamp-2 text-[12.5px] font-medium text-text-primary">
        {issue.title}
      </div>

      {/* Meta: responsável + sub-issues + labels */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {agent ? (
          <span className="inline-flex items-center gap-1 rounded bg-surface-1 px-1.5 py-0.5 text-[10.5px] text-text-secondary">
            <AgentAvatar seed={agent.avatarSeed} name={agent.name} size={10} />
            {agent.name}
          </span>
        ) : (
          <span className="text-[10.5px] text-text-faint">{t('issues.card.noAssignee')}</span>
        )}
        {childCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded bg-surface-1 px-1.5 py-0.5 text-[10.5px] text-text-faint">
            <Layers className="h-2.5 w-2.5" />
            {childCount}
          </span>
        )}
        {issue.labels.slice(0, 2).map((l) => (
          <span
            key={l}
            className="max-w-[90px] truncate rounded bg-surface-1 px-1.5 py-0.5 text-[10px] text-text-faint"
          >
            {l}
          </span>
        ))}
        {issue.labels.length > 2 && (
          <span className="text-[10px] text-text-faint">+{issue.labels.length - 2}</span>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// List view (rows)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Create modal
// ---------------------------------------------------------------------------

function CreateIssueModal({
  workspaceId,
  workspaceName,
  agents,
  onClose,
  onCreated,
  t,
}: {
  workspaceId: string;
  workspaceName: string;
  agents: Agent[];
  onClose: () => void;
  onCreated: (issue: Issue) => void;
  t: TFunction;
}) {
  const draftKey = `orkestral.issue-draft.${workspaceId}`;
  const [title, setTitle] = useState(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      return raw ? (JSON.parse(raw).title ?? '') : '';
    } catch {
      return '';
    }
  });
  const [description, setDescription] = useState(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      return raw ? (JSON.parse(raw).description ?? '') : '';
    } catch {
      return '';
    }
  });
  const [status, setStatus] = useState<IssueStatus>('todo');
  const [priority, setPriority] = useState<IssuePriority>('medium');
  const [assigneeAgentId, setAssigneeAgentId] = useState<string>('');

  // Salva draft com debounce (sem useEffect pra simplicidade — só on change)
  const persistDraft = (next: { title?: string; description?: string }) => {
    try {
      const current = { title, description, ...next };
      localStorage.setItem(draftKey, JSON.stringify(current));
    } catch {
      // ignore
    }
  };

  const createMutation = useMutation({
    mutationFn: () =>
      window.orkestral['issue:create-full']({
        workspaceId,
        title: title.trim(),
        description: description.trim() || null,
        priority,
        assigneeAgentId: assigneeAgentId || null,
        status,
      }),
    onSuccess: (issue) => {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // ignore
      }
      onCreated(issue);
    },
  });

  const valid = title.trim().length >= 2;
  const prefix =
    (workspaceName ?? 'ORK')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'ORK';
  const assignee = agents.find((a) => a.id === assigneeAgentId);
  const statusMeta = STATUS_META[status];
  const StatusIcon = statusMeta.icon;
  const priorityMeta = PRIORITY_META[priority];
  const PriorityIcon = priorityMeta.icon;

  const discardDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // ignore
    }
    setTitle('');
    setDescription('');
    onClose();
  };

  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="bg-dialog"
        style={{
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          width: '100%',
          maxWidth: 640,
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Breadcrumb header */}
        <div className="flex items-center justify-between border-b border-hairline-faint px-4 py-3">
          <div className="flex items-center gap-2 text-[11.5px] text-text-secondary">
            <span className="rounded bg-surface-active px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-text-primary">
              {prefix}
            </span>
            <ChevronRight className="h-3 w-3 text-text-faint" />
            <span>{t('issues.create.breadcrumb')}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={createMutation.isPending}
            className="grid h-6 w-6 place-items-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary disabled:opacity-40"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {/* Title */}
          <input
            autoFocus
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              persistDraft({ title: e.target.value });
            }}
            placeholder={t('issues.create.titlePlaceholder')}
            className="w-full bg-transparent text-[16px] font-medium text-text-primary placeholder:text-text-muted focus:outline-none"
          />

          {/* For [Assignee] in [Project] inline */}
          <div className="mt-2 flex items-center gap-2 text-[11.5px] text-text-muted">
            <span>{t('issues.create.forLabel')}</span>
            <InlinePicker
              value={assignee?.name ?? t('issues.group.unassigned')}
              icon={Bot}
              active={!!assignee}
            >
              {/* Popover - usando DSSelect inline */}
              <DSSelect
                value={assigneeAgentId}
                onChange={setAssigneeAgentId}
                options={[
                  { value: '', label: t('issues.create.assignPlaceholder'), muted: true },
                  ...agents.map((a) => ({
                    value: a.id,
                    label: a.name,
                    icon: <AgentAvatar seed={a.avatarSeed} name={a.name} size={12} />,
                  })),
                ]}
                className="h-7 w-44 text-[11.5px]"
              />
            </InlinePicker>
          </div>

          {/* Description */}
          <textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              persistDraft({ description: e.target.value });
            }}
            rows={4}
            placeholder={t('issues.create.descriptionPlaceholder')}
            className="mt-4 min-h-[100px] w-full resize-none rounded-md bg-transparent text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none"
          />

          {/* Toolbar com pickers */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-hairline-soft pt-3">
            {/* Status picker via DSSelect compacto */}
            <div className="inline-flex items-center gap-1 rounded-md border border-hairline-strong bg-surface-subtle pl-2 pr-1 py-0.5">
              <StatusIcon className={cn('h-3 w-3', statusMeta.text)} />
              <DSSelect
                value={status}
                onChange={(v) => setStatus(v as IssueStatus)}
                options={STATUS_ORDER.filter((s) => s !== 'cancelled').map((s) => ({
                  value: s,
                  label: statusLabel(t, s),
                }))}
                className="h-6 border-0 bg-transparent px-1 text-[11.5px]"
              />
            </div>

            {/* Priority */}
            <div className="inline-flex items-center gap-1 rounded-md border border-hairline-strong bg-surface-subtle pl-2 pr-1 py-0.5">
              <PriorityIcon className={cn('h-3 w-3', priorityMeta.cls)} />
              <DSSelect
                value={priority}
                onChange={(v) => setPriority(v as IssuePriority)}
                options={(['critical', 'high', 'medium', 'low'] as IssuePriority[]).map((p) => ({
                  value: p,
                  label: priorityLabel(t, p),
                }))}
                className="h-6 border-0 bg-transparent px-1 text-[11.5px]"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-hairline-faint px-5 py-3">
          <button
            type="button"
            onClick={discardDraft}
            disabled={createMutation.isPending}
            className="text-[11.5px] text-text-muted hover:text-text-primary disabled:opacity-40"
          >
            {t('issues.create.discardDraft')}
          </button>
          <button
            type="button"
            disabled={!valid || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-4 text-[12.5px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
          >
            {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('issues.create.submit')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/** Pill inline com label + popover do filho (DSSelect, etc). */
function InlinePicker({
  value,
  icon: Icon,
  active,
  children,
}: {
  value: string;
  icon?: typeof Bot;
  active?: boolean;
  children: ReactNode;
}) {
  // Compacto: só mostra value como label clicável + children popover ao lado
  void value;
  void Icon;
  void active;
  return <div className="inline-flex items-center">{children}</div>;
}

// ---------------------------------------------------------------------------
// Modal primitives (sem Radix — escapa de stacking issues)
// ---------------------------------------------------------------------------

function ModalOverlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 48,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties
      }
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

function PageShell({
  title,
  description,
  toolbar,
  children,
}: {
  title: string;
  description: string;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <div className="window-drag flex items-start justify-between gap-3 border-b border-hairline-soft px-8 py-5">
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">{title}</h1>
            <p className="mt-0.5 text-[12.5px] text-text-muted">{description}</p>
          </div>
          <div className="window-no-drag">{toolbar}</div>
        </div>
        {children}
      </div>
    </div>
  );
}

function fmtRelative(iso: string, t: TFunction): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return t('issues.relative.now');
    if (mins < 60) return t('issues.relative.minutesAgo', { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t('issues.relative.hoursAgo', { n: hrs });
    return t('issues.relative.daysAgo', { n: Math.floor(hrs / 24) });
  } catch {
    return iso;
  }
}

// Silence unused (CircleDot kept for icon naming) — referenced in router level
void CircleDot;
