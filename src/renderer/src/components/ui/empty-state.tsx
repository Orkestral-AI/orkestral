import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col items-center justify-center px-6 py-12 text-center',
        className,
      )}
    >
      {Icon && (
        <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-text-muted">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <h3 className="text-sm font-medium text-text-primary">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-xs text-text-secondary">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
