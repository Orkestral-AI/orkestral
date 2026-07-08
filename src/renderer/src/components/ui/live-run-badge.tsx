import { cn } from '@renderer/lib/utils';

export function LiveRunBadge({
  label = 'Live',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-accent-green/30 bg-accent-green/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-green',
        className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-green opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent-green" />
      </span>
      {label}
    </span>
  );
}
