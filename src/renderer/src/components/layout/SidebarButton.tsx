import type { LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useUIStore } from '@renderer/stores/uiStore';
import { cn } from '@renderer/lib/utils';

interface SidebarButtonProps {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  onClick?: () => void;
}

/**
 * Item de sidebar não-navegável (botão). Mesma estética do SidebarItem.
 */
export function SidebarButton({ icon: Icon, label, shortcut, onClick }: SidebarButtonProps) {
  const collapsed = useUIStore((s) => s.sidebarCollapsed);

  const btn = collapsed ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group my-0.5 flex h-9 w-9 items-center justify-center rounded-md text-text-secondary transition-colors',
        'hover:bg-surface-1 hover:text-text-primary',
      )}
    >
      <Icon className="h-4 w-4 opacity-80" />
    </button>
  ) : (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group my-[3px] flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-text-secondary transition-colors',
        'hover:bg-surface-1 hover:text-text-primary',
      )}
    >
      <Icon className="h-4 w-4 shrink-0 opacity-80" />
      <span className="flex-1 text-left">{label}</span>
      {shortcut && (
        <span className="text-[10px] font-mono text-text-faint group-hover:text-text-muted">
          {shortcut}
        </span>
      )}
    </button>
  );

  if (!collapsed) return btn;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        <div className="flex items-center gap-2">
          <span>{label}</span>
          {shortcut && <span className="text-[10px] font-mono text-text-muted">{shortcut}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
