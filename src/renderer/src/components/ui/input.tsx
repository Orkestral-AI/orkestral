import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@renderer/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => {
  return (
    <input
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 py-1 text-sm text-text-primary placeholder:text-text-muted',
        'transition-colors focus-visible:outline-none focus-visible:border-[var(--color-input-border-focus)] focus-visible:ring-1 focus-visible:ring-hairline-strong',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
Input.displayName = 'Input';
