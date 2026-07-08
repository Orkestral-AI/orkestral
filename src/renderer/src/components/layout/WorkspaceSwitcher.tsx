import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, Plus, Check, UserPlus, Cog, LogOut, Pencil } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { WorkspaceAvatar, workspaceCode } from './WorkspaceAvatar';
import { CreateWorkspaceWizard } from '@renderer/components/workspace/CreateWorkspaceWizard';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useUIStore } from '@renderer/stores/uiStore';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';
import type { Workspace } from '@shared/types';

export function WorkspaceSwitcher() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const active = useWorkspaceStore((s) => s.active);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const preferredWorkspaceId = useWorkspaceStore((s) => s.preferredWorkspaceId);
  const requiresWorkspaceSelection = useWorkspaceStore((s) => s.requiresWorkspaceSelection);
  const enterWorkspaceSelection = useWorkspaceStore((s) => s.enterWorkspaceSelection);
  const openSettings = useUIStore((s) => s.openSettings);
  const collapsed = useUIStore((s) => s.sidebarCollapsed);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => window.orkestral['workspace:list'](),
  });

  const [wizardOpen, setWizardOpen] = useState(false);

  const switchMutation = useMutation({
    mutationFn: (workspaceId: string) => window.orkestral['workspace:switch']({ workspaceId }),
    onSuccess: (ws) => {
      setActive(ws);
      // Sessões/agentes são por workspace. Sai da sessão atual (que pertence
      // ao workspace antigo) e vai pro home do workspace novo.
      window.location.hash = '#/';
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => window.orkestral['app:logout'](),
    onSuccess: () => {
      enterWorkspaceSelection();
      window.location.hash = '#/';
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      queryClient.invalidateQueries({ queryKey: ['user'] });
    },
  });

  const list = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);

  // Hidrata o workspace ativo a partir da lista do DB sempre que ele estiver
  // null (boot) ou apontar pra um id que não existe mais. Prioriza o
  // preferredWorkspaceId persistido em localStorage.
  useEffect(() => {
    if (list.length === 0) return;
    if (requiresWorkspaceSelection) return;
    if (active && list.some((w) => w.id === active.id)) return;
    // Não sobrescreve quando o ativo é o preferido recém-selecionado (ex.: acabou
    // de ser criado e a lista ainda não refez o fetch) — evita resetar pro list[0].
    if (active && active.id === preferredWorkspaceId) return;
    const preferred = preferredWorkspaceId ? list.find((w) => w.id === preferredWorkspaceId) : null;
    setActive(preferred ?? list[0]);
  }, [list, active, setActive, preferredWorkspaceId, requiresWorkspaceSelection]);

  function handleSwitch(ws: Workspace) {
    setOpen(false);
    if (ws.id === active?.id) return;
    switchMutation.mutate(ws.id);
  }

  const triggerCollapsed = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={active?.name ?? t('layout.workspace.fallbackName')}
          className={cn(
            'window-no-drag flex h-7 w-7 items-center justify-center rounded-md transition-colors',
            'hover:bg-surface-hover',
            open && 'bg-surface-active',
          )}
        >
          <WorkspaceAvatar workspace={active} size="sm" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {active?.name ?? 'Orkestral'}
      </TooltipContent>
    </Tooltip>
  );

  const triggerExpanded = (
    <button
      type="button"
      className={cn(
        'window-no-drag flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
        'hover:bg-surface-hover',
        open && 'bg-surface-active',
      )}
    >
      <WorkspaceAvatar workspace={active} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
        {active?.name ?? 'Orkestral'}
      </span>
      <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
    </button>
  );

  return (
    <div className={cn(collapsed ? 'flex justify-center' : 'px-2')}>
      <div
        className={cn(
          collapsed
            ? 'contents'
            : 'flex items-center gap-1 rounded-lg border border-border bg-surface-elevated/40 p-1 shadow-sm shadow-black/20',
        )}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{collapsed ? triggerCollapsed : triggerExpanded}</PopoverTrigger>
          <PopoverContent align="start" sideOffset={6} className="w-[268px] p-1">
            {/* Header da seção */}
            <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-text-faint">
                {t('layout.workspace.switch')}
              </span>
              <button
                type="button"
                className="flex items-center gap-1 rounded text-[11px] text-text-muted hover:text-text-primary"
                onClick={() => {
                  setOpen(false);
                  openSettings('team');
                }}
              >
                <Pencil className="h-3 w-3" />
                {t('layout.workspace.edit')}
              </button>
            </div>

            {/* Lista de workspaces */}
            <div className="flex flex-col">
              {list.map((ws) => {
                const isActive = ws.id === active?.id;
                return (
                  <button
                    key={ws.id}
                    type="button"
                    onClick={() => handleSwitch(ws)}
                    className={cn(
                      'flex items-center gap-2.5 rounded px-2 py-1.5 text-left transition-colors',
                      'hover:bg-surface-active',
                      isActive && 'bg-surface-hover',
                    )}
                  >
                    <WorkspaceAvatar workspace={ws} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                      {ws.name}
                    </span>
                    <span className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                      {workspaceCode(ws.name)}
                    </span>
                    {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-text-primary" />}
                  </button>
                );
              })}
            </div>

            <Separator />

            <SwitcherItem
              icon={Plus}
              label={t('layout.workspace.add')}
              onClick={() => {
                setOpen(false);
                setWizardOpen(true);
              }}
            />

            <Separator />

            <SwitcherItem
              icon={UserPlus}
              label={t('layout.workspace.invite', {
                name: active?.name ?? t('layout.workspace.fallbackInviteTarget'),
              })}
              onClick={() => {
                setOpen(false);
                openSettings('team');
              }}
            />
            <SwitcherItem
              icon={Cog}
              label={t('layout.workspace.settings')}
              onClick={() => {
                setOpen(false);
                openSettings('workspace');
              }}
            />

            <Separator />

            <SwitcherItem
              icon={LogOut}
              label={t('layout.workspace.logout')}
              destructive
              onClick={() => {
                setOpen(false);
                logoutMutation.mutate();
              }}
            />
          </PopoverContent>
        </Popover>
      </div>

      <CreateWorkspaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </div>
  );
}

interface SwitcherItemProps {
  icon: typeof Plus;
  label: string;
  destructive?: boolean;
  onClick?: () => void;
}

function SwitcherItem({ icon: Icon, label, destructive, onClick }: SwitcherItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-[12.5px] transition-colors',
        destructive
          ? 'text-accent-red hover:bg-accent-red/10'
          : 'text-text-secondary hover:bg-surface-active hover:text-text-primary',
      )}
    >
      <Icon className="h-3.5 w-3.5 opacity-80" />
      <span className="flex-1 truncate text-left">{label}</span>
    </button>
  );
}

function Separator() {
  return <div className="my-1 h-px bg-border" />;
}
