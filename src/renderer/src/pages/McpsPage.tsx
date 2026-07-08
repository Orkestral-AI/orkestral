import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Store, Boxes } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { MarketplaceBrowser } from '@renderer/components/marketplace/MarketplaceBrowser';
import { InstalledManager } from '@renderer/components/marketplace/InstalledManager';
import { readInstalledMeta } from '@renderer/components/marketplace/shared';
import { useT } from '@renderer/i18n';

type Tab = 'marketplace' | 'installed';

export function McpsPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const [tab, setTab] = useState<Tab>('marketplace');

  const skillsQuery = useQuery({
    queryKey: ['skills', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['skill:list']({ workspaceId: activeWorkspace!.id }),
  });
  const installedCount = (skillsQuery.data ?? []).filter(
    (s) => s.kind === 'mcp' && readInstalledMeta(s),
  ).length;

  if (!activeWorkspace) {
    return (
      <PageShell>
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.mcps.noActiveWorkspace')}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="window-drag flex items-end justify-between border-b border-hairline-soft px-8 pt-5">
        <div className="pb-3">
          <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">
            {t('pages.mcps.title')}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-text-muted">{t('pages.mcps.subtitle')}</p>
        </div>
        <div className="window-no-drag flex items-center gap-1">
          <TabButton
            icon={Store}
            active={tab === 'marketplace'}
            onClick={() => setTab('marketplace')}
          >
            {t('pages.mcps.tabMarketplace')}
          </TabButton>
          <TabButton
            icon={Boxes}
            active={tab === 'installed'}
            onClick={() => setTab('installed')}
            badge={installedCount || undefined}
          >
            {t('pages.mcps.tabInstalled')}
          </TabButton>
        </div>
      </div>

      {tab === 'marketplace' ? (
        <MarketplaceBrowser kind="mcp" workspaceId={activeWorkspace.id} />
      ) : (
        <InstalledManager kind="mcp" workspaceId={activeWorkspace.id} />
      )}
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {children}
      </div>
    </div>
  );
}

function TabButton({
  icon: Icon,
  active,
  onClick,
  badge,
  children,
}: {
  icon: typeof Store;
  active: boolean;
  onClick: () => void;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center gap-1.5 border-b-2 px-3 pb-3 pt-2 text-[13px] font-medium transition-colors',
        active
          ? 'border-accent-purple text-text-primary'
          : 'border-transparent text-text-muted hover:text-text-secondary',
      )}
    >
      <Icon className="h-4 w-4" />
      {children}
      {badge !== undefined && (
        <span className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-surface-strong px-1 text-[10px] font-semibold text-text-secondary">
          {badge}
        </span>
      )}
    </button>
  );
}
