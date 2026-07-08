import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@renderer/lib/utils';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * Switch leve sem dependência externa (estilo iOS / Littlebird).
 * Pode ser substituído por @radix-ui/react-switch quando precisarmos.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked = false, onCheckedChange, className, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hairline-strong',
          checked ? 'bg-accent-blue' : 'bg-[var(--color-switch-off)] border border-border',
          disabled && 'cursor-not-allowed opacity-50',
          className,
        )}
        {...props}
      >
        <span
          className={cn(
            'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
    );
  },
);
Switch.displayName = 'Switch';
