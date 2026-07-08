import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@renderer/lib/utils';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          'flex min-h-[64px] w-full rounded-md border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 py-2 text-sm text-text-primary placeholder:text-text-muted resize-none',
          'transition-colors focus-visible:outline-none focus-visible:border-[var(--color-input-border-focus)] focus-visible:ring-1 focus-visible:ring-hairline-strong',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';
