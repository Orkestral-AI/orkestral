import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  MessageSquarePlus,
  Bot,
  Github,
  Building2,
  LayoutGrid,
  CircleDot,
  Repeat,
  Target,
  GitPullRequestArrow,
  Brain,
  Inbox,
  Wand2,
  CircleDollarSign,
  Activity,
  Cog,
  Sun,
  Database,
  MessageSquare,
  ArrowRight,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useUIStore } from '@renderer/stores/uiStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT, type TFunction } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';
import type { ChatSession } from '@shared/types';

interface CommandItem {
  id: string;
  group: 'actions' | 'navigation' | 'chats' | 'settings';
  label: string;
  hint?: string;
  icon: typeof Search;
  shortcut?: string;
  onSelect: () => void;
  /** Texto adicional pra fuzzy match — labels alternativos, sinônimos. */
  keywords?: string;
}

function groupLabels(t: TFunction): Record<CommandItem['group'], string> {
  return {
    actions: t('layout.command.groups.actions'),
    navigation: t('layout.command.groups.navigation'),
    chats: t('layout.command.groups.chats'),
    settings: t('layout.command.groups.settings'),
  };
}

const GROUP_ORDER: CommandItem['group'][] = ['actions', 'chats', 'navigation', 'settings'];

/**
 * Command Palette — modal acessível com ⌘K. Tudo da plataforma indexado
 * num único lugar:
 *   - Ações (novo chat, novo agente, conectar GitHub…)
 *   - Conversas recentes (com fuzzy match no título)
 *   - Navegação pras páginas
 *   - Atalhos de Configurações
 *
 * Renderizado em portal pra escapar de stacking contexts.
 */
export function CommandPalette() {
  const { t } = useT();
  const open = useUIStore((s) => s.commandPaletteOpen);
  const close = useUIStore((s) => s.closeCommandPalette);
  const openCommandPalette = useUIStore((s) => s.openCommandPalette);
  const openSettings = useUIStore((s) => s.openSettings);
  const openNewAgent = useUIStore((s) => s.openNewAgent);
  const activeWorkspace = useWorkspaceStore((s) => s.active);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Atalho ⌘K global pra abrir.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openCommandPalette();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openCommandPalette]);

  // Reset ao abrir + focus.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const sessionsQuery = useQuery({
    queryKey: ['sessions', activeWorkspace?.id],
    enabled: !!activeWorkspace && open,
    queryFn: () => window.orkestral['session:list']({ workspaceId: activeWorkspace!.id }),
  });
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  const items = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [];

    // Ações
    list.push(
      {
        id: 'action:new-chat',
        group: 'actions',
        label: t('layout.command.newChat'),
        icon: MessageSquarePlus,
        shortcut: '⌘N',
        keywords: 'novo chat conversa session',
        onSelect: () => {
          window.location.hash = '#/';
          close();
        },
      },
      {
        id: 'action:new-agent',
        group: 'actions',
        label: t('layout.command.createAgent'),
        icon: Bot,
        keywords: 'novo agente assistant',
        onSelect: () => {
          close();
          openNewAgent();
        },
      },
      {
        id: 'action:connect-github',
        group: 'actions',
        label: t('layout.command.connectGithub'),
        icon: Github,
        keywords: 'github oauth repo repositorio',
        onSelect: () => {
          // GitHub OAuth está no onboarding step 1 — mando user pra settings
          // quando existir um painel próprio. Por agora abre Settings.
          close();
          openSettings('integrations');
        },
      },
    );

    // Conversas (até 8 sem busca)
    const filteredSessions: ChatSession[] = query.trim()
      ? sessions.slice(0, 20)
      : sessions.slice(0, 8);
    for (const s of filteredSessions) {
      list.push({
        id: `chat:${s.id}`,
        group: 'chats',
        label: s.title || t('layout.command.untitledChat'),
        icon: MessageSquare,
        keywords: s.title ?? '',
        onSelect: () => {
          window.location.hash = `#/session/${s.id}`;
          close();
        },
      });
    }

    // Navegação
    list.push(
      {
        id: 'nav:dashboard',
        group: 'navigation',
        label: t('layout.command.dashboard'),
        icon: LayoutGrid,
        onSelect: () => go('/dashboard', close),
      },
      {
        id: 'nav:inbox',
        group: 'navigation',
        label: t('layout.command.inbox'),
        icon: Inbox,
        onSelect: () => go('/inbox', close),
      },
      {
        id: 'nav:issues',
        group: 'navigation',
        label: t('layout.command.issues'),
        icon: CircleDot,
        onSelect: () => go('/issues', close),
      },
      {
        id: 'nav:routines',
        group: 'navigation',
        label: t('layout.command.routines'),
        icon: Repeat,
        onSelect: () => go('/routines', close),
      },
      {
        id: 'nav:goals',
        group: 'navigation',
        label: t('layout.command.goals'),
        icon: Target,
        onSelect: () => go('/goals', close),
      },
      {
        id: 'nav:code-reviews',
        group: 'navigation',
        label: t('layout.command.codeReviews'),
        icon: GitPullRequestArrow,
        onSelect: () => go('/code-reviews', close),
      },
      {
        id: 'nav:knowledge',
        group: 'navigation',
        label: t('layout.command.knowledgeBase'),
        icon: Brain,
        onSelect: () => go('/knowledge', close),
      },
      {
        id: 'nav:agents',
        group: 'navigation',
        label: t('layout.command.agents'),
        icon: Bot,
        onSelect: () => go('/agents', close),
      },
      {
        id: 'nav:org',
        group: 'navigation',
        label: t('layout.command.org'),
        icon: Building2,
        onSelect: () => go('/company/org', close),
      },
      {
        id: 'nav:skills',
        group: 'navigation',
        label: t('layout.command.skills'),
        icon: Wand2,
        onSelect: () => go('/company/skills', close),
      },
      {
        id: 'nav:costs',
        group: 'navigation',
        label: t('layout.command.costs'),
        icon: CircleDollarSign,
        onSelect: () => go('/company/costs', close),
      },
      {
        id: 'nav:activity',
        group: 'navigation',
        label: t('layout.command.activity'),
        icon: Activity,
        onSelect: () => go('/company/activity', close),
      },
    );

    // Configurações
    list.push(
      {
        id: 'set:open',
        group: 'settings',
        label: t('layout.command.openSettings'),
        icon: Cog,
        shortcut: '⌘,',
        onSelect: () => {
          close();
          openSettings();
        },
      },
      {
        id: 'set:appearance',
        group: 'settings',
        label: t('layout.command.changeAppearance'),
        icon: Sun,
        keywords: 'tema theme dark light',
        onSelect: () => {
          close();
          openSettings('appearance');
        },
      },
      {
        id: 'set:reset',
        group: 'settings',
        label: t('layout.command.resetLocalDb'),
        icon: Database,
        keywords: 'reset clear delete database sqlite',
        onSelect: () => {
          close();
          openSettings('privacy');
        },
      },
    );

    return list;
  }, [sessions, query, close, openSettings, openNewAgent, t]);

  // Filtro fuzzy simples: substring case-insensitive em label + keywords.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const hay = `${it.label} ${it.keywords ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  // Agrupa por GROUP_LABELS na ordem definida.
  const grouped = useMemo(() => {
    const map = new Map<CommandItem['group'], CommandItem[]>();
    for (const g of GROUP_ORDER) map.set(g, []);
    for (const it of filtered) map.get(it.group)?.push(it);
    return GROUP_ORDER.map((g) => ({ group: g, items: map.get(g) ?? [] })).filter(
      (row) => row.items.length > 0,
    );
  }, [filtered]);

  // Flat list pra navegação por teclado
  const flat = useMemo(() => grouped.flatMap((row) => row.items), [grouped]);

  const safeSelectedIndex = Math.min(selectedIndex, Math.max(0, flat.length - 1));

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = flat[safeSelectedIndex];
      if (item) item.onSelect();
    }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          style={
            {
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
              paddingTop: 96,
              WebkitAppRegion: 'no-drag',
            } as CSSProperties
          }
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          {/* Backdrop */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
            onClick={close}
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            style={
              {
                position: 'relative',
                zIndex: 10000,
                width: '100%',
                maxWidth: 620,
                background: 'var(--color-dialog)',
                border: '1px solid var(--color-hairline-strong)',
                borderRadius: 14,
                boxShadow: '0 24px 70px rgba(0,0,0,0.6)',
                overflow: 'hidden',
                WebkitAppRegion: 'no-drag',
              } as CSSProperties
            }
          >
            {/* Input */}
            <div className="flex items-center gap-2.5 border-b border-hairline px-4">
              <Search className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                onKeyDown={handleKey}
                placeholder={t('layout.command.placeholder')}
                className="h-12 flex-1 bg-transparent text-[14px] text-text-primary placeholder:text-text-muted focus:outline-none"
              />
              <kbd className="rounded border border-hairline bg-surface-hover px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                Esc
              </kbd>
            </div>

            {/* Lista */}
            <div
              className="thin-scrollbar max-h-[440px] overflow-y-auto px-2 py-2"
              style={{ scrollbarGutter: 'stable' }}
            >
              {grouped.length === 0 ? (
                <div className="py-12 text-center text-[12.5px] text-text-muted">
                  {t('layout.command.noResults')}{' '}
                  <span className="text-text-secondary">"{query}"</span>
                </div>
              ) : (
                grouped.map((row) => (
                  <GroupSection
                    key={row.group}
                    label={groupLabels(t)[row.group]}
                    items={row.items}
                    selectedId={flat[safeSelectedIndex]?.id}
                    onHoverIndex={(id) => {
                      const idx = flat.findIndex((it) => it.id === id);
                      if (idx >= 0) setSelectedIndex(idx);
                    }}
                  />
                ))
              )}
            </div>

            {/* Footer com atalhos */}
            <div className="flex items-center gap-3 border-t border-hairline px-4 py-2 text-[10.5px] text-text-muted">
              <FooterHint label={t('layout.command.footerNavigate')} keys={['↑', '↓']} />
              <FooterHint label={t('layout.command.footerOpen')} keys={['↵']} />
              <FooterHint label={t('layout.command.footerClose')} keys={['esc']} />
              <div className="flex-1" />
              <span>⌘K</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function GroupSection({
  label,
  items,
  selectedId,
  onHoverIndex,
}: {
  label: string;
  items: CommandItem[];
  selectedId?: string;
  onHoverIndex: (id: string) => void;
}) {
  return (
    <div className="mb-1">
      <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-text-faint">
        {label}
      </div>
      {items.map((it) => (
        <CommandRow
          key={it.id}
          item={it}
          selected={it.id === selectedId}
          onHover={() => onHoverIndex(it.id)}
        />
      ))}
    </div>
  );
}

function CommandRow({
  item,
  selected,
  onHover,
}: {
  item: CommandItem;
  selected: boolean;
  onHover: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={item.onSelect}
      onMouseMove={onHover}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors',
        selected ? 'bg-surface-active' : 'hover:bg-surface-hover',
      )}
    >
      <Icon
        className={cn('h-4 w-4 shrink-0', selected ? 'text-text-primary' : 'text-text-muted')}
      />
      <span
        className={cn(
          'flex-1 truncate text-[13px]',
          selected ? 'text-text-primary' : 'text-text-secondary',
        )}
      >
        {item.label}
      </span>
      {item.shortcut && (
        <kbd className="font-mono text-[10.5px] text-text-faint">{item.shortcut}</kbd>
      )}
      {selected && <ArrowRight className="h-3 w-3 text-text-muted" />}
    </button>
  );
}

function FooterHint({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="rounded border border-hairline bg-surface-hover px-1.5 py-0.5 font-mono text-[10px]"
        >
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  );
}

function go(path: string, close: () => void): void {
  window.location.hash = `#${path}`;
  close();
}

// Suppress unused-warning pra ReactNode (mantido por consistência caso vire prop)
export type { ReactNode };
