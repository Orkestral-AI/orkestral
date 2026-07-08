import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Edit3,
  History,
  MessageSquare,
  PanelLeft,
  PanelRightClose,
  PanelRightOpen,
  Search,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useUIStore } from '@renderer/stores/uiStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { formatTime as formatTimeOfDay } from '@renderer/lib/time';
import { useT, type TFunction, type Language } from '@renderer/i18n';

interface TopToolbarProps {
  /** Texto/conteúdo central — geralmente o título da sessão (pode ter chips de
   *  menção de agente). */
  centerLabel?: ReactNode;
  /** Subtítulo em segunda linha (ex: agente · adapter · model). */
  centerSubtitle?: string;
  /** Estado do painel de revisão (só renderiza toggle se passar `onToggleReview`). */
  reviewOpen?: boolean;
  onToggleReview?: () => void;
  /** Com o painel FECHADO, mostra um pill com este label em vez do ícone solto
   *  (ex.: "Abrir workspace" na SessionPage). */
  reviewToggleLabel?: string;
}

/**
 * Barra superior unificada do app — usada em todas as páginas que vivem
 * dentro de um "card" (Home, SessionPage, etc.).
 */
export function TopToolbar({
  centerLabel,
  centerSubtitle,
  reviewOpen,
  onToggleReview,
  reviewToggleLabel,
}: TopToolbarProps) {
  const navigate = useNavigate();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const { t } = useT();

  return (
    <div className="window-drag flex h-12 shrink-0 items-center gap-1 border-b border-hairline-soft px-2">
      {/* Esquerda — botões compactos sem separators */}
      <div className="window-no-drag flex items-center">
        <ToolbarIconButton
          onClick={toggleSidebar}
          title={t('chat.toolbar.toggleSidebar')}
          shortcut="⌘B"
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={() => navigate('/')}
          title={t('chat.toolbar.newChat')}
          shortcut="⌘N"
        >
          <Edit3 className="h-3.5 w-3.5" />
        </ToolbarIconButton>
        <SessionsHistoryButton />
      </div>

      {/* Centro — só renderiza se houver título */}
      <div className="flex flex-1 items-center justify-center px-2">
        {centerLabel && (
          <div className="flex max-w-[60%] flex-col items-center">
            <div className="truncate text-[12.5px] font-medium text-text-primary">
              {centerLabel}
            </div>
            {centerSubtitle && (
              <div className="truncate text-[10.5px] text-text-muted">{centerSubtitle}</div>
            )}
          </div>
        )}
      </div>

      {/* Direita — ações específicas */}
      <div className="window-no-drag flex items-center">
        {onToggleReview &&
          (!reviewOpen && reviewToggleLabel ? (
            <button
              type="button"
              onClick={onToggleReview}
              className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11.5px] font-medium text-accent transition-colors hover:bg-accent/20"
            >
              <PanelRightOpen className="h-3.5 w-3.5" />
              {reviewToggleLabel}
            </button>
          ) : (
            <ToolbarIconButton
              onClick={onToggleReview}
              title={reviewOpen ? t('chat.toolbar.hideReview') : t('chat.toolbar.showReview')}
            >
              {reviewOpen ? (
                <PanelRightClose className="h-3.5 w-3.5" />
              ) : (
                <PanelRightOpen className="h-3.5 w-3.5" />
              )}
            </ToolbarIconButton>
          ))}
      </div>
    </div>
  );
}

function ToolbarIconButton({
  children,
  onClick,
  title,
  shortcut,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title: string;
  shortcut?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="grid h-7 w-7 place-items-center rounded text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <div className="flex items-center gap-2">
          <span>{title}</span>
          {shortcut && <span className="text-[10px] font-mono text-text-muted">{shortcut}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Botão de histórico — popover refinado com search interno + lista de
 * sessões recentes. Substitui a antiga seção "Conversas" da sidebar.
 */
function SessionsHistoryButton() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const { t, lang } = useT();

  const sessionsQuery = useQuery({
    queryKey: ['sessions', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['session:list']({ workspaceId: activeWorkspace!.id }),
    refetchInterval: 4000,
  });
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query]);

  // Agrupa por dia
  const groups = useMemo(() => groupByDay(filtered, t), [filtered, t]);

  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="grid h-7 w-7 place-items-center rounded text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
          >
            <History className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {t('chat.toolbar.recentConversations')}
        </TooltipContent>
      </Tooltip>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1.5 w-[320px] overflow-hidden rounded-xl border border-hairline-strong bg-dialog shadow-2xl">
            {/* Header com search */}
            <div className="border-b border-hairline-faint p-2">
              <div className="flex items-center gap-2 rounded-md bg-surface-hover px-2.5 py-1.5">
                <Search className="h-3.5 w-3.5 text-text-faint" />
                <input
                  autoFocus
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('chat.toolbar.searchConversations')}
                  className="flex-1 bg-transparent text-[12.5px] text-text-primary placeholder:text-text-faint focus:outline-none"
                />
              </div>
            </div>

            {/* Lista agrupada por dia */}
            <div className="no-scrollbar max-h-[360px] overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12.5px] text-text-muted">
                  {query ? t('chat.menu.noResults') : t('chat.toolbar.noConversations')}
                </div>
              ) : (
                groups.map((group) => (
                  <div key={group.label}>
                    <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.18em] text-text-faint">
                      {group.label}
                    </div>
                    {group.items.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          navigate(`/session/${s.id}`);
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-1"
                      >
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-text-faint" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] text-text-primary">{s.title}</div>
                          <div className="text-[10.5px] text-text-muted">
                            {formatTime(s.updatedAt, lang)}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface SessionMin {
  id: string;
  title: string;
  updatedAt: string;
}

/** Agrupa sessões em "Hoje", "Ontem", "Esta semana", "Anterior". */
function groupByDay(
  sessions: SessionMin[],
  t: TFunction,
): Array<{ label: string; items: SessionMin[] }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const buckets: Record<'today' | 'yesterday' | 'thisWeek' | 'earlier', SessionMin[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };

  for (const s of sessions) {
    const d = new Date(s.updatedAt);
    if (d >= today) buckets.today.push(s);
    else if (d >= yesterday) buckets.yesterday.push(s);
    else if (d >= weekAgo) buckets.thisWeek.push(s);
    else buckets.earlier.push(s);
  }

  return (
    Object.entries(buckets) as Array<['today' | 'yesterday' | 'thisWeek' | 'earlier', SessionMin[]]>
  )
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => ({ label: t(`chat.history.${key}`), items }));
}

function formatTime(iso: string, lang: Language): string {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (d >= today) {
    return formatTimeOfDay(iso);
  }
  return d.toLocaleDateString(lang, { day: '2-digit', month: 'short' });
}
