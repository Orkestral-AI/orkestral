import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { AdapterType } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { ProviderConfigCard } from '@renderer/components/providers/ProviderConfigCard';
import { LocalModelCard } from '@renderer/components/integrations/LocalModelCard';

const GRID_COLS = { gridTemplateColumns: 'repeat(auto-fill, minmax(258px, 1fr))' };

/**
 * Página PROVEDORES: configuração dos provedores de IA (CLI ou API key) + os modelos
 * locais (Forge, num card único com seletor de variante, e Embeddings). Os modelos
 * saíram de Integrações pra cá. Provedores listados = os mesmos do onboarding
 * (registry de adapters), exceto o Forge (que vira o card unificado).
 */
export function ProvidersPage() {
  const { t } = useT();
  const [query, setQuery] = useState('');

  const adaptersQuery = useQuery({
    queryKey: ['adapters'],
    queryFn: () => window.orkestral['adapter:list'](),
    staleTime: Infinity,
  });
  const keyStatusQuery = useQuery({
    queryKey: ['provider-key-status'],
    queryFn: () => window.orkestral['provider:key-status'](),
  });

  const keyStatusByType = useMemo(() => {
    const map = new Map<AdapterType, { supportsApiKey: boolean; apiKeyConfigured: boolean }>();
    for (const s of keyStatusQuery.data ?? []) {
      map.set(s.type, { supportsApiKey: s.supportsApiKey, apiKeyConfigured: s.apiKeyConfigured });
    }
    return map;
  }, [keyStatusQuery.data]);

  // Provedores configuráveis = todos do registry MENOS o Forge (orkestral_local), que
  // tem o card unificado próprio (modelo local, não tem CLI/API key).
  const providers = useMemo(
    () => (adaptersQuery.data ?? []).filter((d) => d.type !== 'orkestral_local'),
    [adaptersQuery.data],
  );

  const filteredProviders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter(
      (d) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q),
    );
  }, [providers, query]);

  // O bloco de MODELOS LOCAIS (Forge + Embeddings) aparece quando a busca casa "forge",
  // "embeddings", "modelo" ou está vazia.
  const showModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (
      !q ||
      ['forge', 'embeddings', 'fast-apply', 'fastapply', 'morph', 'modelo', 'model', 'local'].some(
        (w) => w.includes(q) || q.includes(w),
      )
    );
  }, [query]);

  return (
    <PageShell>
      <div className="window-drag flex items-end justify-between border-b border-hairline-soft px-8 pt-5">
        <div className="pb-3">
          <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">
            {t('pages.providers.title')}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-text-muted">{t('pages.providers.subtitle')}</p>
        </div>
      </div>

      <div className="shrink-0 border-b border-hairline-faint px-6 py-3.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('pages.providers.searchPlaceholder')}
            className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle pl-10 pr-9 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
          />
        </div>
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {showModels && (
          <>
            <SectionLabel>{t('pages.providers.localModels')}</SectionLabel>
            <div className="mb-6 grid gap-3" style={GRID_COLS}>
              <LocalModelCard model="fast-apply" />
              <LocalModelCard model="embeddings" />
            </div>
          </>
        )}

        {filteredProviders.length > 0 && (
          <>
            <SectionLabel>{t('pages.providers.aiProviders')}</SectionLabel>
            <div className="grid gap-3" style={GRID_COLS}>
              {filteredProviders.map((d) => (
                <ProviderConfigCard
                  key={d.type}
                  descriptor={d}
                  keyStatus={
                    keyStatusByType.get(d.type) ?? {
                      supportsApiKey: false,
                      apiKeyConfigured: false,
                    }
                  }
                />
              ))}
            </div>
          </>
        )}

        {filteredProviders.length === 0 && !showModels && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-[13px] text-text-secondary">
              {t('pages.providers.nothingFound')}
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-faint">
      {children}
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn('flex h-full flex-col pl-2 pr-4 pt-4 pb-4')}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {children}
      </div>
    </div>
  );
}
