import { ArrowDown, ArrowUp, Minus, AlertOctagon } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';

export type IssuePriority = 'critical' | 'high' | 'medium' | 'low';

const PRIORITY_CONFIG: Record<IssuePriority, { icon: typeof ArrowUp; text: string }> = {
  critical: { icon: AlertOctagon, text: 'text-priority-critical' },
  high: { icon: ArrowUp, text: 'text-priority-high' },
  medium: { icon: Minus, text: 'text-priority-medium' },
  low: { icon: ArrowDown, text: 'text-priority-low' },
};

export function PriorityBadge({
  priority,
  className,
  showLabel = true,
}: {
  priority: IssuePriority;
  className?: string;
  showLabel?: boolean;
}) {
  const { t } = useT();
  const cfg = PRIORITY_CONFIG[priority];
  const Icon = cfg.icon;
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-[11px] font-medium', cfg.text, className)}
    >
      <Icon className="h-3 w-3" />
      {showLabel && t(`badges.priority.${priority}`)}
    </span>
  );
}
