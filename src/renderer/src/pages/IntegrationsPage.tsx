import { useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Search,
  Slack,
  Trello,
  ListChecks,
  Calendar,
  Mail,
  BookText,
  Github,
  AudioLines,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { GithubIntegrationCard } from '@renderer/components/integrations/GithubIntegrationCard';
import { VoiceIntegrationCard } from '@renderer/components/integrations/VoiceIntegrationCard';
import { SentryIntegrationCard } from '@renderer/components/integrations/SentryIntegrationCard';
import { ObservabilityIntegrationCard } from '@renderer/components/integrations/ObservabilityIntegrationCard';
import { IntegrationCardShell } from '@renderer/components/integrations/IntegrationCardShell';
import { SentryIcon } from '@renderer/components/brand-icons';
import { useT, type TFunction } from '@renderer/i18n';

const GRID_COLS = { gridTemplateColumns: 'repeat(auto-fill, minmax(258px, 1fr))' };

interface IntegrationItem {
  id: string;
  icon: LucideIcon;
  name: string;
  description: string;
  category: string;
  soon: boolean;
}

function buildItems(t: TFunction): IntegrationItem[] {
  return [
    {
      id: 'github',
      icon: Github,
      name: t('pages.integrations.github.name'),
      description: t('pages.integrations.github.description'),
      category: t('pages.integrations.github.category'),
      soon: false,
    },
    {
      id: 'voice',
      icon: AudioLines,
      name: t('pages.integrations.voice.name'),
      description: t('pages.integrations.voice.description'),
      category: t('pages.integrations.voice.category'),
      soon: false,
    },
    {
      id: 'sentry',
      icon: SentryIcon as unknown as LucideIcon,
      name: t('pages.integrations.sentry.name'),
      description: t('pages.integrations.sentry.description'),
      category: t('pages.integrations.sentry.category'),
      soon: false,
    },
    {
      id: 'new_relic',
      icon: ListChecks,
      name: 'New Relic',
      description: 'Erros, logs e métricas via NerdGraph/NRQL.',
      category: 'Observability',
      soon: false,
    },
    {
      id: 'better_stack',
      icon: ListChecks,
      name: 'Better Stack',
      description: 'Incidentes, uptime e logs para investigação.',
      category: 'Observability',
      soon: false,
    },
    {
      id: 'slack',
      icon: Slack,
      name: t('pages.integrations.slack.name'),
      description: t('pages.integrations.slack.description'),
      category: t('pages.integrations.slack.category'),
      soon: true,
    },
    {
      id: 'jira',
      icon: Trello,
      name: t('pages.integrations.jira.name'),
      description: t('pages.integrations.jira.description'),
      category: t('pages.integrations.jira.category'),
      soon: true,
    },
    {
      id: 'clickup',
      icon: ListChecks,
      name: t('pages.integrations.clickup.name'),
      description: t('pages.integrations.clickup.description'),
      category: t('pages.integrations.clickup.category'),
      soon: true,
    },
    {
      id: 'gcal',
      icon: Calendar,
      name: t('pages.integrations.gcal.name'),
      description: t('pages.integrations.gcal.description'),
      category: t('pages.integrations.gcal.category'),
      soon: true,
    },
    {
      id: 'gmail',
      icon: Mail,
      name: t('pages.integrations.gmail.name'),
      description: t('pages.integrations.gmail.description'),
      category: t('pages.integrations.gmail.category'),
      soon: true,
    },
    {
      id: 'notion',
      icon: BookText,
      name: t('pages.integrations.notion.name'),
      description: t('pages.integrations.notion.description'),
      category: t('pages.integrations.notion.category'),
      soon: true,
    },
  ];
}

export function IntegrationsPage() {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');

  const items = useMemo(() => buildItems(t), [t]);
  const categories = useMemo(() => [...new Set(items.map((i) => i.category))], [items]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        (category === 'all' || i.category === category) &&
        (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)),
    );
  }, [items, query, category]);

  return (
    <PageShell>
      {/* Header — igual ao MCPs */}
      <div className="window-drag flex items-end justify-between border-b border-hairline-soft px-8 pt-5">
        <div className="pb-3">
          <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">
            {t('pages.integrations.title')}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-text-muted">{t('pages.integrations.subtitle')}</p>
        </div>
      </div>

      {/* Busca + categorias */}
      <div className="shrink-0 border-b border-hairline-faint px-6 py-3.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('pages.integrations.searchPlaceholder')}
            className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle pl-10 pr-9 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
          />
        </div>
        <div className="no-scrollbar mt-3 flex items-center gap-1.5 overflow-x-auto pb-0.5">
          <Chip active={category === 'all'} onClick={() => setCategory('all')}>
            {t('pages.integrations.all')}
          </Chip>
          {categories.map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
              {c}
            </Chip>
          ))}
        </div>
      </div>

      {/* Conteúdo */}
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-[13px] text-text-secondary">
              {t('pages.integrations.nothingFound')}
            </div>
            <div className="mt-1 text-[12px] text-text-muted">
              {t('pages.integrations.tryAnotherTerm')}
            </div>
          </div>
        ) : (
          <div className="grid gap-3" style={GRID_COLS}>
            {filtered.map((it) =>
              it.id === 'github' ? (
                <GithubIntegrationCard key={it.id} />
              ) : it.id === 'voice' ? (
                <VoiceIntegrationCard key={it.id} />
              ) : it.id === 'sentry' ? (
                <SentryIntegrationCard key={it.id} />
              ) : it.id === 'new_relic' ? (
                <ObservabilityIntegrationCard key={it.id} provider="new_relic" />
              ) : it.id === 'better_stack' ? (
                <ObservabilityIntegrationCard key={it.id} provider="better_stack" />
              ) : (
                <IntegrationCardShell
                  key={it.id}
                  icon={it.icon}
                  name={it.name}
                  description={it.description}
                  category={it.category}
                  muted={it.soon}
                  action={
                    <span className="rounded-md border border-hairline-strong px-2 py-1 text-[11px] text-text-faint">
                      {t('pages.integrations.comingSoon')}
                    </span>
                  }
                />
              ),
            )}
          </div>
        )}
      </div>
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

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'border-accent-purple/40 bg-accent-purple/[0.12] text-text-primary'
          : 'border-hairline bg-surface-faint text-text-muted hover:bg-surface-2 hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}
