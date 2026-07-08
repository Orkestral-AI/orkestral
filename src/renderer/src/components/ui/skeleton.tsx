import type { HTMLAttributes } from 'react';
import { cn } from '@renderer/lib/utils';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('animate-pulse rounded-md bg-surface-elevated', className)} {...props} />
  );
}
