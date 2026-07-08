import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Files,
  Search,
  Plus,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Github,
  GitBranch,
  Folder,
  Settings2,
  Brain,
} from 'lucide-react';
import { FileTree } from './FileTree';
import { SearchPanel } from './SearchPanel';
import { Tooltip, TooltipTrigger, TooltipContent } from '@renderer/components/ui/tooltip';
import {
  useContextMenu,
  ContextMenu,
  type ContextMenuItem,
} from '@renderer/components/ui/context-menu';
import { cn } from '@renderer/lib/utils';
import { useCodeTabsStore } from '@renderer/stores/codeTabsStore';
import { useCodeIdeStore } from '@renderer/stores/codeIdeStore';
import { useWorkspaceIdeStore } from '@renderer/stores/workspaceIdeStore';
import { useUIStore } from '@renderer/stores/uiStore';
import { toast } from '@renderer/stores/toastStore';
import { useT } from '@renderer/i18n';
import type { WorkspaceSource } from '@shared/types';

/**
 * Árvore de arquivos UNIFICADA — vive no trilho 2 da sidebar (Fontes). Mostra
 * TODAS as sources locais como raízes colapsáveis. Abrir um arquivo abre uma aba
 * no store global (codeTabsStore) que a página WorkspaceIde renderiza. Cada
 * source-raiz tem menu (Configurações/Analisar) além das ações de arquivo.
 */
export function WorkspaceTree({ workspaceId }: { workspaceId: string }) {
  const { t } = useT();
  const view = useCodeIdeStore((s) => s.view);
  const setView = useCodeIdeStore((s) => s.setView);

  const sourcesQuery = useQuery({
    queryKey: ['sources', workspaceId],
    queryFn: () => window.orkestral['source:list']({ workspaceId }),
  });
  const localSources = (sourcesQuery.data ?? []).filter((s) => !!s.path) as WorkspaceSource[];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Seletor de view: Arquivos | Busca */}
      <div className="flex h-9 shrink-0 items-stretch border-b border-hairline-soft px-1">
        {[
          { v: 'files' as const, Icon: Files, label: t('layout.codeIde.search.viewFiles') },
          { v: 'search' as const, Icon: Search, label: t('layout.codeIde.search.viewSearch') },
        ].map(({ v, Icon, label }) => (
          <Tooltip key={v}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setView(v)}
                aria-label={label}
                aria-pressed={view === v}
                className={cn(
                  'grid w-10 place-items-center border-b-2 transition-colors',
                  view === v
                    ? 'border-accent-purple text-text-primary'
                    : 'border-transparent text-text-faint hover:text-text-secondary',
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {label}
            </TooltipContent>
          </Tooltip>
        ))}
        {/* Adicionar source — sutil, ao lado da busca (sempre visível, não some quando
            uma source expande e empurra a lista pra baixo). */}
        <div className="flex flex-1 items-center justify-end pr-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => useUIStore.getState().openAddSource()}
                aria-label={t('layout.sidebar.addSource')}
                className="grid h-7 w-7 place-items-center rounded text-text-faint transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                <Plus className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('layout.sidebar.addSource')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {view === 'files' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pt-1">
          {localSources.length === 0 ? (
            <p className="px-2 py-4 text-[12px] text-text-faint">
              {t('layout.codeIde.noLocalPath')}
            </p>
          ) : (
            localSources.map((s) => <SourceSection key={s.id} source={s} />)
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden px-1 pt-1">
          <SearchPanel
            sources={localSources.map((s) => ({ id: s.id, label: s.label, path: s.path! }))}
          />
        </div>
      )}
    </div>
  );
}

/** Uma source-raiz colapsável + árvore + menu (config/analisar/ações de arquivo). */
function SourceSection({ source }: { source: WorkspaceSource }) {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const openTab = useCodeTabsStore((s) => s.openTab);
  const active = useCodeTabsStore((s) => s.active);
  const startNewFile = useCodeIdeStore((s) => s.startNewFile);
  const startNewDir = useCodeIdeStore((s) => s.startNewDir);
  const collapseAll = useCodeIdeStore((s) => s.collapseAll);
  const openConfig = useWorkspaceIdeStore((s) => s.openConfig);
  // Sources começam FECHADAS (igual VS Code com várias pastas no workspace).
  const [treeOpen, setTreeOpen] = useState(false);
  const menu = useContextMenu();

  const refreshTree = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['source-dir', source.id] }),
    [queryClient, source.id],
  );

  const analyze = useCallback(async () => {
    try {
      const res = await window.orkestral['kb:request-source-analysis']({
        workspaceId: source.workspaceId,
        sourceId: source.id,
      });
      toast.success(
        t('workspace.analyzeButton.issueCreated', { prefix: res.prefix, key: res.issueKey }),
        undefined,
        {
          action: {
            label: t('workspace.analyzeButton.openIssue'),
            onClick: () => navigate(`/issues/${res.prefix}-${res.issueKey}`),
          },
        },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [source.workspaceId, source.id, t, navigate]);

  const SourceIcon =
    source.kind === 'github_repo' ? Github : source.kind === 'azure_repo' ? GitBranch : Folder;

  const menuItems: ContextMenuItem[] = [
    {
      label: t('layout.codeIde.ctxNewFile'),
      onSelect: () => {
        setTreeOpen(true);
        startNewFile(source.id, '');
      },
    },
    {
      label: t('layout.codeIde.ctxNewFolder'),
      onSelect: () => {
        setTreeOpen(true);
        startNewDir(source.id, '');
      },
    },
    { label: t('layout.codeIde.refreshExplorer'), onSelect: refreshTree },
    { label: t('layout.codeIde.collapseAll'), onSelect: () => collapseAll(source.id) },
    { type: 'separator' },
    {
      label: t('workspace.sourceDetail.tabConfig'),
      icon: <Settings2 className="h-3.5 w-3.5" />,
      onSelect: () => openConfig(source.id),
    },
    {
      label: t('workspace.analyzeButton.analyze'),
      icon: <Brain className="h-3.5 w-3.5" />,
      onSelect: () => void analyze(),
    },
  ];

  return (
    <div className="flex shrink-0 flex-col">
      <div
        className="group flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-faint transition-colors hover:bg-surface-hover hover:text-text-secondary"
        onContextMenu={menu.open}
      >
        <button
          type="button"
          onClick={() => setTreeOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left transition-colors hover:text-text-secondary"
        >
          {treeOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
          <SourceIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="truncate">{source.label}</span>
        </button>
        <button
          type="button"
          onClick={menu.open}
          title={t('layout.codeIde.moreActions')}
          aria-label={t('layout.codeIde.moreActions')}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-faint opacity-0 transition-opacity hover:bg-surface-6 hover:text-text-primary group-hover:opacity-100"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      {treeOpen && (
        <div className="px-1">
          <FileTree
            sourceId={source.id}
            sourceRoot={source.path!}
            onOpenFile={(relPath, name) => {
              openTab(source.id, relPath, name);
              navigate('/sources');
            }}
            activeRelPath={active && active.sourceId === source.id ? active.relPath : null}
            isGithub={source.kind === 'github_repo'}
          />
        </div>
      )}
      {menu.state && (
        <ContextMenu x={menu.state.x} y={menu.state.y} items={menuItems} onClose={menu.close} />
      )}
    </div>
  );
}
