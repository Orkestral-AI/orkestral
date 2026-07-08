import { NavLink, type NavLinkProps } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { useUIStore } from '@renderer/stores/uiStore';
import { cn } from '@renderer/lib/utils';

interface SidebarItemProps extends Omit<NavLinkProps, 'children' | 'className'> {
  icon?: LucideIcon;
  label: string;
  badge?: ReactNode;
  shortcut?: string;
  indent?: boolean;
}

export function SidebarItem({
  icon: Icon,
  label,
  badge,
  shortcut,
  indent,
  ...props
}: SidebarItemProps) {
  const collapsed = useUIStore((s) => s.sidebarCollapsed);

  const navLink = collapsed ? (
    <NavLink
      {...props}
      className={({ isActive }) =>
        cn(
          'group relative my-0.5 flex h-9 w-9 items-center justify-center rounded-md text-text-secondary transition-colors',
          'hover:bg-surface-1 hover:text-text-primary',
          isActive && 'bg-surface-active text-text-primary',
        )
      }
    >
      {Icon && <Icon className="h-4 w-4 opacity-80" />}
      {/* Badge no colapsado vira um dot no canto — não vaza o layout. */}
      {badge != null && (
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-sidebar" />
      )}
    </NavLink>
  ) : (
    <NavLink
      {...props}
      className={({ isActive }) =>
        cn(
          'group my-[3px] flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-text-secondary transition-colors',
          'hover:bg-surface-1 hover:text-text-primary',
          isActive && 'bg-surface-active text-text-primary',
          indent && 'pl-7',
        )
      }
    >
      {Icon && <Icon className="h-4 w-4 shrink-0 opacity-80" />}
      <span className="flex-1 truncate">{label}</span>
      {badge}
      {shortcut && (
        <span className="text-[10px] font-mono text-text-faint group-hover:text-text-muted">
          {shortcut}
        </span>
      )}
    </NavLink>
  );

  if (!collapsed) return navLink;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{navLink}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        <div className="flex items-center gap-2">
          <span>{label}</span>
          {shortcut && <span className="text-[10px] font-mono text-text-muted">{shortcut}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Ícone na sidebar colapsada que abre um flyout à direita com sub-opções
 * (Sources, Base de conhecimento, Agentes). Em vez de expandir inline (sem
 * espaço no modo colapsado), abre um popover ancorado à direita do ícone.
 */
export function SidebarFlyout({
  icon: Icon,
  label,
  badge,
  active,
  children,
}: {
  icon: LucideIcon;
  label: string;
  badge?: ReactNode;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'group relative my-0.5 flex h-9 w-9 items-center justify-center rounded-md text-text-secondary transition-colors',
                'hover:bg-surface-1 hover:text-text-primary data-[state=open]:bg-surface-active data-[state=open]:text-text-primary',
                active && 'bg-surface-active text-text-primary',
              )}
            >
              <Icon className="h-4 w-4 opacity-80" />
              {badge != null && (
                <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-sidebar" />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10}>
          {label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="start" sideOffset={8} className="w-60 p-1.5">
        <div className="px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-text-faint">
          {label}
        </div>
        <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

export function SidebarSectionLabel({
  children,
  action,
}: {
  children: ReactNode;
  /** Botão sutil renderizado à direita do label (ex: + pra criar). */
  action?: {
    icon: LucideIcon;
    tooltip: string;
    onClick: () => void;
    /** Quando true, fica sempre visível (não só no hover da seção). */
    alwaysVisible?: boolean;
  };
}) {
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  if (collapsed) return <div className="my-2 h-px w-6 bg-border" />;
  const ActionIcon = action?.icon;
  return (
    <div className="group/section flex items-center justify-between px-2 pt-4 pb-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-text-faint">
        {children}
      </span>
      {action && ActionIcon && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={action.onClick}
              className={cn(
                'grid h-4 w-4 place-items-center rounded text-text-faint transition-all hover:bg-surface-2 hover:text-text-primary',
                action.alwaysVisible
                  ? 'opacity-70 hover:opacity-100'
                  : 'opacity-0 group-hover/section:opacity-100',
              )}
            >
              <ActionIcon className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={6}>
            {action.tooltip}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
