import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';

export type IssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

const STATUS_CONFIG: Record<IssueStatus, { dot: string; text: string }> = {
  backlog: { dot: 'bg-status-backlog', text: 'text-text-secondary' },
  todo: { dot: 'bg-status-todo', text: 'text-text-primary' },
  in_progress: {
    dot: 'bg-status-in-progress',
    text: 'text-accent-blue',
  },
  in_review: { dot: 'bg-status-in-review', text: 'text-accent-purple' },
  blocked: { dot: 'bg-status-blocked', text: 'text-accent-red' },
  done: { dot: 'bg-status-done', text: 'text-accent-green' },
  cancelled: { dot: 'bg-status-cancelled', text: 'text-text-muted' },
};

export function StatusBadge({ status, className }: { status: IssueStatus; className?: string }) {
  const { t } = useT();
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] font-medium',
        cfg.text,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dot)} />
      {t(`badges.status.${status}`)}
    </span>
  );
}
