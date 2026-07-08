import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@renderer/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none',
  {
    variants: {
      variant: {
        default: 'bg-surface-elevated text-text-secondary border border-border',
        muted: 'bg-transparent text-text-muted',
        purple: 'bg-accent-purple/15 text-accent-purple border border-accent-purple/25',
        blue: 'bg-accent-blue/15 text-accent-blue border border-accent-blue/25',
        green: 'bg-accent-green/15 text-accent-green border border-accent-green/25',
        yellow: 'bg-accent-yellow/15 text-accent-yellow border border-accent-yellow/25',
        red: 'bg-accent-red/15 text-accent-red border border-accent-red/25',
        orange: 'bg-accent-orange/15 text-accent-orange border border-accent-orange/25',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
