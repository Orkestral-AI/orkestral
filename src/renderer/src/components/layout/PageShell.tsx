import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * Container "inset" estilo shadcn: padding ao redor, card com border + radius.
 * Usado em todas as páginas que têm header e conteúdo (não no Home/chat fullbleed).
 */
interface PageShellProps {
  title: string;
  description?: string;
  headerRight?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function PageShell({
  title,
  description,
  headerRight,
  children,
  className,
  contentClassName,
}: PageShellProps) {
  return (
    // Mesmo inset das demais páginas (pl-2 pr-4 pt-4 pb-4 + header px-8 py-5, título 18px).
    <div className={cn('flex h-full flex-col pb-4 pl-2 pr-4 pt-4', className)}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <header className="window-drag flex shrink-0 items-center justify-between border-b border-hairline-soft px-8 py-5">
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-semibold tracking-tight text-text-primary">
              {title}
            </h1>
            {description && (
              <p className="mt-0.5 truncate text-[12.5px] text-text-muted">{description}</p>
            )}
          </div>
          {headerRight && <div className="ml-4 shrink-0">{headerRight}</div>}
        </header>

        <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', contentClassName)}>
          {children}
        </div>
      </div>
    </div>
  );
}
