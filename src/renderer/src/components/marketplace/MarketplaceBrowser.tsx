import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { Search, Sparkles, PackageOpen, Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { MarketplaceCard } from './MarketplaceCard';
import { ItemDetailDialog } from './ItemDetailDialog';
import { AssignAgentsDialog } from './AssignAgentsDialog';
import { buildInstalledIndex, deriveScopeOptions, type MarketplaceCatalogItem } from './shared';

interface MarketplaceBrowserProps {
  kind: 'mcp' | 'skill';
  workspaceId: string;
}

/** Browser do marketplace: busca + categorias + destaques + grade com infinite scroll. */
export function MarketplaceBrowser({ kind, workspaceId }: MarketplaceBrowserProps) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [selected, setSelected] = useState<MarketplaceCatalogItem | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [assignItem, setAssignItem] = useState<MarketplaceCatalogItem | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce: a busca alcança o registro vivo (PulseMCP) no main process, então
  // não disparamos a cada tecla.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const browseQuery = useInfiniteQuery({
    queryKey: ['marketplace-browse', kind, debouncedQuery],
    queryFn: ({ pageParam }) =>
      window.orkestral['marketplace:browse']({
        kind,
        query: debouncedQuery || undefined,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    placeholderData: keepPreviousData,
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = browseQuery;

  const skillsQuery = useQuery({
    queryKey: ['skills', workspaceId],
    queryFn: () => window.orkestral['skill:list']({ workspaceId }),
  });
  const agentsQuery = useQuery({
    queryKey: ['agents', workspaceId],
    queryFn: () => window.orkestral['agent:list']({ workspaceId }),
  });

  // Achata as páginas e remove duplicatas por id (curados só vêm na página 0).
  const items = useMemo(() => {
    const out: MarketplaceCatalogItem[] = [];
    const seen = new Set<string>();
    for (const page of browseQuery.data?.pages ?? []) {
      for (const it of page.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
    }
    return out;
  }, [browseQuery.data]);

  const installedIndex = useMemo(
    () => buildInstalledIndex(skillsQuery.data ?? []),
    [skillsQuery.data],
  );
  const scopeOptions = useMemo(
    () => deriveScopeOptions(agentsQuery.data ?? [], t),
    [agentsQuery.data, t],
  );

  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const it of items) {
      const c = it.category ?? 'Outros';
      if (!seen.includes(c)) seen.push(c);
    }
    return seen;
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (category !== 'all' && (it.category ?? 'Outros') !== category) return false;
      if (!q) return true;
      const hay = [it.name, it.description, it.author ?? '', ...(it.tags ?? [])]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, query, category]);

  const showFeatured = category === 'all' && !query.trim();
  const featured = useMemo(() => filtered.filter((it) => it.featured), [filtered]);
  const mainList = useMemo(
    () => (showFeatured ? filtered.filter((it) => !it.featured) : filtered),
    [filtered, showFeatured],
  );

  // Infinite scroll via scroll handler (mais confiável que IntersectionObserver
  // dentro de containers no Electron). Carrega a próxima página perto do fim.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    if (!hasNextPage || isFetchingNextPage) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 700) fetchNextPage();
  }

  function refetch() {
    queryClient.invalidateQueries({ queryKey: ['skills', workspaceId] });
    queryClient.invalidateQueries({ queryKey: ['skills'] });
  }

  function openItem(item: MarketplaceCatalogItem) {
    setSelected(item);
    setDialogOpen(true);
  }

  /** Botão "Instalar" do card: itens com credencial obrigatória abrem o detalhe
   *  (pra preencher creds); o resto abre direto o modal de atribuição, que
   *  instala de fato ao confirmar. */
  function handleCardInstall(item: MarketplaceCatalogItem) {
    const needsCreds =
      item.kind === 'mcp' && (item.requiredEnv ?? []).some((r) => r.required !== false);
    if (needsCreds) openItem(item);
    else setAssignItem(item);
  }

  const GRID_COLS = { gridTemplateColumns: 'repeat(auto-fill, minmax(258px, 1fr))' };

  const renderGrid = (list: MarketplaceCatalogItem[]) => (
    <div className="grid gap-3" style={GRID_COLS}>
      {list.map((it) => (
        <MarketplaceCard
          key={it.id}
          item={it}
          installed={installedIndex.has(it.id)}
          installing={false}
          onOpen={() => openItem(it)}
          onInstall={() => handleCardInstall(it)}
        />
      ))}
    </div>
  );

  // Primeira carga / nova busca: mostra skeleton em vez de piscar "Nada encontrado".
  const firstLoading = browseQuery.isPending || query.trim() !== debouncedQuery;
  const topFetching = browseQuery.isFetching && !isFetchingNextPage;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search + categorias */}
      <div className="shrink-0 border-b border-hairline-faint px-6 py-3.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              kind === 'mcp'
                ? t('pages.marketplace.searchMcp')
                : t('pages.marketplace.searchSkills')
            }
            className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle pl-10 pr-9 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
          />
          {topFetching && (
            <Loader2 className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-text-muted" />
          )}
        </div>
        {kind === 'mcp' && debouncedQuery && (
          <div className="mt-1.5 px-0.5 text-[10.5px] text-text-faint">
            {t('pages.marketplace.registryHint')}
          </div>
        )}
        <div className="no-scrollbar mt-3 flex items-center gap-1.5 overflow-x-auto pb-0.5">
          <Chip active={category === 'all'} onClick={() => setCategory('all')}>
            {t('pages.marketplace.all')}
          </Chip>
          {categories.map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
              {c}
            </Chip>
          ))}
        </div>
      </div>

      {/* Conteúdo */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5"
      >
        {filtered.length === 0 && firstLoading ? (
          <SkeletonGrid cols={GRID_COLS} />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <PackageOpen className="h-8 w-8 text-text-faint" />
            <div className="mt-3 text-[13px] text-text-secondary">
              {t('pages.marketplace.nothingFound')}
            </div>
            <div className="mt-1 text-[12px] text-text-muted">
              {t('pages.marketplace.tryAnotherTerm')}
            </div>
          </div>
        ) : (
          <>
            {showFeatured && featured.length > 0 && (
              <section className="mb-7">
                <div className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  <Sparkles className="h-3.5 w-3.5 text-accent-yellow" />
                  {t('pages.marketplace.featured')}
                </div>
                {renderGrid(featured)}
              </section>
            )}
            <section>
              {showFeatured && featured.length > 0 && (
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  {t('pages.marketplace.all')}
                </div>
              )}
              {renderGrid(mainList)}
            </section>

            {/* Skeleton enquanto carrega a próxima página + sentinel do observer. */}
            {isFetchingNextPage && (
              <div className="mt-3">
                <SkeletonGrid cols={GRID_COLS} count={4} />
              </div>
            )}
          </>
        )}
      </div>

      <ItemDetailDialog
        workspaceId={workspaceId}
        item={selected}
        installedSkill={selected ? (installedIndex.get(selected.id) ?? null) : null}
        scopeOptions={scopeOptions}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onChanged={refetch}
      />
      <AssignAgentsDialog
        item={assignItem}
        workspaceId={workspaceId}
        open={assignItem !== null}
        onClose={() => setAssignItem(null)}
        onInstalled={refetch}
      />
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

/** Grade de placeholders enquanto a busca carrega — evita o flash de "vazio". */
function SkeletonGrid({ cols, count = 8 }: { cols: React.CSSProperties; count?: number }) {
  return (
    <div className="grid gap-3" style={cols}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex h-[132px] animate-pulse flex-col rounded-xl border border-hairline bg-surface-veil p-4"
        >
          <div className="flex items-center gap-2.5">
            <div className="h-7 w-7 rounded-md bg-surface-active" />
            <div className="h-3 w-28 rounded bg-surface-active" />
          </div>
          <div className="mt-3 h-2.5 w-full rounded bg-surface-1" />
          <div className="mt-2 h-2.5 w-3/4 rounded bg-surface-1" />
          <div className="mt-auto flex items-center justify-between">
            <div className="h-3.5 w-20 rounded bg-surface-2" />
            <div className="h-3 w-10 rounded bg-surface-1" />
          </div>
        </div>
      ))}
    </div>
  );
}
