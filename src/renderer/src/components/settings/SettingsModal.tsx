import { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import {
  Settings2,
  Monitor,
  Palette,
  Shield,
  Database,
  Cpu,
  Keyboard,
  CreditCard,
  Users,
  LifeBuoy,
  FlaskConical,
  Briefcase,
  Mic,
  Bot,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useUIStore } from '@renderer/stores/uiStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { GeneralPanel } from './panels/GeneralPanel';
import { WorkspacePanel } from './panels/WorkspacePanel';
import { SystemPanel } from './panels/SystemPanel';
import { AppearancePanel } from './panels/AppearancePanel';
import { AdvancedPanel } from './panels/AdvancedPanel';
import { PrivacyPanel } from './panels/PrivacyPanel';
import { DataPanel } from './panels/DataPanel';
import { ModelsPanel } from './panels/ModelsPanel';
import { AgentBehaviorPanel } from './panels/AgentBehaviorPanel';
import { ShortcutsPanel } from './panels/ShortcutsPanel';
import { BillingPanel } from './panels/BillingPanel';
import { TeamPanel } from './panels/TeamPanel';
import { SupportPanel } from './panels/SupportPanel';
import { AudioPanel } from './panels/AudioPanel';

interface SettingsCategory {
  id: string;
  /** Chave i18n da categoria (resolvida via t() no render). */
  labelKey: string;
  icon: LucideIcon;
  /** Só aparece no ambiente local (workspace planMode === 'local'). */
  localOnly?: boolean;
  /** Mostra badge "em breve" — feature ainda sem backend. */
  soon?: boolean;
}

interface CategoryGroup {
  /** Chave i18n do grupo (resolvida via t() no render). */
  labelKey: string;
  items: SettingsCategory[];
}

/**
 * Abas das Configurações, agrupadas por contexto.
 *
 * MCPs e Integrações NÃO entram aqui — já são destinos de 1º nível na sidebar.
 * "Avançado" só aparece no ambiente local (ações dev/destrutivas).
 */
const GROUPS: CategoryGroup[] = [
  {
    labelKey: 'settings.modal.groups.account',
    items: [
      { id: 'general', labelKey: 'settings.modal.categories.general', icon: Settings2 },
      { id: 'team', labelKey: 'settings.modal.categories.team', icon: Users, soon: true },
      {
        id: 'subscription',
        labelKey: 'settings.modal.categories.subscription',
        icon: CreditCard,
        soon: true,
      },
    ],
  },
  {
    labelKey: 'settings.modal.groups.workspace',
    items: [
      { id: 'workspace', labelKey: 'settings.modal.categories.workspace', icon: Briefcase },
      { id: 'llms', labelKey: 'settings.modal.categories.llms', icon: Cpu },
      { id: 'agent', labelKey: 'settings.modal.categories.agent', icon: Bot },
    ],
  },
  {
    labelKey: 'settings.modal.groups.app',
    items: [
      { id: 'system', labelKey: 'settings.modal.categories.system', icon: Monitor },
      { id: 'appearance', labelKey: 'settings.modal.categories.appearance', icon: Palette },
      { id: 'audio', labelKey: 'settings.modal.categories.audio', icon: Mic },
      { id: 'shortcuts', labelKey: 'settings.modal.categories.shortcuts', icon: Keyboard },
      { id: 'privacy', labelKey: 'settings.modal.categories.privacy', icon: Shield, soon: true },
      { id: 'data', labelKey: 'settings.modal.categories.data', icon: Database },
    ],
  },
  {
    labelKey: 'settings.modal.groups.help',
    items: [
      { id: 'support', labelKey: 'settings.modal.categories.support', icon: LifeBuoy },
      {
        id: 'advanced',
        labelKey: 'settings.modal.categories.advanced',
        icon: FlaskConical,
        localOnly: true,
      },
    ],
  },
];

export function SettingsModal() {
  const open = useUIStore((s) => s.settingsOpen);
  const close = useUIStore((s) => s.closeSettings);
  const tab = useUIStore((s) => s.settingsTab);
  const setTab = useUIStore((s) => s.setSettingsTab);
  const openSettings = useUIStore((s) => s.openSettings);
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const { t } = useT();

  const versionQuery = useQuery({
    queryKey: ['app-version'],
    queryFn: () => window.orkestral['app:get-version'](),
    enabled: open,
  });

  // "Avançado" só no ambiente local. Filtra os grupos por localOnly.
  const isLocal = activeWorkspace?.planMode === 'local';
  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((c) => !c.localOnly || isLocal),
      })).filter((g) => g.items.length > 0),
    [isLocal],
  );

  const allIds = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.id)), [groups]);

  // Se a aba ativa deixou de existir (ex.: saiu de local), volta pra Geral.
  useEffect(() => {
    if (open && !allIds.includes(tab)) setTab('general');
  }, [open, allIds, tab, setTab]);

  // Atalho global ⌘, (toggle) + Esc (fecha).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        if (open) close();
        else openSettings();
      } else if (e.key === 'Escape' && open) {
        close();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, openSettings]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[70] flex flex-col bg-background"
        >
          {/* Drag region pros traffic lights do macOS */}
          <div className="window-drag absolute inset-x-0 top-0 z-10 h-11" />

          <button
            type="button"
            onClick={close}
            className="window-no-drag absolute right-5 top-4 z-20 grid h-8 w-8 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
            title={t('settings.modal.closeTitle')}
            aria-label={t('settings.modal.closeAria')}
          >
            <X className="h-4 w-4" />
          </button>

          <div className="flex min-h-0 flex-1">
            {/* Sidebar de categorias */}
            <aside className="window-no-drag flex w-60 shrink-0 flex-col overflow-y-auto border-r border-hairline bg-surface-veil px-3 pb-4 pt-12">
              <div className="mb-3 px-3 text-[15px] font-semibold tracking-tight text-text-primary">
                {t('settings.modal.title')}
              </div>
              <nav className="flex flex-1 flex-col gap-4">
                {groups.map((group) => (
                  <div key={group.labelKey}>
                    <div className="px-3 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-text-faint">
                      {t(group.labelKey)}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {group.items.map((c) => {
                        const Icon = c.icon;
                        const active = tab === c.id;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setTab(c.id)}
                            className={cn(
                              'group relative flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] transition-colors',
                              active
                                ? 'bg-surface-active text-text-primary'
                                : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                            )}
                          >
                            {active && (
                              <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent-purple" />
                            )}
                            <Icon
                              className={cn(
                                'h-3.5 w-3.5 shrink-0',
                                active ? 'text-accent-purple' : 'opacity-70',
                              )}
                            />
                            <span className="flex-1 text-left">{t(c.labelKey)}</span>
                            {c.soon && (
                              <span className="shrink-0 rounded-full border border-hairline-strong px-1.5 text-[9px] font-medium uppercase tracking-wide text-text-faint">
                                {t('settings.modal.soonBadge')}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </nav>
              <div className="px-3 pt-3 text-[10px] text-text-faint">
                Orkestral{versionQuery.data ? ` v${versionQuery.data.version}` : ''}
              </div>
            </aside>

            {/* Conteúdo */}
            <section
              className="window-no-drag min-h-0 flex-1 overflow-y-auto pt-11"
              style={{ scrollbarGutter: 'stable both-edges' }}
            >
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="mx-auto w-full max-w-4xl px-8 py-8"
              >
                {tab === 'general' && <GeneralPanel />}
                {tab === 'workspace' && <WorkspacePanel onClose={close} />}
                {tab === 'system' && <SystemPanel />}
                {tab === 'appearance' && <AppearancePanel />}
                {tab === 'audio' && <AudioPanel />}
                {tab === 'privacy' && <PrivacyPanel />}
                {tab === 'data' && <DataPanel />}
                {tab === 'llms' && <ModelsPanel />}
                {tab === 'agent' && <AgentBehaviorPanel />}
                {tab === 'shortcuts' && <ShortcutsPanel />}
                {tab === 'subscription' && <BillingPanel />}
                {tab === 'team' && <TeamPanel />}
                {tab === 'support' && <SupportPanel onClose={close} />}
                {tab === 'advanced' && <AdvancedPanel onClose={close} />}
              </motion.div>
            </section>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
