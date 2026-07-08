import { forwardRef, useEffect, useRef } from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  indeterminate?: boolean;
};

/**
 * Checkbox theme-aware. `appearance-none` remove o desenho nativo (a caixa
 * branca do SO), então o estado desmarcado fica com FUNDO TRANSPARENTE e só a
 * BORDA arredondada. Marcado/indeterminado preenche com o accent do workspace e
 * mostra um ícone branco sobreposto.
 */
export const Checkbox = forwardRef<HTMLInputElement, Props>(function Checkbox(
  { indeterminate = false, className, ...rest },
  forwardedRef,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <span
      className={cn('relative inline-grid h-3.5 w-3.5 shrink-0 place-content-center', className)}
    >
      <input
        type="checkbox"
        ref={(node) => {
          innerRef.current = node;
          if (typeof forwardedRef === 'function') forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        className={cn(
          'peer h-3.5 w-3.5 shrink-0 cursor-pointer appearance-none rounded-[4px]',
          'border border-border bg-transparent transition-colors hover:border-border-strong',
          'checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-purple/40',
        )}
        {...rest}
      />
      {/* Marcador sobreposto — transparente até marcar/indeterminar. */}
      <span className="pointer-events-none absolute inset-0 grid place-content-center text-white opacity-0 peer-checked:opacity-100 peer-[:indeterminate]:opacity-100">
        {indeterminate ? (
          <Minus className="h-2.5 w-2.5" strokeWidth={3.5} />
        ) : (
          <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
        )}
      </span>
    </span>
  );
});
