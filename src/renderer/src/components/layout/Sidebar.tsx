import {
  MessageSquarePlus,
  Search,
  Inbox,
  CircleDot,
  Repeat,
  Target,
  GitPullRequestArrow,
  FolderGit2,
  Github,
  ChevronRight,
  ChevronDown,
  Brain,
  Plus,
  Bot,
  Wand2,
  Cog,
  MessageSquare,
  Server,
  Boxes,
  Container,
  Code2,
  GitBranch,
  HardDrive,
  Layers,
  Network,
  Activity,
  Plug2,
  MessageCircle,
  SquareTerminal,
  FileText,
  Sparkles,
  MoreHorizontal,
  Trash2,
  PenLine,
  PanelLeftClose,
  X,
  Minus,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { ChannelIcon } from '@renderer/components/chat/ChannelIcon';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Archive } from 'lucide-react';
import {
  useContextMenu,
  ContextMenu,
  type ContextMenuItem,
} from '@renderer/components/ui/context-menu';
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { SidebarItem } from './SidebarItem';
import { UserCard } from './UserCard';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useUIStore } from '@renderer/stores/uiStore';
import { useSessionReadStore } from '@renderer/stores/sessionReadStore';
import { useChatStore } from '@renderer/stores/chatStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useDockerStore, type DockerView } from '@renderer/stores/dockerStore';
import { useDevNavStore, type DevSection } from '@renderer/stores/devNavStore';
import { renderTitleMentions, type MentionAgent } from '@renderer/components/chat/mentions';
import { SentryIcon } from '@renderer/components/brand-icons';
import { useSentryViewStore } from '@renderer/stores/sentryViewStore';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import type { LucideIcon } from 'lucide-react';
import { useAgentWorking, useAgentTask } from '@renderer/stores/agentStatusStore';
import { BRANDING } from '@shared/branding';
import { planNeedsApproval } from '@shared/plan';
import { useInboxDismissStore } from '@renderer/stores/inboxDismissStore';
import { useIssueReadStore } from '@renderer/stores/issueReadStore';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';
import { notifyInboxTask, notifyIssueDone } from '@renderer/lib/notify';
import type { WorkspaceSource } from '@shared/types';
import logoIcon from '@renderer/assets/logo_icon.png';

// A sidebar é só atalho: mostra os N chats mais recentes. O histórico completo
// + filtros vive no botão "conversas anteriores" no topo do chat.
const MAX_RECENT_SESSIONS = 5;
const RAIL2_WIDTH = 248;

// ── Navegação de DOIS TRILHOS ────────────────────────────────────────────────
// Trilho 1 = barra fina de ícones (6 grupos). Trilho 2 = painel contextual com os
// itens do grupo ativo. O grupo ativo deriva da ROTA atual (acende o ícone) e é
// clicável (troca o painel sem navegar). Reusa 100% dos componentes de conteúdo.
type NavGroupId = 'chat' | 'work' | 'sources' | 'knowledge' | 'agents' | 'resources';
interface NavGroupDef {
  id: NavGroupId;
  icon: LucideIcon;
  labelKey: string;
  /** Rotas que pertencem ao grupo (acende o ícone). 'chat' é o default/fallback. */
  match?: RegExp;
  /** Rota que o ÍCONE abre ao clicar (além de trocar o painel). Ex: Conhecimento
   *  → /knowledge (diagrama dos planetas). Sem `to`, o ícone só troca o painel. */
  to?: string;
}
const NAV_GROUPS: NavGroupDef[] = [
  { id: 'chat', icon: MessageSquare, labelKey: 'layout.section.chat' },
  {
    id: 'work',
    icon: CircleDot,
    labelKey: 'layout.section.work',
    match: /^\/(issues|routines|goals|code-reviews)/,
  },
  // Fontes (repos/pastas) e Base de conhecimento são ÍCONES SEPARADOS no trilho 1.
  {
    id: 'sources',
    icon: FolderGit2,
    labelKey: 'layout.section.sources',
    match: /^\/sources/,
    // Clicar no ícone abre a IDE unificada do workspace (árvore = trilho 2).
    to: '/sources',
  },
  {
    id: 'knowledge',
    icon: Brain,
    labelKey: 'layout.section.knowledge',
    match: /^\/knowledge/,
    // Clicar no ícone abre direto o diagrama dos planetas (KnowledgeGraphPage).
    to: '/knowledge',
  },
  { id: 'agents', icon: Bot, labelKey: 'layout.section.agents', match: /^\/agents/ },
  {
    id: 'resources',
    icon: Wand2,
    labelKey: 'layout.section.resources',
    match: /^\/(company\/skills|mcps|providers|integrations|channels|sentry)/,
  },
];
function groupForPath(pathname: string): NavGroupId | null {
  for (const g of NAV_GROUPS) if (g.match?.test(pathname)) return g.id;
  // Rotas de chat acendem o grupo Chat; rotas utilitárias (/logs, /inbox, settings)
  // retornam null → mantêm o painel/grupo atual (não puxam pro chat).
  if (pathname === '/' || pathname.startsWith('/session')) return 'chat';
  return null;
}

/**
 * Botão de GRUPO do trilho 1 (ícone 40×40, radius 11). Ativo = gradiente roxo +
 * barra indicadora à esquerda; hover = fundo sutil + tooltip à direita; badge de
 * contagem no canto. Acessível (aria-current, aria-label, foco por teclado).
 */
function NavRailButton({
  icon: Icon,
  label,
  active,
  badge,
  dot,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  badge?: number;
  /** Indicador simples (sem número) — ex: Fontes com mudanças git não-commitadas. */
  dot?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'group relative grid h-10 w-10 place-items-center rounded-[11px] transition-colors',
            active
              ? 'text-white'
              : 'text-text-secondary hover:bg-surface-1 hover:text-text-primary',
          )}
          style={active ? { background: 'linear-gradient(160deg, #7c6cf0, #5a48d6)' } : undefined}
        >
          {active && (
            <span className="absolute -left-[14px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent-purple" />
          )}
          <Icon className="h-[18px] w-[18px]" />
          {badge != null && badge > 0 && (
            <span className="absolute -right-1 -top-1 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-white ring-2 ring-sidebar">
              {badge > 99 ? '99+' : badge}
            </span>
          )}
          {/* Bolinha (sem número) — só quando não há badge numérico no mesmo botão. */}
          {dot && (badge == null || badge === 0) && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-sidebar" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Controles de janela CUSTOM (os traffic lights nativos do macOS são escondidos no
 * main). SUTIL: 3 pontinhos cinza por padrão; ao passar o mouse na fileira eles ganham
 * a cor (fechar/min/max) e o símbolo aparece no ponto sob o cursor. Janela arrastável
 * segue nas regiões window-drag em volta.
 */
function WindowControls() {
  const dot =
    'window-no-drag group/wc grid h-[10px] w-[10px] place-items-center rounded-full transition-colors';
  const sym = 'h-[7px] w-[7px] text-black/0 transition-colors group-hover/wc:text-black/55';
  return (
    <div className="window-no-drag group/wctrl flex items-center gap-[5px]">
      <button
        type="button"
        aria-label="Fechar"
        onClick={() => void window.orkestral['window:close']()}
        className={cn(dot, 'bg-white/[0.14] group-hover/wctrl:bg-[#ff5f57] hover:!bg-[#ff5f57]')}
      >
        <X className={sym} strokeWidth={3} />
      </button>
      <button
        type="button"
        aria-label="Minimizar"
        onClick={() => void window.orkestral['window:minimize']()}
        className={cn(dot, 'bg-white/[0.14] group-hover/wctrl:bg-[#febc2e] hover:!bg-[#febc2e]')}
      >
        <Minus className={sym} strokeWidth={3} />
      </button>
      <button
        type="button"
        aria-label="Maximizar"
        onClick={() => void window.orkestral['window:toggle-maximize']()}
        className={cn(dot, 'bg-white/[0.14] group-hover/wctrl:bg-[#28c840] hover:!bg-[#28c840]')}
      >
        <Plus className={sym} strokeWidth={3} />
      </button>
    </div>
  );
}

export function Sidebar() {
  const { t } = useT();
  const openSettings = useUIStore((s) => s.openSettings);
  const openNewAgent = useUIStore((s) => s.openNewAgent);
  const openCommandPalette = useUIStore((s) => s.openCommandPalette);
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const enterWorkspaceSelection = useWorkspaceStore((s) => s.enterWorkspaceSelection);
  const navigate = useNavigate();
  const location = useLocation();
  // Grupo ativo do trilho 1: deriva da ROTA (acende o ícone) e é clicável — clicar num
  // grupo troca o painel do trilho 2 sem navegar; clicar num ITEM navega normal.
  const [activeGroup, setActiveGroup] = useState<NavGroupId>(
    () => groupForPath(location.pathname) ?? 'chat',
  );
  useEffect(() => {
    const g = groupForPath(location.pathname);
    if (g) setActiveGroup(g);
  }, [location.pathname]);
  const onGroupClick = (id: NavGroupId) => {
    const group = NAV_GROUPS.find((g) => g.id === id);
    const isActiveOpen = id === activeGroup && !collapsed;
    // Grupo ATIVO já aberto recolhe o trilho 2 — exceto quando ele tem rota própria
    // (`to`) e ainda não estamos nela: aí o ícone NAVEGA pra essa rota em vez de
    // recolher (ex: clicar em Conhecimento abre o diagrama dos planetas /knowledge).
    if (isActiveOpen && (!group?.to || location.pathname === group.to)) {
      setSidebarCollapsed(true);
    } else {
      setActiveGroup(id);
      if (collapsed) setSidebarCollapsed(false);
      if (group?.to) navigate(group.to);
    }
  };
  const queryClient = useQueryClient();

  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: () => window.orkestral['user:get'](),
  });

  const onboardingQuery = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => window.orkestral['onboarding:get'](),
  });

  // Agentes do workspace ativo — usado na seção "Agentes"
  const agentsQuery = useQuery({
    queryKey: ['agents', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: activeWorkspace!.id }),
  });
  const agents = agentsQuery.data ?? [];

  // Histórico de chats — ordenado pela query (mais recentes primeiro)
  const sessionsQuery = useQuery({
    queryKey: ['sessions', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['session:list']({ workspaceId: activeWorkspace!.id }),
  });
  const sessions = sessionsQuery.data ?? [];

  // Badge do grupo Trabalho = issues abertas NÃO-LIDAS (mesmo cálculo do item Issues;
  // mesmo query key → cache compartilhado, sem fetch duplicado).
  const countUnread = useIssueReadStore((s) => s.countUnread);
  const issuesQuery = useQuery({
    queryKey: ['issues', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['issue:list']({ workspaceId: activeWorkspace!.id }),
    refetchInterval: 30_000,
  });
  const workBadge = countUnread(
    (issuesQuery.data ?? [])
      .filter((i) => i.status !== 'done' && i.status !== 'cancelled')
      .map((i) => ({ id: i.id, updatedAt: i.updatedAt })),
  );

  // Bolinha no ícone Fontes (trilho 1) quando QUALQUER source tem mudanças git
  // não-commitadas. Polla o git status de todas as sources (cache compartilhado
  // com as linhas de source).
  const sourcesQuery = useQuery({
    queryKey: ['sources', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['source:list']({ workspaceId: activeWorkspace!.id }),
  });
  const sourcesHaveChanges =
    useSourcesPendingTotal((sourcesQuery.data ?? []) as WorkspaceSource[]) > 0;

  const userName = userQuery.data?.name ?? t('layout.user.fallbackName');
  const userEmail = userQuery.data?.email ?? undefined;
  const plan = onboardingQuery.data?.plan
    ? onboardingQuery.data.plan.charAt(0).toUpperCase() + onboardingQuery.data.plan.slice(1)
    : 'Free';

  const logoutMutation = useMutation({
    mutationFn: () => window.orkestral['app:logout'](),
    onSuccess: () => {
      enterWorkspaceSelection();
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      queryClient.invalidateQueries({ queryKey: ['user'] });
      window.location.hash = '#/';
    },
  });

  const activeGroupLabel =
    NAV_GROUPS.find((g) => g.id === activeGroup)?.labelKey ?? 'layout.section.chat';

  // Itens do TRILHO 2 conforme o grupo ativo — reusa os MESMOS componentes de antes.
  const renderGroupItems = (): ReactNode => {
    switch (activeGroup) {
      case 'chat':
        return (
          <>
            {/* Novo chat — botão inteiro, menor, com gradiente roxo SUAVE.
                Buscar e Inbox ficam como ícones no header do painel. */}
            <SidebarPrimaryAction
              icon={MessageSquarePlus}
              label={t('layout.nav.newChat')}
              shortcut="⌘N"
              onClick={() => navigate('/')}
            />
            {/* Recentes renderizados direto (sem menu colapsável). */}
            {sessions.length > 0 && (
              <>
                <div className="px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-text-faint">
                  {t('layout.sidebar.recents')}
                </div>
                <RecentSessions sessions={sessions.slice(0, MAX_RECENT_SESSIONS)} />
              </>
            )}
          </>
        );
      case 'work':
        return (
          <>
            {activeWorkspace ? (
              <SidebarIssuesItem workspaceId={activeWorkspace.id} />
            ) : (
              <SidebarItem to="/issues" icon={CircleDot} label={t('layout.nav.issues')} />
            )}
            <SidebarItem to="/routines" icon={Repeat} label={t('layout.nav.routines')} />
            <SidebarItem to="/goals" icon={Target} label={t('layout.nav.goals')} />
            <SidebarItem
              to="/code-reviews"
              icon={GitPullRequestArrow}
              label={t('layout.nav.codeReviews')}
            />
          </>
        );
      case 'sources':
        return <SidebarDevSection />;
      case 'knowledge':
        return activeWorkspace ? (
          <SidebarKbSection workspaceId={activeWorkspace.id} />
        ) : (
          <SidebarItem to="/knowledge" icon={Brain} label={t('layout.nav.knowledgeBase')} />
        );
      case 'agents':
        return <SidebarAgentsSection agents={agents} onNewAgent={openNewAgent} collapsed={false} />;
      case 'resources':
        return (
          <>
            <SidebarItem to="/company/skills" icon={Wand2} label={t('layout.nav.skills')} />
            <SidebarItem to="/mcps" icon={Server} label={t('layout.nav.mcps')} />
            <SidebarItem to="/providers" icon={Boxes} label={t('layout.nav.providers')} />
            <SidebarItem to="/channels" icon={MessageCircle} label={t('layout.nav.channels')} />
            <SidebarIntegrationsNav />
          </>
        );
    }
  };

  return (
    <aside className="window-drag relative flex h-full shrink-0 bg-sidebar">
      {/* ───────── TRILHO 1 — barra fina de ícones (~60px) ───────── */}
      <div className="window-no-drag flex w-[60px] shrink-0 flex-col items-center pt-2">
        {/* Controles de janela custom (no lugar dos traffic lights nativos). A área é
            window-drag (arrasta a janela); só os botões são clicáveis. */}
        <div className="window-drag flex h-7 w-full shrink-0 items-center pl-3">
          <WindowControls />
        </div>
        {/* Logo (gem) — vai pro chat ao clicar */}
        <button
          type="button"
          onClick={() => navigate('/')}
          aria-label={BRANDING.appName}
          className="mt-2 mb-1 grid h-10 w-10 place-items-center rounded-xl"
        >
          <img src={logoIcon} alt={BRANDING.appName} className="h-7 w-7 opacity-95" />
        </button>
        {/* 6 grupos */}
        <nav className="mt-4 flex flex-1 flex-col items-center gap-3">
          {NAV_GROUPS.map((g) => (
            <NavRailButton
              key={g.id}
              icon={g.icon}
              label={t(g.labelKey)}
              active={activeGroup === g.id}
              // Badge SÓ pra não-lidos / ações novas (não contagem total). Trabalho =
              // issues abertas não-lidas (número). Fontes = bolinha quando há mudanças
              // git não-commitadas. Agentes/etc. não notificam (é só navegação).
              badge={g.id === 'work' ? workBadge : undefined}
              dot={g.id === 'sources' ? sourcesHaveChanges : undefined}
              onClick={() => onGroupClick(g.id)}
            />
          ))}
        </nav>
        {/* Rodapé: Logs + Configurações + avatar. Logs abre direto (sem painel). */}
        <div className="mt-2 flex flex-col items-center gap-1.5 pb-3">
          {/* Logs — botão IDÊNTICO ao de Configurações (mesma geometria/hover); só
              navega pra /logs ao clicar. Plain <button> evita a diferença de hover
              que o NavLink (<a>) trazia. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => navigate('/logs')}
                aria-label={t('layout.nav.logs')}
                className="grid h-9 w-9 place-items-center rounded-[11px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
              >
                <SquareTerminal className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={10}>
              {t('layout.nav.logs')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => openSettings()}
                aria-label={t('layout.nav.settings')}
                className="grid h-9 w-9 place-items-center rounded-[11px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
              >
                <Cog className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={10}>
              {t('layout.nav.settings')}
            </TooltipContent>
          </Tooltip>
          <UserCard
            name={userName}
            plan={plan}
            email={userEmail}
            onOpenSettings={openSettings}
            onLogout={() => {
              if (!logoutMutation.isPending) logoutMutation.mutate();
            }}
            avatarOnly
          />
        </div>
      </div>

      {/* ─────── TRILHO 2 — sidebar contextual (~248px); abre/fecha com slide ─────── */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="rail2"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: RAIL2_WIDTH, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="h-full shrink-0 overflow-hidden border-l border-hairline-soft"
          >
            {/* Largura FIXA por dentro: o conteúdo NÃO espreme durante o slide — só é
                clipado pelo overflow-hidden do wrapper animado (revela da esquerda). */}
            <div style={{ width: RAIL2_WIDTH }} className="flex h-full flex-col">
              {/* Header: nome do grupo + Buscar/Inbox (ícones ao lado do título, em
                  TODOS os grupos); o recolher fica sozinho no final. */}
              <div className="window-drag flex h-[52px] shrink-0 items-center justify-between px-4 pt-2">
                <div className="window-no-drag flex min-w-0 items-center gap-1">
                  <span className="truncate text-[14.5px] font-semibold text-text-primary">
                    {t(activeGroupLabel)}
                  </span>
                  <SidebarIconButton
                    icon={Search}
                    label={t('layout.nav.search')}
                    shortcut="⌘K"
                    onClick={openCommandPalette}
                    size="sm"
                  />
                  {activeWorkspace && (
                    <SidebarInboxItem workspaceId={activeWorkspace.id} variant="icon" size="sm" />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => toggleSidebar()}
                  aria-label={t('layout.sidebar.collapse')}
                  className="window-no-drag grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-1 hover:text-text-primary"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
              </div>
              {/* Workspace switcher + divider que separa do menu */}
              <div className="window-no-drag pb-2">
                <WorkspaceSwitcher />
              </div>
              <div className="mx-3 border-t border-hairline-faint" />
              {/* Conteúdo do grupo — fade + slide curto na troca */}
              <div className="window-no-drag relative min-h-0 flex-1">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.nav
                    key={activeGroup}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 6 }}
                    transition={{ duration: 0.16, ease: 'easeOut' }}
                    className="flex h-full flex-col overflow-y-auto overflow-x-hidden px-3 pb-4 pt-3"
                  >
                    {renderGroupItems()}
                  </motion.nav>
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}

/**
 * Recentes — seção colapsável (mesmo padrão de Sources). Mostra os
 * chats mais recentes do workspace e navega pra sessão ao clicar.
 */
/**
 * Nav da seção Dev (trilho 2): IDE / Git / Docker. Docker expande os sub-views
 * (Containers/Volumes/…) aninhados. Tudo navega pra /sources; a página renderiza
 * conforme devNavStore.section (+ dockerStore.view).
 */
function SidebarDevSection(): ReactNode {
  const section = useDevNavStore((s) => s.section);
  const setSection = useDevNavStore((s) => s.setSection);
  const dockerView = useDockerStore((s) => s.view);
  const setDockerView = useDockerStore((s) => s.setView);
  const navigate = useNavigate();
  const { t } = useT();

  // Docker: grupo colapsável com estado persistido (estilo KB/sidebar). Default
  // aberto (preserva o "dropdown fixo" anterior); a última escolha do usuário
  // (expandir/contrair) sobrevive a reload via localStorage.
  const DOCKER_EXPANDED_KEY = 'orkestral.sidebar.docker.expanded';
  const [dockerExpanded, setDockerExpandedRaw] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(DOCKER_EXPANDED_KEY);
      return raw === null ? true : raw === 'true';
    } catch {
      return true;
    }
  });
  const setDockerExpanded = (v: boolean): void => {
    setDockerExpandedRaw(v);
    try {
      localStorage.setItem(DOCKER_EXPANDED_KEY, String(v));
    } catch {
      /* ignore */
    }
  };

  const go = (s: DevSection): void => {
    setSection(s);
    navigate('/sources');
  };

  const topItem = (s: DevSection, Icon: LucideIcon, label: string): ReactNode => (
    <button
      key={s}
      type="button"
      onClick={() => go(s)}
      className={cn(
        'flex h-7 w-full items-center gap-2 truncate rounded-md px-2 text-left text-[12.5px] transition-colors',
        section === s
          ? 'bg-surface-active text-text-primary'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />
      <span className="truncate">{label}</span>
    </button>
  );

  const dockerItem = (v: DockerView, Icon: LucideIcon, label: string): ReactNode => (
    <button
      key={v}
      type="button"
      onClick={() => {
        setDockerView(v);
        go('docker');
      }}
      className={cn(
        'flex h-7 w-full items-center gap-2 truncate rounded-md py-1 pl-8 pr-2 text-left text-[12px] transition-colors',
        section === 'docker' && dockerView === v
          ? 'bg-surface-active text-text-primary'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <div className="flex flex-col gap-0.5">
      {topItem('ide', Code2, 'IDE')}
      {topItem('git', GitBranch, 'Git')}

      {/* Docker: cabeçalho navegável + chevron pra expandir/contrair os sub-views.
          Estado persistido (orkestral.sidebar.docker.expanded). */}
      <div
        className={cn(
          'flex h-7 w-full items-center gap-2 rounded-md px-2 text-[12.5px] transition-colors',
          section === 'docker'
            ? 'bg-surface-active text-text-primary'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
        )}
      >
        <button
          type="button"
          onClick={() => go('docker')}
          className="flex min-w-0 flex-1 items-center gap-2 truncate text-left"
        >
          <Container className="h-3.5 w-3.5 shrink-0 opacity-80" />
          <span className="truncate">Docker</span>
        </button>
        <button
          type="button"
          onClick={() => setDockerExpanded(!dockerExpanded)}
          title={dockerExpanded ? t('layout.sidebar.collapse') : t('layout.sidebar.expand')}
          aria-label={dockerExpanded ? t('layout.sidebar.collapse') : t('layout.sidebar.expand')}
          aria-expanded={dockerExpanded}
          className="grid h-4 w-4 shrink-0 place-items-center rounded text-text-faint transition-colors hover:text-text-primary"
        >
          {dockerExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {dockerExpanded && (
          <motion.div
            key="docker-subviews"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-0.5 flex flex-col gap-0.5">
              {dockerItem('containers', Boxes, 'Containers')}
              {dockerItem('volumes', HardDrive, 'Volumes')}
              {dockerItem('images', Layers, 'Images')}
              {dockerItem('networks', Network, 'Networks')}
              {dockerItem('activity', Activity, 'Activity Monitor')}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Botão de AÇÃO PRIMÁRIA do trilho 2 (largura toda) — gradiente roxo suave.
 * Usado por "Novo chat" e "Criar agente".
 */
function SidebarPrimaryAction({
  icon: Icon,
  label,
  shortcut,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2 rounded-lg border border-accent-purple/15 bg-gradient-to-br from-accent-purple/20 to-accent-purple/[0.06] px-2.5 py-1.5 text-[13px] font-medium text-text-primary transition-colors hover:border-accent-purple/25 hover:from-accent-purple/25 hover:to-accent-purple/10"
    >
      <Icon className="h-4 w-4 text-accent-purple" />
      <span className="flex-1 text-left">{label}</span>
      {shortcut && (
        <span className="font-mono text-[10px] text-text-faint group-hover:text-text-muted">
          {shortcut}
        </span>
      )}
    </button>
  );
}

/**
 * Botão de ÍCONE compacto do trilho 2 (36×36). Abre direto — ação (`onClick`) ou
 * navegação (`to`, acende quando ativo). Tooltip embaixo + opção de dot de badge.
 * Usado pelas ações secundárias do Chat (Buscar, Caixa de entrada).
 */
function SidebarIconButton({
  icon: Icon,
  label,
  shortcut,
  onClick,
  to,
  badgeDot,
  size = 'md',
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  onClick?: () => void;
  to?: string;
  badgeDot?: boolean;
  size?: 'sm' | 'md';
}) {
  const sm = size === 'sm';
  const cls = cn(
    'group relative grid shrink-0 place-items-center text-text-muted transition-colors hover:bg-surface-1 hover:text-text-primary',
    sm ? 'h-7 w-7 rounded-md' : 'h-9 w-9 rounded-lg',
  );
  const inner = (
    <>
      <Icon className={sm ? 'h-4 w-4' : 'h-[18px] w-[18px]'} />
      {badgeDot && (
        <span
          className={cn(
            'absolute h-2 w-2 rounded-full bg-accent ring-2 ring-sidebar',
            sm ? 'right-0.5 top-0.5' : 'right-1.5 top-1.5',
          )}
        />
      )}
    </>
  );
  const trigger = to ? (
    <NavLink
      to={to}
      aria-label={label}
      className={({ isActive }) => cn(cls, isActive && 'bg-surface-active text-text-primary')}
    >
      {inner}
    </NavLink>
  ) : (
    <button type="button" onClick={onClick} aria-label={label} className={cls}>
      {inner}
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <div className="flex items-center gap-2">
          <span>{label}</span>
          {shortcut && <span className="font-mono text-[10px] text-text-muted">{shortcut}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Lista as sessões de chat do workspace ativo. Até 5 ficam visíveis sem
 * scroll — se tiver mais, o container ganha scroll sutil (max-height
 * proporcional a ~5 itens).
 */
function RecentSessions({ sessions }: { sessions: ReadonlyArray<{ id: string; title: string }> }) {
  const { t } = useT();
  const unread = useSessionReadStore((s) => s.unread);
  // Sessões com run vivo agora → indicador "pensando" na lista. A chave-string só
  // muda quando uma sessão entra/sai do estado ativo (não a cada token), evitando
  // re-render no streaming.
  const thinkingKey = useChatStore((s) =>
    Object.keys(s.sessions)
      .filter((id) => s.sessions[id]?.streamingRunId)
      .sort()
      .join(','),
  );
  const thinkingIds = new Set(thinkingKey ? thinkingKey.split(',') : []);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const ctx = useContextMenu();
  const [targetId, setTargetId] = useState<string | null>(null);
  // Agentes do workspace pra renderizar `@<agente>` nos títulos como tag.
  const sessionWorkspaceId = useWorkspaceStore((s) => s.active?.id);
  const agents = useQuery({
    queryKey: ['agents', sessionWorkspaceId],
    enabled: !!sessionWorkspaceId,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: sessionWorkspaceId! }),
  }).data;
  const mentionAgents: MentionAgent[] = (agents ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    avatarSeed: a.avatarSeed,
  }));
  // Proveniência de canal por sessão → marca o item de recente com a logo (WhatsApp).
  const channelMeta = useQuery({
    queryKey: ['channel-session-meta', sessionWorkspaceId],
    enabled: !!sessionWorkspaceId,
    staleTime: 60_000,
    queryFn: () => window.orkestral['channels:session-meta']({ workspaceId: sessionWorkspaceId! }),
  }).data;
  const channelBySession = new Map(
    (channelMeta ?? []).map((m) => [m.chatSessionId, m.channelType]),
  );
  // Quando a lista de recentes muda (sessão nova chega, ex.: do WhatsApp), revalida
  // a proveniência pra o ícone do canal aparecer/persistir — sem isso a sessão nova
  // ficaria com o ícone genérico de chat.
  const sessionIdsSig = sessions.map((s) => s.id).join(',');
  useEffect(() => {
    if (sessionWorkspaceId) {
      void queryClient.invalidateQueries({
        queryKey: ['channel-session-meta', sessionWorkspaceId],
      });
    }
  }, [sessionIdsSig, sessionWorkspaceId, queryClient]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

  async function archiveSession(id: string) {
    await window.orkestral['session:archive']({ sessionId: id, archived: true });
    refresh();
  }
  async function deleteSession(id: string) {
    await window.orkestral['session:delete']({ sessionId: id });
    refresh();
    // Saiu da conversa aberta? Volta pra Home pra não ficar numa rota morta.
    if (location.pathname === `/session/${id}`) navigate('/');
  }

  const menuItems: ContextMenuItem[] = targetId
    ? [
        {
          label: t('layout.sidebar.archiveChat'),
          icon: <Archive className="h-3.5 w-3.5" />,
          onSelect: () => void archiveSession(targetId),
        },
        {
          label: t('layout.sidebar.deleteChat'),
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          onSelect: () => void deleteSession(targetId),
        },
      ]
    : [];

  return (
    <div
      className="thin-scrollbar flex max-h-[176px] flex-col overflow-y-auto"
      style={{ scrollbarGutter: 'stable' }}
    >
      {sessions.map((s) => {
        const isUnread = !!unread[s.id];
        const isThinking = thinkingIds.has(s.id);
        return (
          <NavLink
            key={s.id}
            to={`/session/${s.id}`}
            onContextMenu={(e) => {
              setTargetId(s.id);
              ctx.open(e);
            }}
            className={({ isActive }) =>
              cn(
                'group flex h-7 items-center gap-2 truncate rounded-md px-2 text-[12.5px] transition-colors',
                isActive
                  ? 'bg-surface-active text-text-primary'
                  : isUnread
                    ? 'text-text-primary hover:bg-surface-hover'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
              )
            }
            title={s.title}
          >
            {({ isActive }) => (
              <>
                {isThinking ? (
                  <span
                    className="relative grid h-3.5 w-3.5 shrink-0 place-items-center"
                    title={t('layout.sidebar.thinking')}
                  >
                    <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-accent-purple/50" />
                    <span className="relative h-1.5 w-1.5 rounded-full bg-accent-purple" />
                  </span>
                ) : isUnread && !isActive ? (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-purple"
                    title={t('layout.sidebar.newResponse')}
                  />
                ) : channelBySession.has(s.id) ? (
                  <ChannelIcon
                    channel={channelBySession.get(s.id)!}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                ) : (
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />
                )}
                <span className={cn('truncate', isUnread && 'font-medium')}>
                  {renderTitleMentions(s.title, mentionAgents)}
                </span>
              </>
            )}
          </NavLink>
        );
      })}
      {ctx.state && (
        <ContextMenu x={ctx.state.x} y={ctx.state.y} items={menuItems} onClose={ctx.close} />
      )}
    </div>
  );
}

/**
 * Soma das mudanças não-commitadas de TODAS as sources git de um workspace. Reusa o
 * MESMO cache (queryKey ['git-status', id]) das linhas de source — sem fetch extra.
 * Alimenta o indicador (bolinha) no ícone "Fontes" do trilho 1.
 */
function useSourcesPendingTotal(sources: WorkspaceSource[]): number {
  const results = useQueries({
    queries: sources.map((s) => ({
      queryKey: ['git-status', s.id],
      enabled: !!s.path,
      retry: false,
      refetchInterval: 20_000,
      queryFn: () => window.orkestral['git:status']({ sourceId: s.id }),
    })),
  });
  return results.reduce((sum, q) => sum + (q.data?.files.length ?? 0), 0);
}

/**
 * Base de conhecimento — seção colapsável que lista as páginas raiz da KB.
 * Mesmo padrão visual de Sources/Recentes.
 */
function SidebarKbSection({ workspaceId }: { workspaceId: string }) {
  const { t } = useT();
  const navigate = useNavigate();
  const treeQuery = useQuery({
    queryKey: ['kb-tree', workspaceId],
    queryFn: () => window.orkestral['kb:tree']({ workspaceId }),
    refetchInterval: 15_000,
  });
  const roots = treeQuery.data ?? [];

  const createPageMutation = useMutation({
    mutationFn: () =>
      window.orkestral['kb:create-page']({
        workspaceId,
        title: t('layout.sidebar.newPageTitle'),
        kind: 'doc',
      }),
    onSuccess: (page) => {
      treeQuery.refetch();
      navigate(`/knowledge/${page.id}`);
    },
  });

  // Sem menu principal — as páginas (filhos) são renderizadas direto. O ícone
  // "Base de conhecimento" no trilho 1 já abre o diagrama (/knowledge).
  return (
    <div>
      {roots.slice(0, 10).map((page) => (
        <KbSidebarPageRow
          key={page.id}
          page={page}
          workspaceId={workspaceId}
          onAnyChange={() => treeQuery.refetch()}
        />
      ))}
      {roots.length > 10 && (
        <NavLink
          to="/knowledge"
          className="group flex h-7 items-center gap-2 truncate rounded-md px-2 text-[12.5px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <span className="truncate">{t('layout.sidebar.viewAll', { n: roots.length })}</span>
        </NavLink>
      )}
      <button
        type="button"
        onClick={() => createPageMutation.mutate()}
        disabled={createPageMutation.isPending}
        className="group flex h-7 w-full items-center gap-2 truncate rounded-md px-2 text-left text-[12.5px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="truncate">{t('layout.sidebar.newPage')}</span>
      </button>
    </div>
  );
}

/**
 * Item Issues com badge de não-lidas. Usa `useIssueReadStore` (localStorage)
 * pra rastrear última visita por issue; conta as que têm `updatedAt` mais
 * recente que a visita.
 */
function SidebarIssuesItem({ workspaceId }: { workspaceId: string }) {
  const { t } = useT();
  const issuesQuery = useQuery({
    queryKey: ['issues', workspaceId],
    queryFn: () => window.orkestral['issue:list']({ workspaceId }),
    refetchInterval: 30_000,
  });
  const countUnread = useIssueReadStore((s) => s.countUnread);
  const issues = issuesQuery.data ?? [];
  // Badge = issues ABERTAS não-lidas (nunca abertas OU alteradas depois da última
  // visita), via issueReadStore. Issues terminais (done/cancelled) NÃO contam —
  // senão, quando os agentes terminam tudo, sobra um badge "fantasma" de algo já
  // concluído (era a reclamação: "remover a notificação quando acabar tudo").
  const unread = countUnread(
    issues
      .filter((i) => i.status !== 'done' && i.status !== 'cancelled')
      .map((i) => ({ id: i.id, updatedAt: i.updatedAt })),
  );

  return (
    <SidebarItem
      to="/issues"
      end
      icon={CircleDot}
      label={t('layout.nav.issues')}
      badge={unread > 0 ? <SidebarBadge value={unread} /> : undefined}
    />
  );
}

/**
 * Item Inbox com badge de decisões pendentes — espelha a contagem da própria
 * página: planos aguardando aprovação + issues em revisão + bloqueios/falhas.
 */
function SidebarInboxItem({
  workspaceId,
  variant = 'row',
  size = 'md',
}: {
  workspaceId: string;
  variant?: 'row' | 'icon';
  size?: 'sm' | 'md';
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const issuesQuery = useQuery({
    queryKey: ['issues', workspaceId],
    queryFn: () => window.orkestral['issue:list']({ workspaceId }),
    refetchInterval: 30_000,
  });
  const activityQuery = useQuery({
    queryKey: ['activity', workspaceId],
    queryFn: () => window.orkestral['activity:list']({ workspaceId, limit: 50 }),
    refetchInterval: 30_000,
  });
  const agentsQuery = useQuery({
    queryKey: ['agents', workspaceId],
    queryFn: () => window.orkestral['agent:list']({ workspaceId }),
    refetchInterval: 30_000,
  });
  const assignmentsQuery = useQuery({
    queryKey: ['agent-source-assignments', workspaceId],
    enabled: !!workspaceId,
    queryFn: () => window.orkestral['agent:source-assignments']({ workspaceId }),
    refetchInterval: 30_000,
  });
  const dismissedMap = useInboxDismissStore((s) => s.dismissed);
  const issues = issuesQuery.data ?? [];
  const activity = activityQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const assignments = assignmentsQuery.data ?? [];
  const teamAlreadyBuilt = agents.some((a) => !a.isOrchestrator);

  const childCount = new Map<string, number>();
  for (const i of issues) {
    if (i.parentIssueId)
      childCount.set(i.parentIssueId, (childCount.get(i.parentIssueId) ?? 0) + 1);
  }
  // Badge = pendências NÃO TRATADAS (espelha a lista do Inbox): planos p/
  // aprovar + em revisão + bloqueios não-dispensados + propostas pendentes +
  // code reviews falhos não-dispensados. Só baixa quando o item é resolvido
  // ou dispensado — não some só por abrir o Inbox.
  // Igual ao InboxPage: exclui epics já done/cancelled antes do gate de aprovação.
  const planItems = issues.filter(
    (i) =>
      i.status !== 'done' &&
      i.status !== 'cancelled' &&
      planNeedsApproval(i, childCount.get(i.id) ?? 0),
  );
  // Igual ao InboxPage: só conta in_review aguardando APROVADOR obrigatório. Issues
  // em revisão AUTOMÁTICA (cadeia reports_to, marcadas por `metadata.review`) NÃO
  // entram — o sistema resolve sozinho; sem isso o badge fica "1" com inbox vazio.
  const reviewItems = issues.filter(
    (i) => i.status === 'in_review' && !(i.metadata as { review?: unknown } | null)?.review,
  );
  const blockedItems = issues.filter(
    (i) => i.status === 'blocked' && dismissedMap[`issue:${i.id}`] !== i.updatedAt,
  );
  const failedItems = activity
    .filter((e) => e.kind === 'code_review.failed')
    .slice(0, 5)
    .filter((e) => dismissedMap[`act:${e.id}`] !== e.id);
  // Propostas: dedup por sessão (mais recente), exclui dispensadas e — pra
  // hiring — exclui quando o time já foi criado (resolvida). Igual ao InboxPage.
  const proposalsBySession = new Map<string, (typeof activity)[number]>();
  for (const e of activity) {
    if (e.kind !== 'proposal.pending' || !e.subjectId) continue;
    const prev = proposalsBySession.get(e.subjectId);
    if (!prev || e.createdAt > prev.createdAt) proposalsBySession.set(e.subjectId, e);
  }
  // Igual ao InboxPage: hiring resolvida quando o time existe; source-specialist
  // só conta enquanto a source ainda PRECISA de um agente novo (needsNewAgent).
  const assignmentBySource = new Map(assignments.map((a) => [a.sourceId, a]));
  const proposalItems = Array.from(proposalsBySession.values()).filter((e) => {
    if (dismissedMap[`act:${e.id}`] === e.id) return false;
    const payload = e.payload as { type?: string; sourceId?: string } | undefined;
    if (payload?.type === 'hiring' && teamAlreadyBuilt) return false;
    if (payload?.type === 'source-specialist' && payload.sourceId) {
      return assignmentBySource.get(payload.sourceId)?.needsNewAgent ?? true;
    }
    return true;
  });
  const count =
    planItems.length +
    reviewItems.length +
    blockedItems.length +
    failedItems.length +
    proposalItems.length;

  // Itens vivos no Inbox com mensagem ESPECÍFICA — chave estável (pra detectar
  // o que é NOVO) + texto pronto pra notificação. Cada tipo descreve o que
  // aconteceu e com qual task, em vez do genérico "Inbox · N".
  const inboxItems: { key: string; message: string }[] = [
    ...planItems.map((i) => ({
      key: `plan:${i.id}`,
      message: t('layout.notify.planPending', { title: i.title }),
    })),
    ...reviewItems.map((i) => ({
      key: `review:${i.id}`,
      message: t('layout.notify.inReview', { title: i.title }),
    })),
    ...blockedItems.map((i) => ({
      key: `blocked:${i.id}`,
      message: t('layout.notify.blocked', { title: i.title }),
    })),
    ...failedItems.map((e) => ({
      key: `failed:${e.id}`,
      message: t('layout.notify.reviewFailed', { title: e.title }),
    })),
    ...proposalItems.map((e) => ({ key: `prop:${e.id}`, message: e.title })),
  ];
  const keysSig = inboxItems
    .map((i) => i.key)
    .sort()
    .join('|');
  const seenKeysRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const prev = seenKeysRef.current;
    const current = new Set(inboxItems.map((i) => i.key));
    if (prev) {
      const fresh = inboxItems.filter((i) => !prev.has(i.key));
      if (fresh.length === 1) {
        notifyInboxTask(fresh[0].message);
      } else if (fresh.length > 1) {
        // Vários de uma vez: mostra o primeiro + contagem do resto.
        notifyInboxTask(
          t('layout.notify.inboxMore', { title: fresh[0].message, count: fresh.length - 1 }),
        );
      }
    }
    seenKeysRef.current = current;
    // keysSig resume o conteúdo; inboxItems/t são derivados dele.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSig]);

  // Notifica quando uma issue PRINCIPAL (épica: tem subtarefas) é CONCLUÍDA —
  // todos os filhos terminaram e o rollup fechou a épica. Não entra no badge do
  // Inbox (não é pendência), por isso é rastreada à parte. Não notifica na 1ª carga.
  const doneEpicIds = issues
    .filter((i) => (childCount.get(i.id) ?? 0) > 0 && i.status === 'done')
    .map((i) => i.id);
  const doneEpicSig = doneEpicIds.slice().sort().join('|');
  const seenDoneEpicsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const prev = seenDoneEpicsRef.current;
    const current = new Set(doneEpicIds);
    if (prev) {
      for (const id of doneEpicIds) {
        if (prev.has(id)) continue;
        const epic = issues.find((i) => i.id === id);
        if (epic) notifyIssueDone(t('layout.notify.issueDone', { title: epic.title }));
      }
    }
    seenDoneEpicsRef.current = current;
    // doneEpicSig resume o conteúdo; issues/t derivados dele.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneEpicSig]);

  if (variant === 'icon') {
    // Ação rápida no header: navega via onClick (sem o highlight ativo do NavLink,
    // que deixava o ícone branco quando estava em /inbox) — fica sempre `muted`
    // igual ao de Buscar. O dot só aparece quando há não-lidos (count > 0).
    return (
      <SidebarIconButton
        icon={Inbox}
        label={t('layout.nav.inbox')}
        onClick={() => navigate('/inbox')}
        badgeDot={count > 0}
        size={size}
      />
    );
  }
  return (
    <SidebarItem
      to="/inbox"
      icon={Inbox}
      label={t('layout.nav.inbox')}
      badge={count > 0 ? <SidebarBadge value={count} /> : undefined}
    />
  );
}

/** Badge numérico de acento, compartilhado por Inbox, Issues e contagem de sources.
 * Usa `bg-accent` (token único da cor da marca) pra seguir a cor de destaque
 * escolhida nas configs — por padrão roxo #6d28d9 (visual idêntico ao de antes). */
function SidebarBadge({ value, title }: { value: number; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white"
    >
      {value > 99 ? '99+' : value}
    </span>
  );
}

/**
 * Item "Integrações" + submenu com as integrações CONECTADAS (Sentry, GitHub).
 * O Sentry ganha um badge de notificação com a contagem de problemas NOVOS
 * (issues vistas depois da última visita à tela). Pra dar observabilidade, faz
 * polling da lista de erros no intervalo configurado na automação (default 5min).
 */
function SidebarIntegrationsNav() {
  const { t } = useT();
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const workspaceId = useWorkspaceStore((s) => s.active?.id);
  const lastViewedAt = useSentryViewStore((s) => s.lastViewedAt);

  const sentryAccount = useQuery({
    queryKey: ['sentry', 'account', workspaceId],
    queryFn: () => window.orkestral['sentry:get-account']({ workspaceId: workspaceId! }),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
  const githubAccount = useQuery({
    queryKey: ['github', 'account'],
    queryFn: () => window.orkestral['github:get-account'](),
    staleTime: 60_000,
  });
  const automation = useQuery({
    queryKey: ['sentry', 'automation', workspaceId],
    queryFn: () => window.orkestral['sentry:get-automation']({ workspaceId: workspaceId! }),
    enabled: !!workspaceId && !!sentryAccount.data,
    staleTime: 60_000,
  });
  const refreshMin = automation.data?.refreshIntervalMin ?? 5;
  const sentryIssues = useQuery({
    queryKey: ['sentry', 'issues', workspaceId],
    queryFn: () => window.orkestral['sentry:list-issues']({ workspaceId: workspaceId!, limit: 50 }),
    enabled: !!workspaceId && !!sentryAccount.data,
    refetchOnWindowFocus: false,
    refetchInterval: refreshMin > 0 ? refreshMin * 60_000 : false,
  });

  const newProblems = (sentryIssues.data ?? []).filter(
    (i) => !lastViewedAt || (i.lastSeen && i.lastSeen > lastViewedAt),
  ).length;

  const hasConnected = !!sentryAccount.data || !!githubAccount.data;
  return (
    <>
      <SidebarItem to="/integrations" icon={Plug2} label={t('layout.nav.integrations')} />
      {!collapsed && hasConnected && (
        <div className="ml-3 border-l border-hairline pl-2">
          {sentryAccount.data && (
            <SidebarItem
              to="/sentry"
              icon={SentryIcon as unknown as LucideIcon}
              label={t('pages.integrations.sentry.name')}
              badge={newProblems > 0 ? <SidebarBadge value={newProblems} /> : undefined}
            />
          )}
          {githubAccount.data && (
            <SidebarItem
              to="/integrations"
              icon={Github}
              label={t('pages.integrations.github.name')}
            />
          )}
        </div>
      )}
    </>
  );
}

/**
 * Linha de página na sidebar KB — estilo Notion: ao hover, mostra botões
 * `+` (subpágina) e `...` (menu com Renomear/Deletar). O menu fecha clicando
 * fora ou em ESC.
 */
interface KbTreeNode {
  id: string;
  title: string;
  kind: string;
  descendantCount: number;
  children?: KbTreeNode[];
}

function KbSidebarPageRow({
  page,
  workspaceId,
  onAnyChange,
  depth = 0,
}: {
  page: KbTreeNode;
  workspaceId: string;
  onAnyChange: () => void;
  depth?: number;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const Icon = page.kind === 'auto-generated' ? Sparkles : FileText;
  const hasChildren = (page.children?.length ?? 0) > 0;
  const expandedKey = `orkestral.sidebar.kb.expanded.${page.id}`;
  const [expanded, setExpandedRaw] = useState<boolean>(() => {
    if (!hasChildren) return false;
    try {
      const raw = localStorage.getItem(expandedKey);
      return raw === null ? true : raw === 'true';
    } catch {
      return true;
    }
  });
  const setExpanded = (v: boolean) => {
    setExpandedRaw(v);
    try {
      localStorage.setItem(expandedKey, String(v));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', onClick);
      document.addEventListener('keydown', onKey);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function openMenu() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // Posiciona à direita do trigger; se passar da tela, encosta na borda direita
      const menuWidth = 200;
      const left = Math.min(window.innerWidth - menuWidth - 8, rect.right + 6);
      setMenuPos({ left, top: rect.top });
    }
    setMenuOpen(true);
  }

  const createSubpage = useMutation({
    mutationFn: () =>
      window.orkestral['kb:create-page']({
        workspaceId,
        parentId: page.id,
        title: t('layout.sidebar.newSubpageTitle'),
        kind: 'doc',
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['kb-tree'] });
      queryClient.invalidateQueries({ queryKey: ['kb-graph'] });
      onAnyChange();
      setExpanded(true);
      navigate(`/knowledge/${created.id}`);
    },
  });

  const renameMut = useMutation({
    mutationFn: (newTitle: string) =>
      window.orkestral['kb:update-page']({
        pageId: page.id,
        patch: { title: newTitle },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb-tree'] });
      queryClient.invalidateQueries({ queryKey: ['kb-graph'] });
      queryClient.invalidateQueries({ queryKey: ['kb-page', page.id] });
      onAnyChange();
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => window.orkestral['kb:delete-page']({ pageId: page.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb-tree'] });
      queryClient.invalidateQueries({ queryKey: ['kb-graph'] });
      onAnyChange();
      navigate('/knowledge');
    },
  });

  function handleRename() {
    setMenuOpen(false);
    const next = window.prompt(t('layout.sidebar.renamePagePrompt'), page.title);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === page.title) return;
    renameMut.mutate(trimmed);
  }

  function handleDelete() {
    setMenuOpen(false);
    if (window.confirm(t('layout.sidebar.deletePageConfirm', { title: page.title }))) {
      deleteMut.mutate();
    }
  }

  return (
    <>
      <div className="group/row relative flex items-center">
        {/* Chevron de expand/collapse — só visível se tem children */}
        {hasChildren && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="grid h-4 w-4 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-2 hover:text-text-secondary"
            style={{ marginLeft: depth * 8 }}
            title={expanded ? t('layout.sidebar.collapse') : t('layout.sidebar.expand')}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        )}
        {!hasChildren && <span className="h-4 w-4 shrink-0" style={{ marginLeft: depth * 8 }} />}
        <NavLink
          to={`/knowledge/${page.id}`}
          className={({ isActive }) =>
            cn(
              'flex h-7 flex-1 items-center gap-2 truncate rounded-md px-2 text-[12.5px] transition-colors',
              isActive
                ? 'bg-surface-active text-text-primary'
                : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
            )
          }
          title={page.title}
        >
          <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="flex-1 truncate">{page.title}</span>
          {page.descendantCount > 0 && (
            <span className="font-mono text-[10px] text-text-faint opacity-100 transition-opacity group-hover/row:opacity-0">
              {page.descendantCount}
            </span>
          )}
        </NavLink>
        {/* Botões de ação — bg sólido + gradient esquerdo pra "ocultar" o texto
            que estaria por baixo. Sem isso, o texto da página vaza por trás dos
            ícones e fica ilegível. */}
        <div
          className={cn(
            'pointer-events-none absolute right-0 top-0 flex h-full items-center pl-6 pr-1 opacity-0 transition-opacity',
            'group-hover/row:pointer-events-auto group-hover/row:opacity-100',
            menuOpen && 'pointer-events-auto opacity-100',
          )}
          style={{
            background:
              'linear-gradient(to right, transparent 0%, var(--color-sidebar, #0e0f10) 24px, var(--color-sidebar, #0e0f10) 100%)',
          }}
        >
          <button
            ref={triggerRef}
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (menuOpen) setMenuOpen(false);
              else openMenu();
            }}
            title={t('layout.sidebar.moreOptions')}
            className="grid h-5 w-5 place-items-center rounded text-text-faint hover:bg-surface-6 hover:text-text-primary"
          >
            <MoreHorizontal className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              createSubpage.mutate();
            }}
            disabled={createSubpage.isPending}
            title={t('layout.sidebar.addSubpage')}
            className="grid h-5 w-5 place-items-center rounded text-text-faint hover:bg-surface-6 hover:text-text-primary disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Children recursivos */}
      {hasChildren && expanded && (
        <div>
          {page.children!.map((child) => (
            <KbSidebarPageRow
              key={child.id}
              page={child}
              workspaceId={workspaceId}
              onAnyChange={onAnyChange}
              depth={depth + 1}
            />
          ))}
        </div>
      )}

      {/* Popover via portal — evita corte por overflow:hidden da nav */}
      {menuOpen &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: 'fixed',
              left: menuPos.left,
              top: menuPos.top,
              zIndex: 1000,
              backgroundColor: '#15161b',
            }}
            className="flex w-[200px] flex-col gap-0.5 rounded-lg border border-hairline-strong p-1 shadow-2xl"
          >
            <button
              type="button"
              onClick={handleRename}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
            >
              <PenLine className="h-3.5 w-3.5 opacity-80" />
              <span>{t('layout.sidebar.rename')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                createSubpage.mutate();
              }}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
            >
              <Plus className="h-3.5 w-3.5 opacity-80" />
              <span>{t('layout.sidebar.addSubpage')}</span>
            </button>
            <div className="my-0.5 border-t border-hairline-faint" />
            <button
              type="button"
              onClick={handleDelete}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-accent-red hover:bg-accent-red/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{t('layout.sidebar.moveToTrash')}</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Seção "Agentes" colapsável — mesmo padrão visual de Sources/KB. Header é
 * um NavLink pra `/agents` (lista geral) com chevron de expand/collapse ao
 * lado e botão `+` pra criar novo. Por padrão fechada — usuário expande
 * quando quer browsar a lista (preferência persiste em localStorage).
 */
function SidebarAgentsSection({
  agents,
  onNewAgent,
  collapsed,
}: {
  agents: Array<{
    id: string;
    name: string;
    avatarSeed?: string | null;
  }>;
  onNewAgent: () => void;
  collapsed: boolean;
}) {
  const { t } = useT();

  // Sem menu principal — botão "Criar agente" (igual o Novo chat) + os agentes
  // (filhos) renderizados direto.
  return (
    <div>
      <SidebarPrimaryAction icon={Plus} label={t('layout.sidebar.newAgent')} onClick={onNewAgent} />
      <div className="mt-1">
        {agents.length === 0 ? (
          <div className="px-2 py-1.5 text-[11.5px] text-text-faint">
            {t('layout.sidebar.noAgentsYet')}
          </div>
        ) : (
          agents.map((a) => (
            <SidebarAgentRow
              key={a.id}
              agentId={a.id}
              name={a.name}
              avatarSeed={a.avatarSeed}
              collapsed={collapsed}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Row de agente na sidebar — substitui o ícone genérico Bot pelo avatar
 * DiceBear (procedural). Mantém o mesmo visual de hover/ativo do
 * SidebarItem. No modo collapsed, mostra só o avatar centralizado.
 */
/** Bolinha verde "trabalhando" sobreposta no avatar do agente (P1-02). */
function AgentWorkingDot({ working }: { working: boolean }) {
  if (!working) return null;
  return (
    <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-sidebar bg-accent-green">
      <span className="absolute inset-0 animate-ping rounded-full bg-accent-green opacity-75" />
    </span>
  );
}

function SidebarAgentRow({
  agentId,
  name,
  avatarSeed,
  collapsed,
}: {
  agentId: string;
  name: string;
  avatarSeed?: string | null;
  collapsed: boolean;
}) {
  // Status derivado dos eventos de execução (P1-02): bolinha quando trabalhando +
  // tooltip com a task atual. Hooks chamados incondicionalmente (antes do return).
  const working = useAgentWorking(agentId);
  const task = useAgentTask(agentId);
  if (collapsed) {
    return (
      <NavLink
        to={`/agents/${agentId}`}
        title={working && task ? `${name} · ${task}` : name}
        className={({ isActive }) =>
          cn(
            'group my-0.5 flex h-9 w-9 items-center justify-center rounded-md transition-colors',
            'hover:bg-surface-1',
            isActive && 'bg-surface-active',
          )
        }
      >
        <span className="relative">
          <AgentAvatar seed={avatarSeed} name={name} size={24} rounded="md" className="ring-0" />
          <AgentWorkingDot working={working} />
        </span>
      </NavLink>
    );
  }
  return (
    <NavLink
      to={`/agents/${agentId}`}
      title={working && task ? `${name} · ${task}` : undefined}
      className={({ isActive }) =>
        cn(
          'group my-0.5 flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-text-secondary transition-colors',
          'hover:bg-surface-1 hover:text-text-primary',
          isActive && 'bg-surface-active text-text-primary',
        )
      }
    >
      <span className="relative shrink-0">
        <AgentAvatar seed={avatarSeed} name={name} size={22} rounded="md" className="ring-0" />
        <AgentWorkingDot working={working} />
      </span>
      <span className="flex-1 truncate">{name}</span>
      {working && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-green" aria-hidden />
      )}
    </NavLink>
  );
}
