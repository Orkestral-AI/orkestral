import { Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

export function LoadingState({
  label = 'Carregando…',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-3 text-text-secondary',
        className,
      )}
    >
      <Loader2 className="h-5 w-5 animate-spin" />
      <p className="text-xs">{label}</p>
    </div>
  );
}
