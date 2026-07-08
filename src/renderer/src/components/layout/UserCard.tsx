import { useState } from 'react';
import {
  CircleUserRound,
  Cog,
  MessageCircleQuestion,
  LifeBuoy,
  GitBranch,
  LogOut,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { SidebarToggle } from './SidebarToggle';
import { useUIStore } from '@renderer/stores/uiStore';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';

const REPO_URL = 'https://github.com/Orkestral-AI/orkestral';

interface UserCardProps {
  name: string;
  plan: string;
  email?: string;
  onOpenSettings?: () => void;
  onLogout?: () => void;
  /** Trilho 1 (barra fina): só o avatar + popover, sem nome/plano nem o toggle. */
  avatarOnly?: boolean;
}

export function UserCard({
  name,
  plan,
  email,
  onOpenSettings,
  onLogout,
  avatarOnly,
}: UserCardProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const compact = avatarOnly || collapsed;
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  const avatar = (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface-elevated text-[12px] font-medium text-text-primary">
      {initial}
    </span>
  );

  const collapsedAvatar = (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-elevated text-[11px] font-medium text-text-primary">
      {initial}
    </span>
  );

  const triggerCollapsed = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={name}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
            'hover:bg-surface-hover',
            open && 'bg-surface-active',
          )}
        >
          {collapsedAvatar}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        <div className="flex flex-col">
          <span className="font-medium">{name}</span>
          <span className="text-[10px] text-text-muted">{plan}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );

  const triggerExpanded = (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors',
        'hover:bg-surface-hover',
        open && 'bg-surface-active',
      )}
    >
      {avatar}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-text-primary">{name}</span>
        <span className="block truncate text-[11px] text-text-muted">{plan}</span>
      </span>
    </button>
  );

  const popover = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{compact ? triggerCollapsed : triggerExpanded}</PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-[252px] p-1">
        {email && (
          <div className="px-2 pt-1.5 pb-2 text-[11px] text-text-muted truncate">{email}</div>
        )}
        <UserMenuItem
          icon={Cog}
          label={t('layout.user.settings')}
          shortcut="⌘,"
          onClick={() => {
            setOpen(false);
            onOpenSettings?.();
          }}
        />
        <div className="my-1 h-px bg-border" />
        <UserMenuItem
          icon={MessageCircleQuestion}
          label={t('layout.user.sendFeedback')}
          onClick={() => {
            setOpen(false);
            window.open(`${REPO_URL}/issues/new`, '_blank');
          }}
        />
        <UserMenuItem
          icon={LifeBuoy}
          label={t('layout.user.helpCenter')}
          onClick={() => {
            setOpen(false);
            window.open(REPO_URL, '_blank');
          }}
        />
        <UserMenuItem
          icon={GitBranch}
          label={t('layout.user.changelog')}
          onClick={() => {
            setOpen(false);
            window.open(`${REPO_URL}/releases`, '_blank');
          }}
        />
        <div className="my-1 h-px bg-border" />
        <UserMenuItem
          icon={LogOut}
          label={t('layout.user.logout')}
          onClick={() => {
            setOpen(false);
            onLogout?.();
          }}
        />
      </PopoverContent>
    </Popover>
  );

  // Trilho 1: só o avatar + menu (o recolher fica no header do trilho 2).
  if (avatarOnly) return popover;

  // Linha do rodapé: avatar/info do usuário + toggle de colapsar ao lado.
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1">
        {popover}
        <SidebarToggle />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">{popover}</div>
      <SidebarToggle />
    </div>
  );
}

interface MenuItemProps {
  icon: typeof CircleUserRound;
  label: string;
  shortcut?: string;
  onClick?: () => void;
}

function UserMenuItem({ icon: Icon, label, shortcut, onClick }: MenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-[12.5px] text-text-secondary hover:bg-surface-active hover:text-text-primary"
    >
      <Icon className="h-3.5 w-3.5 opacity-80" />
      <span className="flex-1 text-left">{label}</span>
      {shortcut && <span className="text-[10px] font-mono text-text-faint">{shortcut}</span>}
    </button>
  );
}
