import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * Shell visual de um card de integração — espelha o MarketplaceCard dos MCPs
 * (icon box + nome no topo, descrição, footer com categoria + ação).
 */
export function IntegrationCardShell({
  icon: Icon,
  name,
  description,
  category,
  badge,
  action,
  muted,
  footerOverride,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  category?: string;
  badge?: ReactNode;
  action?: ReactNode;
  muted?: boolean;
  footerOverride?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'group relative flex h-full flex-col rounded-xl border border-hairline-med bg-surface-veil p-4 transition-colors',
        muted ? 'opacity-60' : 'hover:border-hairline-bright hover:bg-surface-3',
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-hairline-strong bg-surface-1 text-text-secondary">
          <Icon className="h-[15px] w-[15px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-text-primary">{name}</div>
        </div>
        {badge}
      </div>

      <p className="mt-2.5 line-clamp-2 flex-1 text-[12px] leading-relaxed text-text-muted">
        {description}
      </p>

      {footerOverride ? (
        <div className="mt-3.5">{footerOverride}</div>
      ) : (
        <div className="mt-3.5 flex items-center justify-between gap-2">
          {category ? (
            <span className="truncate rounded border border-hairline-heavy bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-text-secondary">
              {category}
            </span>
          ) : (
            <span />
          )}
          {action && <div className="flex shrink-0 items-center gap-2.5">{action}</div>}
        </div>
      )}
    </div>
  );
}
