import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  Code2,
  Eye,
  MessageSquare,
  Terminal as TerminalIcon,
  FolderGit2,
  GitBranch,
  Github,
  Plus,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { IdeChatDrawer } from '@renderer/components/code-ide/IdeChatDrawer';
import { SourceConfigDialog } from '@renderer/components/code-ide/SourceConfigDialog';
import { WorkspaceTree } from '@renderer/components/code-ide/WorkspaceTree';
import { useIdeChatStore } from '@renderer/stores/ideChatStore';
import { SourceCodeInner } from './SourceCodePage';
import { PreviewPanel } from '@renderer/components/code-ide/PreviewPanel';
import { TerminalPanel } from '@renderer/components/code-ide/TerminalPanel';
import { DockerWorkspace } from '@renderer/components/docker/DockerWorkspace';
import { usePreviewStore } from '@renderer/stores/previewStore';
import { useTerminalStore } from '@renderer/stores/terminalStore';
import { useTerminalOutputStore } from '@renderer/stores/terminalOutputStore';
import { useCodeTabsStore } from '@renderer/stores/codeTabsStore';
import { useCodeIdeStore } from '@renderer/stores/codeIdeStore';
import { useDevNavStore } from '@renderer/stores/devNavStore';
import { useDockerStore } from '@renderer/stores/dockerStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import {
  useUIStore,
  CODE_SIDEBAR_MIN_WIDTH,
  CODE_SIDEBAR_MAX_WIDTH,
  CODE_SIDEBAR_DEFAULT_WIDTH,
} from '@renderer/stores/uiStore';
import { toast } from '@renderer/stores/toastStore';
import { useT } from '@renderer/i18n';
import { Tooltip, TooltipTrigger, TooltipContent } from '@renderer/components/ui/tooltip';
import type { WorkspaceSource } from '@shared/types';
import { CodeChangesInner } from './CodeChangesPage';

const DOCKER_VIEW_TITLE: Record<string, string> = {
  containers: 'Containers',
  volumes: 'Volumes',
  images: 'Images',
  networks: 'Networks',
  activity: 'Activity Monitor',
};

/**
 * Workspace Dev unificado (rota /sources). O trilho 2 escolhe a seção (IDE/Git/Docker);
 * esta página renderiza no card: IDE = árvore (esquerda) + editor/preview + terminal;
 * Git = mudanças; Docker = gerenciador de containers. Source focado = source da aba ativa.
 */
export function WorkspaceIdePage() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const workspace = useWorkspaceStore((s) => s.active);
  const section = useDevNavStore((s) => s.section);
  const setSection = useDevNavStore((s) => s.setSection);
  const ideTab = useDevNavStore((s) => s.ideTab);
  const setIdeTab = useDevNavStore((s) => s.setIdeTab);
  const dockerView = useDockerStore((s) => s.view);
  const ideChatOpen = useIdeChatStore((s) => s.open);
  const terminalOpen = useCodeIdeStore((s) => s.terminalOpen);
  const toggleTerminal = useCodeIdeStore((s) => s.toggleTerminal);
  const active = useCodeTabsStore((s) => s.active);
  const codeSidebarWidth = useUIStore((s) => s.codeSidebarWidth);
  const setCodeSidebarWidth = useUIStore((s) => s.setCodeSidebarWidth);

  const sourcesQuery = useQuery({
    queryKey: ['sources', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: () => window.orkestral['source:list']({ workspaceId: workspace!.id }),
  });
  const localSources = (sourcesQuery.data ?? []).filter((s) => !!s.path) as WorkspaceSource[];
  const primary = localSources.find((s) => s.isPrimary) ?? localSources[0];

  // Source focado: override do seletor de repo ("Current repository") > source da
  // aba ativa > primária / primeira com path. O override é o que faz o seletor de
  // repositório TROCAR de fato dentro do dev workspace (antes era um no-op).
  const [repoOverride, setRepoOverride] = useState<string | null>(null);
  const focusedSourceId =
    (repoOverride && localSources.some((s) => s.id === repoOverride) ? repoOverride : null) ??
    (active && localSources.some((s) => s.id === active.sourceId) ? active.sourceId : null) ??
    primary?.id ??
    null;
  const focusedSource = localSources.find((s) => s.id === focusedSourceId);
  // Mudar de source pela aba ativa limpa o override (evita o seletor ficar preso).
  useEffect(() => {
    setRepoOverride(null);
  }, [active?.sourceId]);

  // Refs pra ler estado atual dentro dos listeners (deps []).
  const focusedIdRef = useRef(focusedSourceId);
  const previewActiveRef = useRef(section === 'ide' && ideTab === 'preview');
  useEffect(() => {
    focusedIdRef.current = focusedSourceId;
    previewActiveRef.current = section === 'ide' && ideTab === 'preview';
  }, [focusedSourceId, section, ideTab]);

  const openPreview = (): void => {
    setSection('ide');
    setIdeTab('preview');
  };

  // Auto-detect: URL de dev server num terminal → alimenta o Preview do source dono
  // + toast oferecendo abrir (se o terminal é do source focado e não estamos no Preview).
  useEffect(() => {
    return window.orkestralEvents.onTerminalUrlDetected(({ id, url }) => {
      const term = useTerminalStore.getState().terminals.find((tm) => tm.id === id);
      if (!term) return;
      usePreviewStore.getState().setDetected(term.sourceId, url);
      if (term.sourceId === focusedIdRef.current && !previewActiveRef.current) {
        toast.info(t('layout.codeIde.preview.detectedTitle'), url, {
          key: 'preview-available',
          action: { label: t('layout.codeIde.preview.detectedAction'), onClick: openPreview },
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  // Always-on: captura output de todos os terminais no ring buffer (contexto pro chat).
  useEffect(() => {
    const unsubData = window.orkestralEvents.onTerminalData(({ id, data }) => {
      useTerminalOutputStore.getState().append(id, data);
    });
    const unsubExit = window.orkestralEvents.onTerminalExit(({ id }) => {
      useTerminalOutputStore.getState().clear(id);
    });
    return () => {
      unsubData();
      unsubExit();
    };
  }, []);

  // Clique num link localhost no terminal do source focado → abre no Preview.
  useEffect(() => {
    return usePreviewStore.subscribe((state, prev) => {
      const req = state.openRequest;
      if (req && req !== prev.openRequest && req.sourceId === focusedIdRef.current) {
        state.setManual(req.sourceId, req.url);
        openPreview();
        state.clearOpenRequest();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Git do source focado (badge + gate).
  const isRepoQuery = useQuery({
    queryKey: ['git-is-repo', focusedSource?.id],
    enabled: focusedSource?.kind === 'local_folder' && !!focusedSource?.path,
    queryFn: () => window.orkestral['git:is-repo']({ sourceId: focusedSource!.id }),
  });
  const canGit =
    !!focusedSource?.path &&
    (focusedSource?.kind === 'github_repo' || isRepoQuery.data?.isRepo === true);

  const showLoader = sourcesQuery.isPending && section !== 'docker';
  const noSource = !focusedSource && section !== 'docker';

  return (
    <Shell>
      {/* Header do card — contextual por seção. */}
      <div className="window-drag border-b border-hairline-soft">
        <div className="flex items-center justify-between gap-3 px-5 py-3">
          <div className="window-no-drag flex min-w-0 items-center gap-2">
            {section === 'ide' && (
              <div className="flex items-center gap-0.5 rounded-full border border-hairline-strong bg-surface-faint p-0.5">
                {(
                  [
                    { key: 'code', label: t('workspace.sourceDetail.tabCode'), Icon: Code2 },
                    { key: 'preview', label: t('workspace.sourceDetail.tabPreview'), Icon: Eye },
                  ] as const
                ).map(({ key, label: lbl, Icon: TabIcon }) => (
                  <Tooltip key={key}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setIdeTab(key)}
                        aria-label={lbl}
                        className={cn(
                          'inline-flex h-7 items-center gap-1.5 rounded-full text-[12px] transition-colors',
                          ideTab === key
                            ? 'bg-surface-active px-3 text-text-primary'
                            : 'px-2 text-text-muted hover:text-text-secondary',
                        )}
                      >
                        <TabIcon className="h-3.5 w-3.5 shrink-0" />
                        {ideTab === key && <span>{lbl}</span>}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {lbl}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}
            {section === 'git' && (
              <h1 className="text-[15px] font-semibold tracking-tight text-text-primary">
                {t('workspace.sourceDetail.tabGit')}
              </h1>
            )}
            {section === 'docker' && (
              <h1 className="text-[15px] font-semibold tracking-tight text-text-primary">
                {DOCKER_VIEW_TITLE[dockerView] ?? 'Docker'}
              </h1>
            )}
          </div>

          {section === 'ide' && (
            <div className="window-no-drag flex shrink-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleTerminal}
                    aria-label={t('layout.codeIde.terminal')}
                    className={cn(
                      'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] transition-colors',
                      terminalOpen
                        ? 'border-hairline-mega bg-surface-active text-text-primary'
                        : 'border-hairline-strong bg-surface-faint text-text-secondary hover:bg-surface-active hover:text-text-primary',
                    )}
                  >
                    <TerminalIcon className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {t('layout.codeIde.terminal')}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>

      {/* Conteúdo */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {showLoader ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('workspace.sourceDetail.loading')}
          </div>
        ) : section === 'docker' ? (
          <DockerWorkspace />
        ) : noSource ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-text-muted">
            <FolderGit2 className="h-8 w-8 opacity-50" />
            <p className="text-[13px]">{t('layout.codeIde.noLocalPath')}</p>
            <button
              type="button"
              onClick={() => useUIStore.getState().openAddSource()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-faint px-3 text-[12px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('layout.sidebar.addSource')}
            </button>
          </div>
        ) : section === 'git' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {canGit && focusedSource ? (
              <CodeChangesInner
                source={focusedSource}
                allSources={localSources}
                onSourceChange={(id) => setRepoOverride(id)}
                queryClient={queryClient}
              />
            ) : focusedSource ? (
              <GitNoRepo sourceId={focusedSource.id} />
            ) : null}
          </div>
        ) : (
          // IDE: árvore (esquerda) + editor/preview (direita) + terminal (rodapé).
          focusedSource && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1">
                <aside
                  className="flex shrink-0 flex-col border-r border-border"
                  style={{ width: codeSidebarWidth }}
                >
                  {workspace && <WorkspaceTree workspaceId={workspace.id} />}
                </aside>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-valuemin={CODE_SIDEBAR_MIN_WIDTH}
                  aria-valuemax={CODE_SIDEBAR_MAX_WIDTH}
                  aria-valuenow={codeSidebarWidth}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const startX = e.clientX;
                    const startW = codeSidebarWidth;
                    const onMove = (ev: MouseEvent) =>
                      setCodeSidebarWidth(startW + (ev.clientX - startX));
                    const onUp = () => {
                      window.removeEventListener('mousemove', onMove);
                      window.removeEventListener('mouseup', onUp);
                      document.body.style.cursor = '';
                      document.body.style.userSelect = '';
                    };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                  }}
                  onDoubleClick={() => setCodeSidebarWidth(CODE_SIDEBAR_DEFAULT_WIDTH)}
                  className="group relative z-10 -ml-0.5 w-1 shrink-0 cursor-col-resize"
                >
                  <span className="absolute inset-y-0 left-0 w-[2px] bg-transparent transition-colors group-hover:bg-accent/50" />
                </div>
                {/* Editor + Preview hidden-mounted (preserva webview/scroll/terminal vivos). */}
                <div className="flex min-w-0 flex-1 flex-col">
                  <div
                    className={cn('flex min-h-0 flex-1 flex-col', ideTab !== 'code' && 'hidden')}
                  >
                    <SourceCodeInner
                      focusedSourceId={focusedSource.id}
                      focusedSourceRoot={focusedSource.path!}
                    />
                  </div>
                  <div className={cn('flex min-h-0 flex-1', ideTab !== 'preview' && 'hidden')}>
                    <PreviewPanel
                      sourceId={focusedSource.id}
                      sourceRoot={focusedSource.path ?? undefined}
                    />
                  </div>
                </div>
              </div>

              {/* Terminal — painel inferior (montado/hidden pra não dar blank ao alternar). */}
              <div
                className={cn(
                  'h-64 shrink-0 border-t border-border bg-background',
                  !terminalOpen && 'hidden',
                )}
              >
                <TerminalPanel sourceId={focusedSource.id} cwd={focusedSource.path!} />
              </div>
            </div>
          )
        )}

        {/* FAB do chat — só nas seções com source (IDE/Git). */}
        {section !== 'docker' && focusedSource && (
          <button
            type="button"
            onClick={() => useIdeChatStore.getState().toggleDrawer()}
            aria-label={t('layout.codeIde.ideChat.toggle')}
            title={t('layout.codeIde.ideChat.toggle')}
            className={cn(
              'absolute bottom-4 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-gradient-to-br from-accent-purple to-accent text-white shadow-[0_8px_24px_rgba(124,92,255,0.35)] transition-transform hover:scale-105 active:scale-95',
              ideChatOpen && 'ring-2 ring-accent-purple/40',
            )}
          >
            <MessageSquare className="h-5 w-5" />
          </button>
        )}
        <IdeChatDrawer />
      </div>

      <SourceConfigDialog />
    </Shell>
  );
}

/**
 * Estado da aba Git quando a source NÃO é um repositório git. Em vez de só "não dá",
 * oferece criar o repo (git init → o Code Changes passa a funcionar) ou conectar ao
 * GitHub por integração (abre o fluxo de Adicionar source).
 */
function GitNoRepo({ sourceId }: { sourceId: string }) {
  const { t } = useT();
  const qc = useQueryClient();
  const initMut = useMutation({
    mutationFn: () => window.orkestral['git:init']({ sourceId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['git-is-repo'] });
      qc.invalidateQueries({ queryKey: ['git-status'] });
      toast.success(t('layout.codeIde.gitInitDone'));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <GitBranch className="h-8 w-8 text-text-faint" />
      <div>
        <p className="text-[14px] font-medium text-text-primary">
          {t('layout.codeIde.notAGitRepoTitle')}
        </p>
        <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-text-muted">
          {t('layout.codeIde.notAGitRepoHint')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={initMut.isPending}
          onClick={() => initMut.mutate()}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-4 text-[12.5px] font-medium text-black transition-colors hover:bg-white/90 disabled:opacity-50"
        >
          {initMut.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitBranch className="h-3.5 w-3.5" />
          )}
          {t('layout.codeIde.createRepo')}
        </button>
        <button
          type="button"
          onClick={() => useUIStore.getState().openAddSource()}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-faint px-4 text-[12.5px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
        >
          <Github className="h-3.5 w-3.5" />
          {t('layout.codeIde.connectGithub')}
        </button>
      </div>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col pb-4 pl-2 pr-4 pt-4">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {children}
      </div>
    </div>
  );
}
