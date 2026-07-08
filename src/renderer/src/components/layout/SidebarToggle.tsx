import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useUIStore } from '@renderer/stores/uiStore';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';

/**
 * Botão que colapsa / descolapsa a sidebar. Fica ao lado do WorkspaceSwitcher
 * quando expandida, ou abaixo dele quando colapsada.
 */
export function SidebarToggle({ className }: { className?: string }) {
  const { t } = useT();
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggle = useUIStore((s) => s.toggleSidebar);
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const label = collapsed ? t('layout.sidebar.expandSidebar') : t('layout.sidebar.collapseSidebar');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={toggle}
          className={cn(
            'window-no-drag grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors',
            'hover:bg-surface-1 hover:text-text-primary',
            className,
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={collapsed ? 'right' : 'bottom'} sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
