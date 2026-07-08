import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, CircleDot, Bot, Wand2, MessageSquare, Heart, AlertCircle } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT } from '@renderer/i18n';
import type { ActivityEntry } from '@shared/types';

const KIND_META: Record<string, { icon: typeof Activity; color: string }> = {
  'issue.created': { icon: CircleDot, color: 'text-accent-green' },
  'issue.status_changed': { icon: CircleDot, color: 'text-accent-blue' },
  'agent.paused': { icon: Bot, color: 'text-accent-yellow' },
  'agent.resumed': { icon: Bot, color: 'text-accent-green' },
  'agent.created': { icon: Bot, color: 'text-text-secondary' },
  'skill.attached': { icon: Wand2, color: 'text-text-secondary' },
  'skill.detached': { icon: Wand2, color: 'text-text-muted' },
  'session.created': { icon: MessageSquare, color: 'text-text-secondary' },
  'heartbeat.run': { icon: Heart, color: 'text-accent-purple' },
  'heartbeat.failed': { icon: AlertCircle, color: 'text-accent-red' },
};

export function ActivityPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);

  const activityQuery = useQuery({
    queryKey: ['activity', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () =>
      window.orkestral['activity:list']({ workspaceId: activeWorkspace!.id, limit: 200 }),
    refetchInterval: 20_000,
  });

  const entries = activityQuery.data ?? [];

  return (
    <PageShell title={t('pages.activity.title')} description={t('pages.activity.description')}>
      {!activeWorkspace ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.activity.noActiveWorkspace')}
        </div>
      ) : activityQuery.isPending ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.activity.loading')}
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <Activity className="h-8 w-8 text-text-muted" />
          <div className="mt-3 text-[13px] font-medium text-text-primary">
            {t('pages.activity.noActivity')}
          </div>
          <div className="mt-1 max-w-md text-[12px] text-text-muted">
            {t('pages.activity.noActivityDesc')}
          </div>
        </div>
      ) : (
        <div className="thin-scrollbar flex-1 overflow-y-auto">
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function EntryRow({ entry }: { entry: ActivityEntry }) {
  const meta = KIND_META[entry.kind] ?? { icon: Activity, color: 'text-text-muted' };
  const Icon = meta.icon;
  return (
    <div className="flex items-start gap-3 border-b border-hairline-soft px-8 py-3">
      <div
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface-faint',
          meta.color,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-text-primary">{entry.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-text-faint">
          <span>{entry.actorKind}</span>
          <span>·</span>
          <span className="font-mono">{entry.kind}</span>
          <span>·</span>
          <span>{fmtAbsolute(entry.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

function PageShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <div className="window-drag border-b border-hairline-soft px-8 py-5">
          <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">{title}</h1>
          <p className="mt-0.5 text-[12.5px] text-text-muted">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function fmtAbsolute(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
