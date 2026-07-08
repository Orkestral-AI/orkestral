import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  GitPullRequestArrow,
  GitMerge,
  GitPullRequestClosed,
  ExternalLink,
  MessageSquare,
  Search,
  Loader2,
  Sparkles,
  AlertTriangle,
  Bug,
  Lightbulb,
  Shield,
  Palette,
  Zap,
  HelpCircle,
  Send,
  CheckCircle2,
  X,
  ThumbsUp,
  ThumbsDown,
  CircleDot,
  FileText,
  FileCode,
  FilePlus,
  FileMinus,
  FileSymlink,
  Layers,
  TestTube,
  TrendingUp,
  ChevronRight,
  ChevronDown,
  CornerDownRight,
  Bot,
  Square,
  Terminal,
  ArrowLeft,
  Calendar,
  Clock,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useUIStore } from '@renderer/stores/uiStore';
import { Github } from 'lucide-react';
import { useT, type TFunction } from '@renderer/i18n';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { CodeBlock } from '@renderer/components/chat/CodeBlock';
import { ROLE_META } from '@renderer/lib/role-meta';
import type {
  Agent,
  CodeReview,
  CodeReviewChangeKind,
  CodeReviewComment,
  CodeReviewCommentKind,
  CodeReviewEvent,
  CodeReviewFileChange,
  CodeReviewLinkedPr,
  GithubPullRequest,
  WorkspaceSourceRole,
} from '@shared/types';
import { createPortal } from 'react-dom';
import { Link2, Link2Off, GitBranch } from 'lucide-react';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';

const KIND_META: Record<
  CodeReviewCommentKind,
  { labelKey: string; icon: typeof Bug; color: string; bg: string; border: string }
> = {
  bug: {
    labelKey: 'pages.codeReviews.kindBug',
    icon: Bug,
    color: 'text-accent-red',
    bg: 'bg-accent-red/10',
    border: 'border-accent-red/25',
  },
  security: {
    labelKey: 'pages.codeReviews.kindSecurity',
    icon: Shield,
    color: 'text-accent-red',
    bg: 'bg-accent-red/10',
    border: 'border-accent-red/25',
  },
  performance: {
    labelKey: 'pages.codeReviews.kindPerformance',
    icon: Zap,
    color: 'text-accent-yellow',
    bg: 'bg-accent-yellow/10',
    border: 'border-accent-yellow/25',
  },
  suggestion: {
    labelKey: 'pages.codeReviews.kindSuggestion',
    icon: Lightbulb,
    color: 'text-accent-blue',
    bg: 'bg-accent-blue/10',
    border: 'border-accent-blue/25',
  },
  style: {
    labelKey: 'pages.codeReviews.kindStyle',
    icon: Palette,
    color: 'text-accent-purple',
    bg: 'bg-accent-purple/10',
    border: 'border-accent-purple/25',
  },
  question: {
    labelKey: 'pages.codeReviews.kindQuestion',
    icon: HelpCircle,
    color: 'text-text-secondary',
    bg: 'bg-surface-1',
    border: 'border-hairline-strong',
  },
};

const CHANGE_KIND_META: Record<CodeReviewChangeKind, { label: string; color: string }> = {
  feature: { label: 'feature', color: 'text-accent-green' },
  fix: { label: 'fix', color: 'text-accent-red' },
  refactor: { label: 'refactor', color: 'text-accent-blue' },
  docs: { label: 'docs', color: 'text-text-secondary' },
  test: { label: 'test', color: 'text-accent-purple' },
  chore: { label: 'chore', color: 'text-text-muted' },
  style: { label: 'style', color: 'text-accent-yellow' },
};

export function CodeReviewsPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'open' | 'closed' | 'all'>('open');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [reviewStatusFilter, setReviewStatusFilter] = useState<
    'all' | 'reviewed' | 'unreviewed' | 'analyzing' | 'failed'
  >('all');

  // PRs de todos os repos linkados — PAGINADO (infinite scroll) por estado.
  // Buscar SÓ uma página por repo evita o fetch de até 1000 PRs/repo upfront que
  // travava a tela com a API do GitHub. A key inclui `filter` → trocar de tab
  // (open/closed/all) começa do zero com o estado certo.
  const PRS_PAGE_SIZE = 30;
  const allPrsQuery = useInfiniteQuery({
    queryKey: ['source-prs-page', activeWorkspace?.id, filter],
    enabled: !!activeWorkspace,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      window.orkestral['source:list-prs-page']({
        workspaceId: activeWorkspace!.id,
        state: filter,
        page: pageParam,
        perPage: PRS_PAGE_SIZE,
      }),
    getNextPageParam: (lastPage, allPages) => (lastPage.hasMore ? allPages.length + 1 : undefined),
    refetchInterval: 60_000,
  });
  const reviewsQuery = useQuery({
    queryKey: ['code-reviews', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['code-review:list']({ workspaceId: activeWorkspace!.id }),
    refetchInterval: 6_000,
  });

  // Funde as páginas carregadas POR SOURCE (preserva "todos os PRs do source A"
  // ao achatar). hasMore/fetchNextPage controlam o infinite scroll.
  const sourceGroups = useMemo(() => {
    const pages = allPrsQuery.data?.pages ?? [];
    const bySource = new Map<string, (typeof pages)[number]['groups'][number]>();
    for (const pg of pages) {
      for (const g of pg.groups) {
        const existing = bySource.get(g.sourceId);
        if (existing) existing.prs.push(...g.prs);
        else bySource.set(g.sourceId, { ...g, prs: [...g.prs] });
      }
    }
    return [...bySource.values()];
  }, [allPrsQuery.data]);
  const reviews = useMemo(() => reviewsQuery.data ?? [], [reviewsQuery.data]);

  // PR enriquecido com info do source pra renderizar
  type PrWithSource = GithubPullRequest & {
    sourceId: string;
    sourceLabel: string;
    sourceRole: WorkspaceSourceRole | null;
    repoFullName: string;
  };

  const allPrs = useMemo<PrWithSource[]>(() => {
    const seen = new Set<string>();
    const out: PrWithSource[] = [];
    for (const g of sourceGroups) {
      for (const pr of g.prs) {
        // Dedup por (repo, número): um PR atualizado durante o scroll pode
        // reaparecer numa página seguinte (sort=updated). Mantém a 1ª ocorrência.
        const key = `${g.repoFullName}#${pr.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ...pr,
          sourceId: g.sourceId,
          sourceLabel: g.sourceLabel,
          sourceRole: g.sourceRole,
          repoFullName: g.repoFullName,
        });
      }
    }
    return out;
  }, [sourceGroups]);

  // Lookup: reviewId mais recente por (repoFullName, prNumber)
  const reviewsByPr = useMemo(() => {
    const m = new Map<string, CodeReview>();
    for (const r of reviews) {
      const key = `${r.repoFullName}#${r.prNumber}`;
      const existing = m.get(key);
      if (!existing || r.startedAt > existing.startedAt) m.set(key, r);
    }
    return m;
  }, [reviews]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allPrs.filter((pr) => {
      if (sourceFilter !== 'all' && pr.sourceId !== sourceFilter) return false;
      if (filter === 'open' && pr.state !== 'open') return false;
      if (filter === 'closed' && pr.state !== 'closed') return false;
      if (q && !pr.title.toLowerCase().includes(q) && !String(pr.number).includes(q)) return false;
      // Filtro de status de review
      if (reviewStatusFilter !== 'all') {
        const review = reviewsByPr.get(`${pr.repoFullName}#${pr.number}`);
        if (reviewStatusFilter === 'unreviewed' && review) return false;
        if (reviewStatusFilter === 'reviewed' && review?.status !== 'completed') return false;
        if (
          reviewStatusFilter === 'analyzing' &&
          review?.status !== 'analyzing' &&
          review?.status !== 'queued'
        )
          return false;
        if (reviewStatusFilter === 'failed' && review?.status !== 'failed') return false;
      }
      return true;
    });
  }, [allPrs, filter, query, sourceFilter, reviewStatusFilter, reviewsByPr]);

  // Contadores por status de review (na base já filtrada por source + state + query)
  const reviewStatusCounts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = allPrs.filter((pr) => {
      if (sourceFilter !== 'all' && pr.sourceId !== sourceFilter) return false;
      if (filter === 'open' && pr.state !== 'open') return false;
      if (filter === 'closed' && pr.state !== 'closed') return false;
      if (q && !pr.title.toLowerCase().includes(q) && !String(pr.number).includes(q)) return false;
      return true;
    });
    let reviewed = 0;
    let unreviewed = 0;
    let analyzing = 0;
    let failed = 0;
    for (const pr of base) {
      const r = reviewsByPr.get(`${pr.repoFullName}#${pr.number}`);
      if (!r) unreviewed++;
      else if (r.status === 'completed') reviewed++;
      else if (r.status === 'analyzing' || r.status === 'queued') analyzing++;
      else if (r.status === 'failed') failed++;
    }
    return { all: base.length, reviewed, unreviewed, analyzing, failed };
  }, [allPrs, filter, query, sourceFilter, reviewsByPr]);

  // Também consultamos a lista de sources direto (rápido, sem ir no GitHub)
  // pra evitar mostrar "não tem repo" enquanto o fetch de PRs ainda roda.
  const sourcesQuery = useQuery({
    queryKey: ['source-list', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['source:list']({ workspaceId: activeWorkspace!.id }),
  });
  const hasAnyGithubSource = (sourcesQuery.data ?? []).some(
    (s) => s.kind === 'github_repo' && s.repoFullName,
  );
  const hasAnyRepo = sourceGroups.length > 0 || hasAnyGithubSource;
  const hasMultipleSources = sourceGroups.length > 1;
  // Distinguimos "ainda carregando PRs do GitHub" de "não tem repo nenhum".
  // O empty state só aparece quando realmente confirmamos que não há sources.
  const isLoadingPrs = allPrsQuery.isPending || (hasAnyGithubSource && sourceGroups.length === 0);

  // Infinite scroll: observa um sentinel no fim da lista (root = container
  // rolável) e busca a próxima página antes de chegar no fim (rootMargin).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = allPrsQuery;
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasNextPage) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { root, rootMargin: '300px' },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <PageShell
      title={t('pages.codeReviews.title')}
      description={
        hasAnyRepo
          ? hasMultipleSources
            ? t('pages.codeReviews.descMulti', { n: sourceGroups.length })
            : sourceGroups[0]?.repoFullName
              ? t('pages.codeReviews.descSingle', { repo: sourceGroups[0].repoFullName })
              : t('pages.codeReviews.loadingPrs')
          : t('pages.codeReviews.descConnect')
      }
      toolbar={
        hasAnyRepo ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('pages.codeReviews.searchPr')}
                className="h-8 w-44 rounded-md border border-hairline-strong bg-surface-subtle pl-8 pr-3 text-[12.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-hairline-strong sm:w-56"
              />
            </div>
            {hasMultipleSources && (
              <DSSelect
                value={sourceFilter}
                onChange={setSourceFilter}
                className="h-8 w-44 text-[12px]"
                options={[
                  {
                    value: 'all',
                    label: t('pages.codeReviews.allSources'),
                    icon: <Layers className="h-3.5 w-3.5 text-text-muted" />,
                  },
                  ...sourceGroups.map((g) => {
                    const meta = g.sourceRole ? ROLE_META[g.sourceRole] : null;
                    const Icon = meta?.icon ?? GitBranch;
                    return {
                      value: g.sourceId,
                      label: repoShortName(g.repoFullName) || g.sourceLabel,
                      hint: `${g.prs.length}`,
                      icon: <Icon className={cn('h-3.5 w-3.5', meta?.color ?? 'opacity-70')} />,
                    };
                  }),
                ]}
              />
            )}
            <div className="flex h-8 items-stretch overflow-hidden rounded-md border border-hairline-strong bg-surface-subtle">
              {(['open', 'closed', 'all'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={cn(
                    'inline-flex items-center px-3 text-[11px] font-medium leading-none transition-colors',
                    f !== 'open' && 'border-l border-hairline-strong',
                    filter === f
                      ? 'bg-surface-strong text-text-primary'
                      : 'text-text-muted hover:bg-surface-1 hover:text-text-primary',
                  )}
                >
                  {f === 'open'
                    ? t('pages.codeReviews.filterOpen')
                    : f === 'closed'
                      ? t('pages.codeReviews.filterClosed')
                      : t('pages.codeReviews.filterAll')}
                </button>
              ))}
            </div>
          </div>
        ) : undefined
      }
    >
      {!activeWorkspace ? (
        <Empty>{t('pages.codeReviews.noActiveWorkspace')}</Empty>
      ) : !hasAnyRepo && !sourcesQuery.isPending ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-xl border border-hairline-strong bg-surface-faint">
            <GitPullRequestArrow className="h-6 w-6 text-text-faint" />
          </div>
          <div>
            <p className="text-[14px] font-medium text-text-primary">
              {t('pages.codeReviews.noGithubSourceTitle')}
            </p>
            <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-text-muted">
              {t('pages.codeReviews.noGithubSource')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => useUIStore.getState().openAddSource()}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-4 text-[12.5px] font-medium text-black transition-colors hover:bg-white/90"
          >
            <Github className="h-3.5 w-3.5" />
            {t('pages.codeReviews.connectGithub')}
          </button>
        </div>
      ) : isLoadingPrs && allPrs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12.5px] text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('pages.codeReviews.loadingPrs')}
        </div>
      ) : (
        <>
          {/* Filtro por status — fileira única de chips. O filtro de source
              ficou no dropdown do header (junto da busca). */}
          {hasAnyRepo && (
            <ReviewStatusFilterBar
              active={reviewStatusFilter}
              onChange={setReviewStatusFilter}
              counts={reviewStatusCounts}
              t={t}
            />
          )}

          {allPrsQuery.isPending ? (
            <ListEmpty>{t('pages.codeReviews.loadingPrsList')}</ListEmpty>
          ) : allPrsQuery.isError ? (
            <ListEmpty>
              {t('pages.codeReviews.errorPrefix', {
                msg: (allPrsQuery.error as Error)?.message ?? t('pages.codeReviews.errorUnknown'),
              })}
            </ListEmpty>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <div className="grid h-11 w-11 place-items-center rounded-xl border border-hairline-strong bg-surface-faint">
                <GitPullRequestArrow className="h-5 w-5 text-text-faint" />
              </div>
              <div>
                <p className="text-[13.5px] font-medium text-text-primary">
                  {t('pages.codeReviews.noPrHere')}
                </p>
                <p className="mt-1 max-w-xs text-[12px] leading-relaxed text-text-muted">
                  {t('pages.codeReviews.noPrHereHint')}
                </p>
              </div>
            </div>
          ) : (
            <div ref={scrollRef} className="thin-scrollbar flex-1 overflow-y-auto">
              {filtered.map((pr) => (
                <PRListItem
                  key={`${pr.repoFullName}#${pr.number}`}
                  pr={pr}
                  showSource={hasMultipleSources}
                  review={reviewsByPr.get(`${pr.repoFullName}#${pr.number}`)}
                  t={t}
                  onSelect={() =>
                    navigate(`/code-reviews/${encodeURIComponent(pr.repoFullName!)}/${pr.number}`)
                  }
                />
              ))}
              {/* Sentinel do infinite scroll + indicador de carregamento. */}
              <div ref={loadMoreRef} aria-hidden className="h-px" />
              {isFetchingNextPage && (
                <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('pages.codeReviews.loadingMore')}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}

/**
 * Chip pill minimalista: sem fundo, só texto + sub-texto faint pra contagem.
 * Estado ativo só com bg sutil.
 */
function MinimalChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors',
        active
          ? 'bg-surface-active text-text-primary'
          : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}

/** Extrai a parte após `/` do repoFullName. "owner/repo" → "repo". */
function repoShortName(repoFullName: string | undefined | null): string {
  if (!repoFullName) return '';
  return repoFullName.split('/').slice(-1)[0] ?? repoFullName;
}

/**
 * Filtro por status de review (Revisados / Sem review / Em análise / Falharam).
 * Counts são calculados sobre a base já filtrada por source + state + query.
 */
function ReviewStatusFilterBar({
  active,
  onChange,
  counts,
  t,
}: {
  active: 'all' | 'reviewed' | 'unreviewed' | 'analyzing' | 'failed';
  onChange: (v: 'all' | 'reviewed' | 'unreviewed' | 'analyzing' | 'failed') => void;
  counts: {
    all: number;
    reviewed: number;
    unreviewed: number;
    analyzing: number;
    failed: number;
  };
  t: TFunction;
}) {
  const items: Array<{
    value: typeof active;
    label: string;
    count: number;
    icon?: typeof Sparkles;
    color?: string;
  }> = [
    { value: 'all', label: t('pages.codeReviews.filterAll'), count: counts.all },
    {
      value: 'reviewed',
      label: t('pages.codeReviews.statusReviewed'),
      count: counts.reviewed,
      icon: CheckCircle2,
      color: 'text-accent-green',
    },
    {
      value: 'unreviewed',
      label: t('pages.codeReviews.statusUnreviewed'),
      count: counts.unreviewed,
    },
  ];
  if (counts.analyzing > 0) {
    items.push({
      value: 'analyzing',
      label: t('pages.codeReviews.statusAnalyzing'),
      count: counts.analyzing,
      icon: Loader2,
      color: 'text-accent-blue',
    });
  }
  if (counts.failed > 0) {
    items.push({
      value: 'failed',
      label: t('pages.codeReviews.statusFailed'),
      count: counts.failed,
      icon: AlertTriangle,
      color: 'text-accent-red',
    });
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-hairline-soft px-8 pt-3 pb-3">
      {items.map(({ value, label, count, icon: Icon, color }) => (
        <MinimalChip key={value} active={active === value} onClick={() => onChange(value)}>
          {Icon && (
            <Icon className={cn('h-3 w-3', color, value === 'analyzing' && 'animate-spin')} />
          )}
          {label} <span className="text-text-faint">{count}</span>
        </MinimalChip>
      ))}
    </div>
  );
}

function PRListItem({
  pr,
  review,
  onSelect,
  showSource,
  t,
}: {
  pr: GithubPullRequest & {
    sourceLabel?: string;
    sourceRole?: WorkspaceSourceRole | null;
    repoFullName?: string;
  };
  review?: CodeReview;
  onSelect: () => void;
  showSource?: boolean;
  t: TFunction;
}) {
  const sourceMeta = pr.sourceRole ? ROLE_META[pr.sourceRole] : null;
  const SourceIcon = sourceMeta?.icon;
  const Icon = pr.merged
    ? GitMerge
    : pr.state === 'closed'
      ? GitPullRequestClosed
      : GitPullRequestArrow;
  const stateColor = pr.merged
    ? 'text-accent-purple'
    : pr.state === 'closed'
      ? 'text-accent-red'
      : pr.draft
        ? 'text-text-muted'
        : 'text-accent-green';

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-3 border-b border-hairline-soft px-8 py-3.5 text-left transition-colors hover:bg-surface-subtle"
    >
      <Icon className={cn('mt-1 h-4 w-4 shrink-0', stateColor)} />

      {/* Conteúdo principal */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{pr.title}</span>
          <span className="font-mono text-[10.5px] text-text-faint">#{pr.number}</span>
          {showSource && pr.repoFullName && (
            <span
              className={cn(
                'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium',
                sourceMeta?.chip ?? 'border-hairline-strong bg-surface-1 text-text-secondary',
              )}
              title={pr.repoFullName}
            >
              {SourceIcon && <SourceIcon className="h-2.5 w-2.5" />}
              {repoShortName(pr.repoFullName)}
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
          {/* Avatar do autor */}
          <span className="inline-flex items-center gap-1.5">
            <Avatar src={pr.authorAvatarUrl} fallback={pr.author ?? '?'} />
            <span className="text-text-secondary">
              {pr.author ?? t('pages.codeReviews.authorUnknown')}
            </span>
          </span>
          <span className="text-text-faint">·</span>
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-2.5 w-2.5" />
            {fmtAbsoluteDate(pr.createdAt)}
          </span>
          <span className="text-text-faint">·</span>
          <span className="font-mono text-[10.5px]">
            {pr.headRef} → {pr.baseRef}
          </span>
          {pr.comments > 0 && (
            <>
              <span className="text-text-faint">·</span>
              <span className="inline-flex items-center gap-0.5">
                <MessageSquare className="h-2.5 w-2.5" />
                {pr.comments}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Status badge à direita */}
      <div className="shrink-0">
        <ReviewBadge review={review} t={t} />
      </div>

      <ChevronRight className="mt-1.5 h-4 w-4 shrink-0 text-text-faint" />
    </button>
  );
}

/** Avatar circular pequeno com fallback de iniciais. */
function Avatar({ src, fallback }: { src: string | null; fallback: string }) {
  const initial = fallback.charAt(0).toUpperCase();
  return src ? (
    <img
      src={src}
      alt={fallback}
      className="h-4 w-4 rounded-full border border-hairline-strong bg-surface-1"
      onError={(e) => {
        (e.target as HTMLImageElement).style.display = 'none';
      }}
    />
  ) : (
    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-surface-strong text-[8.5px] font-medium text-text-secondary">
      {initial}
    </span>
  );
}

function fmtAbsoluteDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  } catch {
    return iso;
  }
}

/** Mapeia extensão do arquivo pra linguagem do CodeBlock. */
function inferLangFromPath(filePath: string): string {
  const m = filePath.match(/\.([a-zA-Z0-9]+)$/);
  const ext = (m?.[1] ?? '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    py: 'py',
    json: 'json',
    sh: 'sh',
    bash: 'sh',
    zsh: 'sh',
    yml: 'json',
    yaml: 'json',
  };
  return map[ext] ?? 'ts';
}

function ReviewBadge({ review, t }: { review?: CodeReview; t: TFunction }) {
  if (!review) {
    return (
      <span className="inline-flex h-5 items-center gap-1 rounded-md border border-hairline-strong bg-surface-faint px-1.5 text-[10px] text-text-muted">
        {t('pages.codeReviews.badgeNoReview')}
      </span>
    );
  }
  if (review.status === 'analyzing' || review.status === 'queued') {
    return (
      <span className="inline-flex h-5 items-center gap-1 rounded-md border border-accent-blue/30 bg-accent-blue/10 px-1.5 text-[10px] text-accent-blue">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        {t('pages.codeReviews.badgeAnalyzing')}
      </span>
    );
  }
  if (review.status === 'failed') {
    return (
      <span className="inline-flex h-5 items-center gap-1 rounded-md border border-accent-red/30 bg-accent-red/10 px-1.5 text-[10px] text-accent-red">
        <AlertTriangle className="h-2.5 w-2.5" />
        {t('pages.codeReviews.badgeFailed')}
      </span>
    );
  }
  const rating = review.rating;
  const issues = review.bugCount + review.securityCount;
  return (
    <div className="flex items-center gap-1.5">
      {typeof rating === 'number' && (
        <span
          className={cn(
            'inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] font-semibold',
            rating >= 8
              ? 'border-accent-green/30 bg-accent-green/10 text-accent-green'
              : rating >= 5
                ? 'border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow'
                : 'border-accent-red/30 bg-accent-red/10 text-accent-red',
          )}
        >
          {rating.toFixed(1)} / 10
        </span>
      )}
      <span
        className={cn(
          'inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[10px]',
          issues > 0
            ? 'border-accent-red/30 bg-accent-red/10 text-accent-red'
            : 'border-hairline-strong bg-surface-faint text-text-muted',
        )}
      >
        {issues > 0 ? (
          <>
            <AlertTriangle className="h-2.5 w-2.5" />
            {review.totalComments}{' '}
            {review.totalComments === 1
              ? t('pages.codeReviews.comment')
              : t('pages.codeReviews.comments')}
          </>
        ) : (
          <>
            <MessageSquare className="h-2.5 w-2.5" />
            {review.totalComments}
          </>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Painel de detalhe
// ---------------------------------------------------------------------------

export function ReviewDetailPane({
  workspaceId,
  repoFullName,
  prNumber,
  prTitle,
  prHtmlUrl,
}: {
  workspaceId: string;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prHtmlUrl: string;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();

  // Agentes do workspace (pra picker)
  const agentsQuery = useQuery<Agent[]>({
    queryKey: ['agents', workspaceId],
    queryFn: () => window.orkestral['agent:list']({ workspaceId }),
  });
  const agents = useMemo(
    () => (agentsQuery.data ?? []).filter((a) => a.adapterType),
    [agentsQuery.data],
  );

  // Persistência local da escolha do reviewer
  const storageKey = `orkestral.reviewer.${workspaceId}`;
  const [chosenReviewerId, setChosenReviewerId] = useState<string>(() => {
    try {
      return localStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      if (chosenReviewerId) localStorage.setItem(storageKey, chosenReviewerId);
    } catch {
      // ignore
    }
  }, [chosenReviewerId, storageKey]);

  // Default: CEO/orchestrator se o user nunca escolheu
  const effectiveReviewer = useMemo<Agent | undefined>(() => {
    if (chosenReviewerId) {
      return agents.find((a) => a.id === chosenReviewerId);
    }
    return agents.find((a) => a.isOrchestrator) ?? agents[0];
  }, [agents, chosenReviewerId]);

  const latestQuery = useQuery({
    queryKey: ['code-review-latest', workspaceId, repoFullName, prNumber],
    queryFn: () =>
      window.orkestral['code-review:latest-for-pr']({
        workspaceId,
        repoFullName,
        prNumber,
      }),
    refetchInterval: (q) => {
      const data = q.state.data;
      return data && (data.status === 'queued' || data.status === 'analyzing') ? 2_000 : false;
    },
  });

  const latest = latestQuery.data ?? null;

  const detailQuery = useQuery({
    queryKey: ['code-review-detail', latest?.id],
    enabled: !!latest && latest.status === 'completed',
    queryFn: () => window.orkestral['code-review:get']({ reviewId: latest!.id }),
  });
  const comments = detailQuery.data?.comments ?? [];

  // Live stream do agente — fase + stdout chunks
  const [livePhase, setLivePhase] = useState<{
    phase: string;
    message: string;
  } | null>(null);
  const [liveStdout, setLiveStdout] = useState('');
  const [liveStderr, setLiveStderr] = useState('');
  const liveReviewIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!latest || (latest.status !== 'analyzing' && latest.status !== 'queued')) {
      // Limpa quando review já terminou
      if (liveReviewIdRef.current && liveReviewIdRef.current !== latest?.id) {
        setLivePhase(null);
        setLiveStdout('');
        setLiveStderr('');
      }
      return;
    }
    liveReviewIdRef.current = latest.id;
    const api = (
      window as Window & {
        orkestralEvents?: {
          onCodeReviewEvent?: (cb: (e: CodeReviewEvent) => void) => () => void;
        };
      }
    ).orkestralEvents;
    if (!api?.onCodeReviewEvent) return;
    const unsubscribe = api.onCodeReviewEvent((evt) => {
      if (evt.reviewId !== latest.id) return;
      if (evt.type === 'review-phase') {
        setLivePhase({ phase: evt.phase, message: evt.message });
      } else if (evt.type === 'review-stdout') {
        setLiveStdout((prev) => (prev + evt.chunk).slice(-8000));
      } else if (evt.type === 'review-stderr') {
        setLiveStderr((prev) => (prev + evt.chunk).slice(-2000));
      } else if (evt.type === 'review-finished') {
        queryClient.invalidateQueries({ queryKey: ['code-reviews'] });
        queryClient.invalidateQueries({ queryKey: ['code-review-latest'] });
      }
    });
    return unsubscribe;
  }, [latest, queryClient]);

  // Linked PRs: persistem por localStorage por PR e seedeam a partir da review salva
  const linkKey = `orkestral.linkedPrs.${workspaceId}.${repoFullName}.${prNumber}`;
  const [linkedPrs, setLinkedPrs] = useState<CodeReviewLinkedPr[]>(() => {
    try {
      const raw = localStorage.getItem(linkKey);
      if (raw) return JSON.parse(raw) as CodeReviewLinkedPr[];
    } catch {
      // ignore
    }
    return [];
  });
  const seededLinkedRef = useRef(false);
  useEffect(() => {
    // Se a review já tem linkedPrs salvos e o user ainda não mexeu, hidrata
    if (!seededLinkedRef.current && latest?.linkedPrs && latest.linkedPrs.length > 0) {
      seededLinkedRef.current = true;
      try {
        const raw = localStorage.getItem(linkKey);
        if (!raw) {
          const frame = requestAnimationFrame(() => setLinkedPrs(latest.linkedPrs ?? []));
          return () => cancelAnimationFrame(frame);
        }
      } catch {
        const frame = requestAnimationFrame(() => setLinkedPrs(latest.linkedPrs ?? []));
        return () => cancelAnimationFrame(frame);
      }
    }
    return undefined;
  }, [latest, linkKey]);
  useEffect(() => {
    try {
      if (linkedPrs.length === 0) localStorage.removeItem(linkKey);
      else localStorage.setItem(linkKey, JSON.stringify(linkedPrs));
    } catch {
      // ignore
    }
  }, [linkedPrs, linkKey]);

  const [linkModalOpen, setLinkModalOpen] = useState(false);

  const runMutation = useMutation({
    mutationFn: () =>
      window.orkestral['code-review:run']({
        workspaceId,
        repoFullName,
        prNumber,
        reviewerAgentId: effectiveReviewer?.id ?? null,
        linkedPrs: linkedPrs.length > 0 ? linkedPrs : undefined,
      }),
    onMutate: () => {
      // Limpa stream antigo antes de novo run
      setLivePhase(null);
      setLiveStdout('');
      setLiveStderr('');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['code-reviews'] });
      queryClient.invalidateQueries({ queryKey: ['code-review-latest'] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => window.orkestral['code-review:cancel']({ reviewId: latest!.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['code-review-latest'] });
    },
  });

  const postMutation = useMutation({
    mutationFn: () => window.orkestral['code-review:post-to-github']({ reviewId: latest!.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['code-review-latest'] });
      queryClient.invalidateQueries({ queryKey: ['code-review-detail'] });
    },
  });

  const resolutionMutation = useMutation({
    mutationFn: (input: { commentId: string; resolution: 'pending' | 'resolved' | 'ignored' }) =>
      window.orkestral['code-review:update-comment-resolution'](input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['code-review-detail'] });
    },
  });

  const isAnalyzing = latest?.status === 'analyzing' || latest?.status === 'queued';
  const isCompleted = latest?.status === 'completed';

  const reviewerOptions = useMemo(() => {
    return agents.map((a) => ({
      value: a.id,
      label: a.name + (a.isOrchestrator ? ' (CEO)' : ''),
      hint: a.adapterType ?? '',
      icon: <AgentAvatar seed={a.avatarSeed} name={a.name} size={12} />,
    }));
  }, [agents]);

  const runError = runMutation.error instanceof Error ? runMutation.error.message : null;
  const cancelError = cancelMutation.error instanceof Error ? cancelMutation.error.message : null;
  const postError = postMutation.error instanceof Error ? postMutation.error.message : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-3 border-b border-hairline-faint bg-background/60 px-6 py-4 backdrop-blur">
        <Sparkles className="mt-0.5 h-4 w-4 text-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-text-muted">#{prNumber}</span>
            <span className="truncate text-[14px] font-semibold tracking-tight text-text-primary">
              {prTitle}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-text-muted">
            {repoFullName}
            {latest?.headSha && (
              <>
                {' · '}
                <span className="font-mono">{latest.headSha.slice(0, 8)}</span>
              </>
            )}
            {latest?.finishedAt && (
              <>
                {` · ${t('pages.codeReviews.revised')} `}
                <span>{fmtRelative(latest.finishedAt, t)}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Agent picker */}
          {reviewerOptions.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10.5px] uppercase tracking-wider text-text-faint">
                {t('pages.codeReviews.reviewer')}
              </span>
              <DSSelect
                value={effectiveReviewer?.id ?? ''}
                onChange={setChosenReviewerId}
                options={reviewerOptions}
                placeholder={t('pages.codeReviews.chooseAgent')}
                className="h-8 min-w-[180px] text-[11.5px]"
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => setLinkModalOpen(true)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] transition-colors',
              linkedPrs.length > 0
                ? 'border-accent-purple/30 bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20'
                : 'border-hairline-strong text-text-secondary hover:bg-surface-1 hover:text-text-primary',
            )}
            title={t('pages.codeReviews.linkPrTooltip')}
          >
            <Link2 className="h-3.5 w-3.5" />
            {t('pages.codeReviews.linkPr')}
            {linkedPrs.length > 0 && (
              <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-purple/30 px-1 text-[9.5px] font-semibold">
                {linkedPrs.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => window.open(prHtmlUrl, '_blank')}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            GitHub
          </button>
          {isAnalyzing ? (
            <button
              type="button"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-red/40 bg-accent-red/10 px-3 text-[12px] font-medium text-accent-red hover:bg-accent-red/20 disabled:opacity-40"
            >
              {cancelMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3 w-3 fill-current" />
              )}
              {t('common.cancel')}
            </button>
          ) : (
            <button
              type="button"
              disabled={runMutation.isPending || !effectiveReviewer}
              onClick={() => runMutation.mutate()}
              title={
                !effectiveReviewer
                  ? t('pages.codeReviews.noAgentConfigured')
                  : t('pages.codeReviews.runReviewWith', { name: effectiveReviewer.name })
              }
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-1 pl-2 pr-3 text-[12px] font-medium text-text-primary hover:bg-surface-strong disabled:opacity-40"
            >
              {runMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : effectiveReviewer ? (
                <AgentAvatar
                  seed={effectiveReviewer.avatarSeed}
                  name={effectiveReviewer.name}
                  size={16}
                />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {latest ? t('pages.codeReviews.reanalyze') : t('pages.codeReviews.analyzeNow')}
            </button>
          )}
          {isCompleted && !latest?.postedToGithubAt && (
            <button
              type="button"
              disabled={postMutation.isPending}
              onClick={() => postMutation.mutate()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-[12px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
            >
              {postMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {t('pages.codeReviews.postToGithub')}
            </button>
          )}
        </div>
      </div>

      {/* Chips de PRs linkados — só mostram se há algum */}
      {linkedPrs.length > 0 && (
        <div className="flex items-center gap-2 border-b border-hairline-faint bg-accent-purple/[0.025] px-6 py-2">
          <Link2 className="h-3 w-3 text-accent-purple" />
          <span className="text-[10.5px] uppercase tracking-wider text-accent-purple">
            {t('pages.codeReviews.linked', { n: linkedPrs.length })}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {linkedPrs.map((lp) => (
              <span
                key={`${lp.repoFullName}#${lp.prNumber}`}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-accent-purple/30 bg-accent-purple/10 px-1.5 text-[10.5px] text-accent-purple"
                title={lp.prTitle}
              >
                <span className="font-mono">
                  {lp.repoFullName}#{lp.prNumber}
                </span>
                {lp.role && (
                  <span className="font-medium uppercase tracking-wider opacity-80">{lp.role}</span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setLinkedPrs((prev) =>
                      prev.filter(
                        (p) => !(p.repoFullName === lp.repoFullName && p.prNumber === lp.prNumber),
                      ),
                    )
                  }
                  className="grid h-4 w-4 place-items-center rounded hover:bg-accent-purple/20"
                  title={t('pages.codeReviews.removeLink')}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="ml-auto text-[10.5px] text-text-faint">
            {t('pages.codeReviews.reanalyzeHint')}
          </div>
        </div>
      )}

      {/* Toast inline pra erros de mutation */}
      {(runError || cancelError || postError) && (
        <div className="border-b border-accent-red/30 bg-accent-red/[0.06] px-6 py-2.5 text-[11.5px] text-accent-red">
          <AlertTriangle className="mr-1.5 inline h-3 w-3" />
          {runError || cancelError || postError}
        </div>
      )}

      <div className="thin-scrollbar flex-1 overflow-y-auto">
        {!effectiveReviewer && agents.length === 0 ? (
          <NoAgentsState t={t} />
        ) : !latest ? (
          <EmptyReview
            onAnalyze={() => runMutation.mutate()}
            busy={runMutation.isPending}
            reviewer={effectiveReviewer}
            t={t}
          />
        ) : latest.status === 'failed' ? (
          <FailedReview
            error={latest.errorMessage}
            stdout={liveStdout}
            stderr={liveStderr}
            onRetry={() => runMutation.mutate()}
            busy={runMutation.isPending}
            t={t}
          />
        ) : isAnalyzing ? (
          <AnalyzingState
            phase={livePhase}
            reviewer={effectiveReviewer}
            stdout={liveStdout}
            stderr={liveStderr}
            startedAt={latest?.startedAt}
            t={t}
          />
        ) : isCompleted ? (
          <CompletedReview
            review={latest}
            comments={comments}
            onUpdateResolution={(commentId, resolution) =>
              resolutionMutation.mutate({ commentId, resolution })
            }
            t={t}
          />
        ) : null}
      </div>

      <LinkPrModal
        open={linkModalOpen}
        onOpenChange={setLinkModalOpen}
        workspaceId={workspaceId}
        currentRepoFullName={repoFullName}
        currentPrNumber={prNumber}
        linkedPrs={linkedPrs}
        onChange={setLinkedPrs}
        t={t}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal de linkar PR
// ---------------------------------------------------------------------------

type LinkPrSort = 'updated' | 'created' | 'number';
type LinkPrState = 'open' | 'closed' | 'all';

function LinkPrModal({
  open,
  onOpenChange,
  workspaceId,
  currentRepoFullName,
  currentPrNumber,
  linkedPrs,
  onChange,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  currentRepoFullName: string;
  currentPrNumber: number;
  linkedPrs: CodeReviewLinkedPr[];
  onChange: (prs: CodeReviewLinkedPr[]) => void;
  t: TFunction;
}) {
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<LinkPrState>('open');
  const [authorFilter, setAuthorFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<LinkPrSort>('updated');

  const allPrsQuery = useQuery({
    queryKey: ['source-all-prs', workspaceId],
    enabled: open,
    queryFn: () => window.orkestral['source:list-all-prs']({ workspaceId }),
  });

  const sourceGroups = useMemo(() => allPrsQuery.data ?? [], [allPrsQuery.data]);

  const isLinked = (repoFullName: string, prNumber: number) =>
    linkedPrs.some((l) => l.repoFullName === repoFullName && l.prNumber === prNumber);

  function toggle(repoFullName: string, pr: GithubPullRequest, role: WorkspaceSourceRole | null) {
    if (isLinked(repoFullName, pr.number)) {
      onChange(
        linkedPrs.filter((l) => !(l.repoFullName === repoFullName && l.prNumber === pr.number)),
      );
    } else {
      onChange([...linkedPrs, { repoFullName, prNumber: pr.number, prTitle: pr.title, role }]);
    }
  }

  // Lista de autores únicos pra dropdown
  const authors = useMemo(() => {
    const set = new Set<string>();
    for (const g of sourceGroups) {
      for (const pr of g.prs) {
        if (pr.author) set.add(pr.author);
      }
    }
    return Array.from(set).sort();
  }, [sourceGroups]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sourceGroups
      .filter((g) => sourceFilter === 'all' || g.sourceId === sourceFilter)
      .map((g) => ({
        ...g,
        prs: g.prs
          .filter((pr) => {
            if (g.repoFullName === currentRepoFullName && pr.number === currentPrNumber)
              return false;
            if (stateFilter === 'open' && pr.state !== 'open') return false;
            if (stateFilter === 'closed' && pr.state !== 'closed') return false;
            if (authorFilter !== 'all' && pr.author !== authorFilter) return false;
            if (q) {
              return (
                pr.title.toLowerCase().includes(q) ||
                String(pr.number).includes(q) ||
                g.repoFullName.toLowerCase().includes(q) ||
                (pr.author ?? '').toLowerCase().includes(q)
              );
            }
            return true;
          })
          .sort((a, b) => {
            if (sortBy === 'number') return b.number - a.number;
            if (sortBy === 'created')
              return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            return (
              new Date(b.updatedAt ?? b.createdAt).getTime() -
              new Date(a.updatedAt ?? a.createdAt).getTime()
            );
          }),
      }))
      .filter((g) => g.prs.length > 0);
  }, [
    sourceGroups,
    currentRepoFullName,
    currentPrNumber,
    query,
    sourceFilter,
    stateFilter,
    authorFilter,
    sortBy,
  ]);

  const totalShown = grouped.reduce((acc, g) => acc + g.prs.length, 0);
  const hasActiveFilter =
    !!query.trim() || sourceFilter !== 'all' || stateFilter !== 'open' || authorFilter !== 'all';

  // Conta PRs aplicando estado + autor + busca (TODOS os filtros menos source),
  // pros chips de source mostrarem o número que realmente aparece na lista.
  const countForSource = (sid: string | null): number => {
    const q = query.trim().toLowerCase();
    let n = 0;
    for (const g of sourceGroups) {
      if (sid && g.sourceId !== sid) continue;
      for (const pr of g.prs) {
        if (g.repoFullName === currentRepoFullName && pr.number === currentPrNumber) continue;
        if (stateFilter === 'open' && pr.state !== 'open') continue;
        if (stateFilter === 'closed' && pr.state !== 'closed') continue;
        if (authorFilter !== 'all' && pr.author !== authorFilter) continue;
        if (
          q &&
          !pr.title.toLowerCase().includes(q) &&
          !String(pr.number).includes(q) &&
          !g.repoFullName.toLowerCase().includes(q) &&
          !(pr.author ?? '').toLowerCase().includes(q)
        )
          continue;
        n++;
      }
    }
    return n;
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center p-12"
      onMouseDown={() => onOpenChange(false)}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[3px]" />

      {/* Card — stopPropagation pra clique interno não fechar */}
      <div
        className="relative z-10 flex max-h-[calc(100vh-96px)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-hairline-strong bg-dialog text-text-primary shadow-2xl shadow-black/40"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Botão fechar */}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute right-3.5 top-3.5 z-20 grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-strong hover:text-text-primary"
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <X className="h-4 w-4" />
        </button>

        {/* Header */}
        <div className="border-b border-hairline-faint px-6 pt-5 pb-4">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-text-primary">
            <Link2 className="h-4 w-4 text-accent-purple" />
            {t('pages.codeReviews.linkPrsTitle')}
          </h2>
          <p className="mt-1 pr-8 text-[11.5px] text-text-muted">
            {t('pages.codeReviews.linkPrsDesc')}
          </p>

          {/* Search + sort */}
          <div className="mt-4 flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('pages.codeReviews.searchLinkPlaceholder')}
                className="h-9 w-full rounded-lg border border-hairline-strong bg-surface-subtle pl-9 pr-3 text-[12.5px] text-text-primary placeholder:text-text-muted transition-colors focus:border-hairline-intense focus:bg-surface-1 focus:outline-none"
              />
            </div>
            <DSSelect
              value={sortBy}
              onChange={(v) => setSortBy(v as LinkPrSort)}
              options={[
                { value: 'updated', label: t('pages.codeReviews.sortUpdated') },
                { value: 'created', label: t('pages.codeReviews.sortCreated') },
                { value: 'number', label: t('pages.codeReviews.sortNumber') },
              ]}
              className="h-9 w-36 text-[12px]"
            />
          </div>

          {/* Source filter chips */}
          {sourceGroups.length > 1 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[10px] uppercase tracking-wider text-text-faint">
                {t('pages.codeReviews.source')}
              </span>
              <FilterChip active={sourceFilter === 'all'} onClick={() => setSourceFilter('all')}>
                {t('pages.codeReviews.all')}
                <span className="ml-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-surface-strong px-1 text-[9px] font-semibold text-text-secondary">
                  {countForSource(null)}
                </span>
              </FilterChip>
              {sourceGroups.map((g) => {
                const meta = g.sourceRole ? ROLE_META[g.sourceRole] : null;
                const SrcIcon = meta?.icon;
                return (
                  <FilterChip
                    key={g.sourceId}
                    active={sourceFilter === g.sourceId}
                    onClick={() => setSourceFilter(g.sourceId)}
                    title={g.repoFullName}
                  >
                    {SrcIcon ? (
                      <SrcIcon className={cn('h-3 w-3', meta?.color)} />
                    ) : (
                      <GitBranch className="h-3 w-3 opacity-70" />
                    )}
                    {repoShortName(g.repoFullName) || g.sourceLabel}
                    <span className="ml-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-surface-strong px-1 text-[9px] font-semibold text-text-secondary">
                      {countForSource(g.sourceId)}
                    </span>
                  </FilterChip>
                );
              })}
            </div>
          )}

          {/* State + author filters */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10px] uppercase tracking-wider text-text-faint">
              {t('pages.codeReviews.state')}
            </span>
            {(['open', 'closed', 'all'] as const).map((s) => (
              <FilterChip key={s} active={stateFilter === s} onClick={() => setStateFilter(s)}>
                {s === 'open'
                  ? t('pages.codeReviews.filterOpen')
                  : s === 'closed'
                    ? t('pages.codeReviews.filterClosed')
                    : t('pages.codeReviews.filterAll')}
              </FilterChip>
            ))}
            {authors.length > 0 && (
              <>
                <span className="ml-3 mr-1 text-[10px] uppercase tracking-wider text-text-faint">
                  {t('pages.codeReviews.author')}
                </span>
                <DSSelect
                  value={authorFilter}
                  onChange={setAuthorFilter}
                  options={[
                    { value: 'all', label: t('pages.codeReviews.all') },
                    ...authors.map((a) => ({ value: a, label: a })),
                  ]}
                  className="h-7 w-40 text-[11px]"
                />
              </>
            )}
            {hasActiveFilter && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setSourceFilter('all');
                  setStateFilter('open');
                  setAuthorFilter('all');
                }}
                className="ml-auto text-[11px] text-text-muted hover:text-text-primary"
              >
                {t('pages.codeReviews.clearFilters')}
              </button>
            )}
          </div>
        </div>

        {/* Body — lista de PRs */}
        <div className="thin-scrollbar max-h-[440px] overflow-y-auto px-6 py-4">
          {allPrsQuery.isPending ? (
            <div className="flex items-center justify-center py-10 text-[12px] text-text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('pages.codeReviews.fetchingAllSources')}
            </div>
          ) : sourceGroups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-hairline bg-surface-whisper p-6 text-center text-[12px] text-text-muted">
              {t('pages.codeReviews.noReposLinked')}
            </div>
          ) : grouped.length === 0 ? (
            <div className="rounded-lg border border-dashed border-hairline bg-surface-whisper p-8 text-center text-[12px] text-text-muted">
              {t('pages.codeReviews.noPrWithFilter')}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {grouped.map((g) => (
                <div key={g.sourceId}>
                  <div className="mb-1.5 flex items-center gap-2 px-1 text-[10.5px] uppercase tracking-wider text-text-faint">
                    <GitBranch className="h-3 w-3" />
                    <span>{repoShortName(g.repoFullName) || g.sourceLabel}</span>
                    <span className="font-mono normal-case text-text-muted">{g.repoFullName}</span>
                    {g.sourceRole && (
                      <span
                        className={cn(
                          'rounded-full border px-1.5 py-0.5 text-[9px] font-medium normal-case',
                          ROLE_META[g.sourceRole].chip,
                        )}
                      >
                        {g.sourceRole}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col divide-y divide-hairline-soft overflow-hidden rounded-lg border border-hairline-faint bg-surface-whisper">
                    {g.prs.slice(0, 30).map((pr) => {
                      const linked = isLinked(g.repoFullName, pr.number);
                      return (
                        <button
                          key={pr.number}
                          type="button"
                          onClick={() => toggle(g.repoFullName, pr, g.sourceRole)}
                          className={cn(
                            'flex items-start gap-3 px-3.5 py-2.5 text-left transition-colors',
                            linked
                              ? 'bg-accent-purple/[0.08] hover:bg-accent-purple/15'
                              : 'hover:bg-surface-subtle',
                          )}
                        >
                          {linked ? (
                            <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-purple" />
                          ) : (
                            <Link2Off className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-faint" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[10.5px] text-text-faint">
                                #{pr.number}
                              </span>
                              <span
                                className={cn(
                                  'h-1.5 w-1.5 shrink-0 rounded-full',
                                  pr.state === 'open' ? 'bg-accent-green' : 'bg-text-faint',
                                )}
                                title={
                                  pr.state === 'open'
                                    ? t('pages.codeReviews.stateOpen')
                                    : t('pages.codeReviews.stateClosed')
                                }
                              />
                              <span
                                className={cn(
                                  'truncate text-[12.5px]',
                                  linked ? 'text-accent-purple' : 'text-text-primary',
                                )}
                              >
                                {pr.title}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-text-muted">
                              <span className="inline-flex items-center gap-1">
                                {pr.authorAvatarUrl ? (
                                  <img
                                    src={pr.authorAvatarUrl}
                                    alt=""
                                    className="h-3.5 w-3.5 rounded-full"
                                  />
                                ) : null}
                                {pr.author}
                              </span>
                              {pr.headRef && (
                                <>
                                  <span className="text-text-faint">·</span>
                                  <span className="font-mono">
                                    {pr.headRef} → {pr.baseRef}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-hairline-faint px-6 py-3">
          <span className="text-[11.5px] text-text-muted">
            {linkedPrs.length === 1
              ? t('pages.codeReviews.linkedCountOne', { n: linkedPrs.length })
              : t('pages.codeReviews.linkedCountMany', { n: linkedPrs.length })}
            {hasActiveFilter && (
              <span className="text-text-faint">
                {' · '}
                {totalShown === 1
                  ? t('pages.codeReviews.resultOne', { n: totalShown })
                  : t('pages.codeReviews.resultMany', { n: totalShown })}
              </span>
            )}
          </span>
          <div className="flex gap-2">
            {linkedPrs.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-hairline-strong px-3.5 text-[12.5px] text-text-secondary hover:bg-surface-1 hover:text-text-primary"
              >
                {t('pages.codeReviews.clearAll')}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-4 text-[12.5px] font-medium text-black hover:bg-white/90"
            >
              {t('pages.codeReviews.done')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Pill de filtro reutilizável — usado pra chips de source/estado/etc dentro
 * de dialogs e barras de filtro.
 */
function FilterChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors',
        active
          ? 'border-hairline-intense bg-surface-6 text-text-primary'
          : 'border-hairline-strong bg-surface-faint text-text-muted hover:bg-surface-1 hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}

function NoAgentsState({ t }: { t: TFunction }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <Bot className="h-8 w-8 text-text-muted" />
      <div className="mt-3 text-[14px] font-medium text-text-primary">
        {t('pages.codeReviews.noAgentsTitle')}
      </div>
      <div className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-text-muted">
        {t('pages.codeReviews.noAgentsDesc')}
      </div>
    </div>
  );
}

type ReviewTab = 'overview' | 'comments' | 'diff';

function CompletedReview({
  review,
  comments,
  onUpdateResolution,
  t,
}: {
  review: CodeReview;
  comments: CodeReviewComment[];
  onUpdateResolution: (commentId: string, resolution: 'pending' | 'resolved' | 'ignored') => void;
  t: TFunction;
}) {
  const [tab, setTab] = useState<ReviewTab>('overview');
  const commentsByFile = useMemo(() => {
    const m = new Map<string, CodeReviewComment[]>();
    for (const c of comments) {
      const list = m.get(c.filePath) ?? [];
      list.push(c);
      m.set(c.filePath, list);
    }
    return m;
  }, [comments]);

  return (
    <div className="flex flex-col">
      {/* Tabs */}
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-hairline-faint bg-background/80 px-6 backdrop-blur">
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>
          <Sparkles className="h-3.5 w-3.5" />
          {t('pages.codeReviews.tabOverview')}
        </TabButton>
        <TabButton active={tab === 'comments'} onClick={() => setTab('comments')}>
          <MessageSquare className="h-3.5 w-3.5" />
          {t('pages.codeReviews.tabComments')}
          {comments.length > 0 && (
            <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-strong px-1 text-[9.5px] font-semibold text-text-secondary">
              {comments.length}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === 'diff'} onClick={() => setTab('diff')}>
          <FileCode className="h-3.5 w-3.5" />
          {t('pages.codeReviews.tabDiff')}
          {review.filesChanged.length > 0 && (
            <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-strong px-1 text-[9.5px] font-semibold text-text-secondary">
              {review.filesChanged.length}
            </span>
          )}
        </TabButton>
      </div>

      {tab === 'overview' && <OverviewTab review={review} commentsCount={comments.length} t={t} />}
      {tab === 'comments' && (
        <CommentsTab
          comments={comments}
          commentsByFile={commentsByFile}
          onUpdateResolution={onUpdateResolution}
          t={t}
        />
      )}
      {tab === 'diff' && <DiffTab review={review} comments={comments} t={t} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative inline-flex h-10 items-center gap-1.5 px-3 text-[12px] font-medium transition-colors',
        active ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary',
      )}
    >
      {children}
      {active && (
        <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-text-primary" />
      )}
    </button>
  );
}

function OverviewTab({
  review,
  commentsCount,
  t,
}: {
  review: CodeReview;
  commentsCount: number;
  t: TFunction;
}) {
  return (
    <div className="flex flex-col gap-5 px-6 py-5">
      <VerdictHero review={review} t={t} />

      {review.postedToGithubAt && (
        <div className="rounded-md border border-accent-green/30 bg-accent-green/[0.06] px-3 py-2 text-[11.5px] text-accent-green">
          <CheckCircle2 className="mr-1.5 inline h-3 w-3" />
          {t('pages.codeReviews.postedToGithubAt', {
            date: fmtAbsolute(review.postedToGithubAt),
          })}
        </div>
      )}

      {review.linkedPrs.length > 0 && (
        <Section
          icon={Link2}
          title={t('pages.codeReviews.multiPrTitle')}
          subtitle={
            review.linkedPrs.length === 1
              ? t('pages.codeReviews.multiPrSubOne', { n: review.linkedPrs.length })
              : t('pages.codeReviews.multiPrSubMany', { n: review.linkedPrs.length })
          }
        >
          <div className="flex flex-wrap gap-1.5">
            {review.linkedPrs.map((lp) => (
              <span
                key={`${lp.repoFullName}#${lp.prNumber}`}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-accent-purple/30 bg-accent-purple/10 px-2 text-[10.5px] text-accent-purple"
                title={lp.prTitle}
              >
                <Link2 className="h-2.5 w-2.5" />
                <span className="font-mono">
                  {lp.repoFullName}#{lp.prNumber}
                </span>
                {lp.role && (
                  <span className="font-medium uppercase tracking-wider opacity-80">{lp.role}</span>
                )}
              </span>
            ))}
          </div>
        </Section>
      )}

      {review.summary && (
        <Section icon={Sparkles} title={t('pages.codeReviews.summaryTitle')}>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-primary">
            {review.summary}
          </p>
        </Section>
      )}

      {(review.highlights.length > 0 || review.concerns.length > 0) && (
        <div className="grid gap-3 md:grid-cols-2">
          {review.highlights.length > 0 && (
            <Section icon={ThumbsUp} title={t('pages.codeReviews.highlightsTitle')} tone="green">
              <ul className="space-y-1.5">
                {review.highlights.map((h, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] text-text-primary">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-accent-green" />
                    <span className="leading-relaxed">{h}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {review.concerns.length > 0 && (
            <Section icon={ThumbsDown} title={t('pages.codeReviews.concernsTitle')} tone="amber">
              <ul className="space-y-1.5">
                {review.concerns.map((c, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] text-text-primary">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-accent-yellow" />
                    <span className="leading-relaxed">{c}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}

      {review.testsAssessment && (
        <Section icon={TestTube} title={t('pages.codeReviews.testsTitle')}>
          <p className="text-[12.5px] leading-relaxed text-text-primary">
            {review.testsAssessment}
          </p>
        </Section>
      )}

      {review.filesChanged.length > 0 && (
        <Section
          icon={Layers}
          title={t('pages.codeReviews.filesChangedTitle')}
          subtitle={
            review.filesChanged.length === 1
              ? t('pages.codeReviews.filesSubOne', { n: review.filesChanged.length })
              : t('pages.codeReviews.filesSubMany', { n: review.filesChanged.length })
          }
        >
          <FilesChangedTable files={review.filesChanged} t={t} />
        </Section>
      )}

      {review.walkthrough.length > 0 && (
        <Section
          icon={FileText}
          title={t('pages.codeReviews.walkthroughTitle')}
          subtitle={t('pages.codeReviews.walkthroughSub')}
        >
          <div className="divide-y divide-hairline-soft rounded-lg border border-hairline-faint bg-surface-whisper">
            {review.walkthrough.map((w, i) => {
              const meta = CHANGE_KIND_META[w.changeKind] ?? CHANGE_KIND_META.chore;
              return (
                <div key={i} className="flex gap-3 px-3 py-2.5">
                  <span
                    className={cn(
                      'mt-0.5 inline-flex h-5 shrink-0 items-center rounded bg-surface-1 px-1.5 text-[9.5px] font-semibold uppercase tracking-wider',
                      meta.color,
                    )}
                  >
                    {meta.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11px] text-text-secondary">
                      {w.filePath}
                    </div>
                    <div className="mt-0.5 text-[12.5px] leading-relaxed text-text-primary">
                      {w.summary}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {commentsCount > 0 && (
        <div className="rounded-md border border-hairline bg-surface-whisper px-3 py-2 text-[11.5px] text-text-muted">
          <MessageSquare className="mr-1.5 inline h-3 w-3" />
          {commentsCount === 1
            ? t('pages.codeReviews.inlineCommentsHintOne', {
                n: commentsCount,
                tab: t('pages.codeReviews.tabComments'),
              })
            : t('pages.codeReviews.inlineCommentsHintMany', {
                n: commentsCount,
                tab: t('pages.codeReviews.tabComments'),
              })}
        </div>
      )}
    </div>
  );
}

function CommentsTab({
  comments,
  commentsByFile,
  onUpdateResolution,
  t,
}: {
  comments: CodeReviewComment[];
  commentsByFile: Map<string, CodeReviewComment[]>;
  onUpdateResolution: (commentId: string, resolution: 'pending' | 'resolved' | 'ignored') => void;
  t: TFunction;
}) {
  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      {comments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-hairline bg-surface-whisper p-6 text-center text-[12.5px] text-text-muted">
          {t('pages.codeReviews.noInlineComments')}
        </div>
      ) : (
        Array.from(commentsByFile.entries()).map(([filePath, list]) => (
          <FileCommentsGroup
            key={filePath}
            filePath={filePath}
            comments={list}
            onUpdate={onUpdateResolution}
            t={t}
          />
        ))
      )}
    </div>
  );
}

function DiffTab({
  review,
  comments,
  t,
}: {
  review: CodeReview;
  comments: CodeReviewComment[];
  t: TFunction;
}) {
  const diffQuery = useQuery({
    queryKey: ['code-review-diff', review.workspaceId, review.repoFullName, review.prNumber],
    queryFn: () =>
      window.orkestral['code-review:get-diff']({
        workspaceId: review.workspaceId,
        repoFullName: review.repoFullName,
        prNumber: review.prNumber,
      }),
    staleTime: 60_000,
  });

  const commentsByFile = useMemo(() => {
    const m = new Map<string, CodeReviewComment[]>();
    for (const c of comments) {
      const list = m.get(c.filePath) ?? [];
      list.push(c);
      m.set(c.filePath, list);
    }
    return m;
  }, [comments]);

  if (diffQuery.isPending) {
    return (
      <div className="flex items-center justify-center px-6 py-12 text-[12.5px] text-text-muted">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('pages.codeReviews.fetchingDiff')}
      </div>
    );
  }
  if (diffQuery.isError) {
    return (
      <div className="px-6 py-5">
        <div className="rounded-lg border border-accent-red/30 bg-accent-red/[0.06] p-4 text-[12.5px] text-accent-red">
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />
          {t('pages.codeReviews.errorFetchDiff', {
            msg: (diffQuery.error as Error)?.message ?? t('pages.codeReviews.errorUnknown'),
          })}
        </div>
      </div>
    );
  }

  const files = diffQuery.data?.files ?? [];

  return (
    <div className="flex flex-col gap-3 px-6 py-5">
      {files.length === 0 ? (
        <div className="rounded-lg border border-dashed border-hairline bg-surface-whisper p-6 text-center text-[12.5px] text-text-muted">
          {t('pages.codeReviews.emptyDiff')}
        </div>
      ) : (
        files.map((f) => (
          <DiffFileView
            key={f.filePath}
            filePath={f.filePath}
            hunk={f.hunk}
            inlineComments={commentsByFile.get(f.filePath) ?? []}
            t={t}
          />
        ))
      )}
    </div>
  );
}

function DiffFileView({
  filePath,
  hunk,
  inlineComments,
  t,
}: {
  filePath: string;
  hunk: string;
  inlineComments: CodeReviewComment[];
  t: TFunction;
}) {
  const [expanded, setExpanded] = useState(true);
  // Calcula contagem de + / - pra header
  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const line of hunk.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) add++;
      else if (line.startsWith('-') && !line.startsWith('---')) del++;
    }
    return { add, del };
  }, [hunk]);

  return (
    <section className="overflow-hidden rounded-lg border border-hairline-faint bg-white/[0.008]">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 border-b border-hairline-faint px-3 py-2 text-left transition-colors hover:bg-surface-subtle"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
        )}
        <FileCode className="h-3.5 w-3.5 text-accent-blue" />
        <span className="flex-1 truncate font-mono text-[11.5px] text-text-secondary">
          {filePath}
        </span>
        <span className="font-mono text-[10.5px] tabular-nums">
          <span className="text-accent-green">+{stats.add}</span>{' '}
          <span className="text-accent-red">-{stats.del}</span>
        </span>
        {inlineComments.length > 0 && (
          <span className="inline-flex h-5 items-center gap-0.5 rounded bg-accent-blue/15 px-1.5 text-[10px] font-medium text-accent-blue">
            <MessageSquare className="h-2.5 w-2.5" />
            {inlineComments.length}
          </span>
        )}
      </button>
      {expanded && <DiffHunkRender hunk={hunk} inlineComments={inlineComments} t={t} />}
    </section>
  );
}

function DiffHunkRender({
  hunk,
  inlineComments,
  t,
}: {
  hunk: string;
  inlineComments: CodeReviewComment[];
  t: TFunction;
}) {
  // Parseia linhas mantendo line numbers do lado novo
  const rendered = useMemo(() => {
    type DiffLine = {
      kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
      newLineNum?: number;
      oldLineNum?: number;
      content: string;
    };
    const lines: DiffLine[] = [];
    let newNum = 0;
    let oldNum = 0;
    let inHunk = false;
    for (const raw of hunk.split('\n')) {
      if (raw.startsWith('@@')) {
        const m = raw.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (m) {
          oldNum = parseInt(m[1], 10);
          newNum = parseInt(m[2], 10);
        }
        inHunk = true;
        lines.push({ kind: 'hunk', content: raw });
        continue;
      }
      if (!inHunk) {
        // headers do diff (diff --git, index, ---, +++)
        if (
          raw.startsWith('diff') ||
          raw.startsWith('index') ||
          raw.startsWith('---') ||
          raw.startsWith('+++')
        ) {
          lines.push({ kind: 'meta', content: raw });
        }
        continue;
      }
      if (raw.startsWith('+') && !raw.startsWith('+++')) {
        lines.push({ kind: 'add', newLineNum: newNum, content: raw.slice(1) });
        newNum++;
      } else if (raw.startsWith('-') && !raw.startsWith('---')) {
        lines.push({ kind: 'del', oldLineNum: oldNum, content: raw.slice(1) });
        oldNum++;
      } else if (raw.startsWith('\\')) {
        // "\ No newline at end of file"
        continue;
      } else {
        lines.push({
          kind: 'ctx',
          newLineNum: newNum,
          oldLineNum: oldNum,
          content: raw.startsWith(' ') ? raw.slice(1) : raw,
        });
        newNum++;
        oldNum++;
      }
    }
    return lines;
  }, [hunk]);

  const commentsByLine = useMemo(() => {
    const m = new Map<number, CodeReviewComment[]>();
    for (const c of inlineComments) {
      if (c.lineStart != null) {
        const list = m.get(c.lineStart) ?? [];
        list.push(c);
        m.set(c.lineStart, list);
      }
    }
    return m;
  }, [inlineComments]);

  return (
    <div className="thin-scrollbar max-h-[600px] overflow-auto bg-black/30 font-mono text-[11px] leading-[1.55]">
      {rendered.map((line, i) => {
        if (line.kind === 'meta') return null;
        if (line.kind === 'hunk') {
          return (
            <div
              key={i}
              className="border-y border-hairline-soft bg-accent-blue/[0.04] px-3 py-1 text-accent-blue/80"
            >
              {line.content}
            </div>
          );
        }
        const bg =
          line.kind === 'add'
            ? 'bg-accent-green/[0.08]'
            : line.kind === 'del'
              ? 'bg-accent-red/[0.08]'
              : '';
        const fg =
          line.kind === 'add'
            ? 'text-accent-green'
            : line.kind === 'del'
              ? 'text-accent-red'
              : 'text-text-secondary';
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        const matchingComments = line.newLineNum ? commentsByLine.get(line.newLineNum) : undefined;
        return (
          <div key={i}>
            <div className={cn('flex gap-2 px-2', bg)}>
              <span className="w-10 shrink-0 select-none text-right text-text-faint">
                {line.oldLineNum ?? ''}
              </span>
              <span className="w-10 shrink-0 select-none text-right text-text-faint">
                {line.newLineNum ?? ''}
              </span>
              <span className={cn('w-3 shrink-0 select-none', fg)}>{sign}</span>
              <span className={cn('whitespace-pre-wrap break-all', fg)}>{line.content}</span>
            </div>
            {matchingComments?.map((c) => (
              <InlineDiffComment key={c.id} comment={c} t={t} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function InlineDiffComment({ comment, t }: { comment: CodeReviewComment; t: TFunction }) {
  const queryClient = useQueryClient();
  const applyMutation = useMutation({
    mutationFn: () => window.orkestral['code-review:apply-suggestion']({ commentId: comment.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['code-review-detail'] });
    },
  });
  const meta = KIND_META[comment.kind] ?? KIND_META.suggestion;
  const Icon = meta.icon;
  return (
    <div className="border-y border-hairline-soft bg-surface-faint px-3 py-2.5 font-sans">
      <div className="flex items-start gap-2">
        <Icon className={cn('mt-0.5 h-3 w-3 shrink-0', meta.color)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className={cn('font-medium uppercase tracking-wider', meta.color)}>
              {t(meta.labelKey)}
            </span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 uppercase tracking-wider',
                comment.severity === 'critical' && 'bg-accent-red/15 text-accent-red',
                comment.severity === 'warning' && 'bg-accent-yellow/15 text-accent-yellow',
                comment.severity === 'info' && 'bg-surface-1 text-text-secondary',
              )}
            >
              {comment.severity}
            </span>
          </div>
          {comment.title && (
            <div className="mt-1 text-[12.5px] font-semibold text-text-primary">
              {comment.title}
            </div>
          )}
          <div className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-text-primary">
            {comment.message}
          </div>
          {comment.suggestion && (
            <div className="mt-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 text-[9.5px] uppercase tracking-wider text-accent-green">
                  <CornerDownRight className="h-2.5 w-2.5" />
                  {t('pages.codeReviews.suggestion')}
                </span>
                <button
                  type="button"
                  onClick={() => applyMutation.mutate()}
                  disabled={applyMutation.isPending}
                  className="inline-flex h-5 items-center gap-1 rounded border border-accent-green/30 bg-accent-green/[0.06] px-1.5 text-[10px] text-accent-green hover:bg-accent-green/15 disabled:opacity-40"
                >
                  {applyMutation.isPending ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <CornerDownRight className="h-2.5 w-2.5" />
                  )}
                  {t('pages.codeReviews.applyToLocalFile')}
                </button>
              </div>
              <CodeBlock code={comment.suggestion} lang={inferLangFromPath(comment.filePath)} />
              {applyMutation.isError && (
                <div className="mt-1 text-[10px] text-accent-red">
                  {(applyMutation.error as Error)?.message ?? t('pages.codeReviews.applyError')}
                </div>
              )}
              {applyMutation.isSuccess && (
                <div className="mt-1 text-[10px] text-accent-green">
                  {t('pages.codeReviews.appliedTo', { path: applyMutation.data?.appliedTo ?? '' })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VerdictHero({ review, t }: { review: CodeReview; t: TFunction }) {
  const recColor =
    review.recommendation === 'approve'
      ? 'text-accent-green border-accent-green/30 bg-accent-green/10'
      : review.recommendation === 'request_changes'
        ? 'text-accent-red border-accent-red/30 bg-accent-red/10'
        : 'text-text-secondary border-hairline-strong bg-surface-1';
  const recLabel =
    review.recommendation === 'approve'
      ? t('pages.codeReviews.recApprove')
      : review.recommendation === 'request_changes'
        ? t('pages.codeReviews.recRequestChanges')
        : t('pages.codeReviews.recComment');
  const RecIcon =
    review.recommendation === 'approve'
      ? ThumbsUp
      : review.recommendation === 'request_changes'
        ? ThumbsDown
        : CircleDot;

  const rating = review.rating;
  const ratingTone =
    typeof rating !== 'number'
      ? 'text-text-muted'
      : rating >= 8
        ? 'text-accent-green'
        : rating >= 5
          ? 'text-accent-yellow'
          : 'text-accent-red';

  return (
    <div className="grid gap-3 rounded-xl border border-hairline bg-surface-veil p-4 md:grid-cols-[180px_1fr]">
      <div className="flex flex-col items-center justify-center border-b border-hairline-faint pb-3 text-center md:border-b-0 md:border-r md:pb-0 md:pr-3">
        <div className="text-[10px] uppercase tracking-wider text-text-faint">
          {t('pages.codeReviews.rating')}
        </div>
        <div className={cn('mt-1 text-4xl font-bold leading-none', ratingTone)}>
          {typeof rating === 'number' ? rating.toFixed(1) : '—'}
        </div>
        <div className="mt-0.5 text-[10px] text-text-muted">/ 10</div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] font-semibold',
              recColor,
            )}
          >
            <RecIcon className="h-3 w-3" />
            {recLabel}
          </span>
          <RiskChip level={review.riskLevel} t={t} />
          {review.effort && <EffortChip effort={review.effort} t={t} />}
          <CountChips review={review} t={t} />
        </div>
        <div className="mt-1 grid gap-1 text-[11px] text-text-muted md:grid-cols-2">
          <div>
            <span className="text-text-faint">{t('pages.codeReviews.prLabel')}</span>{' '}
            <span className="text-text-secondary">
              {review.baseRef ?? '?'} ← {review.headRef ?? '?'}
            </span>
          </div>
          <div>
            <span className="text-text-faint">{t('pages.codeReviews.reviewerLabel')}</span>{' '}
            <span className="text-text-secondary">
              {review.reviewerAgentId ? t('pages.codeReviews.orkestralAgent') : '—'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RiskChip({ level, t }: { level: string | null; t: TFunction }) {
  const lvl = (level ?? 'low').toLowerCase();
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[10.5px] font-medium uppercase tracking-wider',
        lvl === 'high' && 'border-accent-red/30 bg-accent-red/10 text-accent-red',
        lvl === 'medium' && 'border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow',
        lvl === 'low' && 'border-accent-green/30 bg-accent-green/10 text-accent-green',
      )}
    >
      <TrendingUp className="h-3 w-3" />
      {t('pages.codeReviews.risk', { level: lvl })}
    </span>
  );
}

function EffortChip({ effort, t }: { effort: 'small' | 'medium' | 'large'; t: TFunction }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline-strong bg-surface-1 px-2 text-[10.5px] font-medium uppercase tracking-wider text-text-secondary">
      {t('pages.codeReviews.effort', { effort })}
    </span>
  );
}

function CountChips({ review, t }: { review: CodeReview; t: TFunction }) {
  const chips: Array<{ icon: typeof Bug; count: number; cls: string; label: string }> = [];
  if (review.bugCount)
    chips.push({
      icon: Bug,
      count: review.bugCount,
      cls: 'text-accent-red',
      label: t('pages.codeReviews.countBugs'),
    });
  if (review.securityCount)
    chips.push({
      icon: Shield,
      count: review.securityCount,
      cls: 'text-accent-red',
      label: t('pages.codeReviews.countSecurity'),
    });
  if (review.performanceCount)
    chips.push({
      icon: Zap,
      count: review.performanceCount,
      cls: 'text-accent-yellow',
      label: t('pages.codeReviews.countPerf'),
    });
  if (review.suggestionCount)
    chips.push({
      icon: Lightbulb,
      count: review.suggestionCount,
      cls: 'text-accent-blue',
      label: t('pages.codeReviews.countSuggestions'),
    });
  if (review.styleCount)
    chips.push({
      icon: Palette,
      count: review.styleCount,
      cls: 'text-accent-purple',
      label: t('pages.codeReviews.countStyle'),
    });
  if (review.questionCount)
    chips.push({
      icon: HelpCircle,
      count: review.questionCount,
      cls: 'text-text-secondary',
      label: t('pages.codeReviews.countQuestions'),
    });
  return (
    <>
      {chips.map(({ icon: Icon, count, cls, label }, i) => (
        <span
          key={i}
          className={cn(
            'inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface-faint px-2 text-[11px] font-medium',
            cls,
          )}
        >
          <Icon className="h-3 w-3" />
          {count} {label}
        </span>
      ))}
    </>
  );
}

function FilesChangedTable({ files, t }: { files: CodeReviewFileChange[]; t: TFunction }) {
  const totals = files.reduce(
    (acc, f) => {
      acc.add += f.additions;
      acc.del += f.deletions;
      return acc;
    },
    { add: 0, del: 0 },
  );
  const maxLines = Math.max(...files.map((f) => f.additions + f.deletions), 1);

  return (
    <div className="rounded-lg border border-hairline-faint bg-surface-whisper">
      <div className="flex items-center justify-between border-b border-hairline-faint px-3 py-2 text-[10.5px] text-text-muted">
        <span>
          {files.length === 1
            ? t('pages.codeReviews.fileColOne', { n: files.length })
            : t('pages.codeReviews.fileColMany', { n: files.length })}
        </span>
        <span className="font-mono">
          <span className="text-accent-green">+{totals.add}</span>{' '}
          <span className="text-accent-red">-{totals.del}</span>
        </span>
      </div>
      <div className="divide-y divide-hairline-soft">
        {files.map((f, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-1.5">
            <FileStatusIcon status={f.status} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-secondary">
              {f.filePath}
            </span>
            <span className="font-mono text-[10.5px] tabular-nums">
              <span className="text-accent-green">+{f.additions}</span>{' '}
              <span className="text-accent-red">-{f.deletions}</span>
            </span>
            <div className="flex h-2 w-20 overflow-hidden rounded-sm bg-surface-1">
              {f.additions > 0 && (
                <div
                  className="h-full bg-accent-green"
                  style={{ width: `${(f.additions / maxLines) * 100}%` }}
                />
              )}
              {f.deletions > 0 && (
                <div
                  className="h-full bg-accent-red"
                  style={{ width: `${(f.deletions / maxLines) * 100}%` }}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FileStatusIcon({ status }: { status: CodeReviewFileChange['status'] }) {
  const map = {
    added: { icon: FilePlus, cls: 'text-accent-green' },
    modified: { icon: FileCode, cls: 'text-accent-blue' },
    deleted: { icon: FileMinus, cls: 'text-accent-red' },
    renamed: { icon: FileSymlink, cls: 'text-accent-purple' },
  } as const;
  const { icon: Icon, cls } = map[status];
  return <Icon className={cn('h-3.5 w-3.5 shrink-0', cls)} />;
}

function FileCommentsGroup({
  filePath,
  comments,
  onUpdate,
  t,
}: {
  filePath: string;
  comments: CodeReviewComment[];
  onUpdate: (id: string, resolution: 'pending' | 'resolved' | 'ignored') => void;
  t: TFunction;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="overflow-hidden rounded-lg border border-hairline-faint bg-surface-whisper">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 border-b border-hairline-faint px-3 py-2 text-left transition-colors hover:bg-surface-subtle"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
        )}
        <FileCode className="h-3.5 w-3.5 text-accent-blue" />
        <span className="flex-1 font-mono text-[11.5px] text-text-secondary">{filePath}</span>
        <span className="text-[10.5px] text-text-faint">
          {comments.length === 1
            ? t('pages.codeReviews.fileColOne', { n: comments.length })
            : t('pages.codeReviews.fileColMany', { n: comments.length })}
        </span>
      </button>
      {expanded && (
        <div className="divide-y divide-hairline-soft">
          {comments.map((c) => (
            <CommentCard key={c.id} comment={c} onUpdate={(r) => onUpdate(c.id, r)} t={t} />
          ))}
        </div>
      )}
    </section>
  );
}

function CommentCard({
  comment,
  onUpdate,
  t,
}: {
  comment: CodeReviewComment;
  onUpdate: (resolution: 'pending' | 'resolved' | 'ignored') => void;
  t: TFunction;
}) {
  const meta = KIND_META[comment.kind] ?? KIND_META.suggestion;
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        'px-3 py-3 transition-opacity',
        comment.resolution !== 'pending' && 'opacity-50',
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border',
            meta.bg,
            meta.border,
          )}
        >
          <Icon className={cn('h-3 w-3', meta.color)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
            <span className={cn('font-medium uppercase tracking-wider', meta.color)}>
              {t(meta.labelKey)}
            </span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 font-medium uppercase tracking-wider',
                comment.severity === 'critical' && 'bg-accent-red/15 text-accent-red',
                comment.severity === 'warning' && 'bg-accent-yellow/15 text-accent-yellow',
                comment.severity === 'info' && 'bg-surface-1 text-text-secondary',
              )}
            >
              {comment.severity}
            </span>
            {comment.lineStart != null && (
              <span className="text-text-faint">
                {t('pages.codeReviews.lineLabel', { line: comment.lineStart })}
                {comment.lineEnd && comment.lineEnd !== comment.lineStart
                  ? `-${comment.lineEnd}`
                  : ''}
              </span>
            )}
            {comment.resolution === 'resolved' && (
              <span className="ml-auto inline-flex items-center gap-1 rounded bg-accent-green/15 px-1.5 py-0.5 text-accent-green">
                <CheckCircle2 className="h-2.5 w-2.5" />
                {t('pages.codeReviews.resolved')}
              </span>
            )}
            {comment.resolution === 'ignored' && (
              <span className="ml-auto inline-flex items-center gap-1 rounded bg-surface-1 px-1.5 py-0.5 text-text-muted">
                <X className="h-2.5 w-2.5" />
                {t('pages.codeReviews.ignored')}
              </span>
            )}
          </div>

          {comment.title && (
            <div className="mt-1.5 text-[13px] font-semibold text-text-primary">
              {comment.title}
            </div>
          )}
          <div className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-text-primary">
            {comment.message}
          </div>

          {comment.codeContext && (
            <div className="mt-2">
              <CodeBlock code={comment.codeContext} lang={inferLangFromPath(comment.filePath)} />
            </div>
          )}

          {comment.suggestion && (
            <div className="mt-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-accent-green">
                <CornerDownRight className="h-2.5 w-2.5" />
                {t('pages.codeReviews.suggestion')}
              </div>
              <CodeBlock code={comment.suggestion} lang={inferLangFromPath(comment.filePath)} />
            </div>
          )}

          <div className="mt-2.5 flex items-center gap-1">
            {comment.resolution === 'pending' ? (
              <>
                <button
                  type="button"
                  onClick={() => onUpdate('resolved')}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-hairline-strong px-2 text-[10.5px] text-text-muted hover:border-accent-green/30 hover:bg-accent-green/10 hover:text-accent-green"
                >
                  <CheckCircle2 className="h-3 w-3" />
                  {t('pages.codeReviews.resolve')}
                </button>
                <button
                  type="button"
                  onClick={() => onUpdate('ignored')}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-hairline-strong px-2 text-[10.5px] text-text-muted hover:bg-surface-1 hover:text-text-primary"
                >
                  <X className="h-3 w-3" />
                  {t('pages.codeReviews.ignore')}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => onUpdate('pending')}
                className="text-[10.5px] text-text-muted hover:text-text-primary"
              >
                {t('pages.codeReviews.reopen')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section helper + states
// ---------------------------------------------------------------------------

function Section({
  icon: Icon,
  title,
  subtitle,
  tone = 'neutral',
  children,
}: {
  icon: typeof Sparkles;
  title: string;
  subtitle?: string;
  tone?: 'neutral' | 'green' | 'amber';
  children: ReactNode;
}) {
  const iconCls =
    tone === 'green'
      ? 'text-accent-green'
      : tone === 'amber'
        ? 'text-accent-yellow'
        : 'text-text-muted';
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <Icon className={cn('h-3.5 w-3.5 translate-y-px', iconCls)} />
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary">
          {title}
        </h3>
        {subtitle && <span className="text-[11px] text-text-muted">· {subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function EmptyReview({
  onAnalyze,
  busy,
  reviewer,
  t,
}: {
  onAnalyze: () => void;
  busy: boolean;
  reviewer?: Agent;
  t: TFunction;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <Sparkles className="h-8 w-8 text-text-muted" />
      <div className="mt-3 text-[14px] font-medium text-text-primary">
        {t('pages.codeReviews.noReviewYet')}
      </div>
      <div className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-text-muted">
        {t('pages.codeReviews.emptyReviewDesc', {
          who: reviewer ? reviewer.name : t('pages.codeReviews.yourAgent'),
        })}
      </div>
      <button
        type="button"
        disabled={busy || !reviewer}
        onClick={onAnalyze}
        className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-4 text-[12.5px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        {t('pages.codeReviews.analyzeNow')}
      </button>
      {reviewer && (
        <div className="mt-3 inline-flex items-center gap-1.5 text-[10.5px] text-text-faint">
          <Bot className="h-3 w-3" />
          {t('pages.codeReviews.reviewerInfo', {
            name: reviewer.name,
            adapter: reviewer.adapterType ?? '',
          })}
          {reviewer.model && ` · ${reviewer.model}`}
        </div>
      )}
    </div>
  );
}

function FailedReview({
  error,
  stdout,
  stderr,
  onRetry,
  busy,
  t,
}: {
  error: string | null;
  stdout?: string;
  stderr?: string;
  onRetry: () => void;
  busy: boolean;
  t: TFunction;
}) {
  const [showOutput, setShowOutput] = useState(false);
  return (
    <div className="px-6 py-5">
      <div className="flex flex-col items-start gap-3 rounded-lg border border-accent-red/30 bg-accent-red/[0.06] p-4">
        <div className="flex items-center gap-2 text-[13px] font-medium text-accent-red">
          <AlertTriangle className="h-4 w-4" />
          {t('pages.codeReviews.analysisFailed')}
        </div>
        <pre className="thin-scrollbar max-h-64 w-full overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[11px] text-accent-red">
          {error ?? t('pages.codeReviews.errorUnknownFull')}
        </pre>
        {(stdout || stderr) && (
          <button
            type="button"
            onClick={() => setShowOutput((s) => !s)}
            className="inline-flex items-center gap-1 text-[10.5px] text-accent-red/80 hover:text-accent-red"
          >
            {showOutput ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {showOutput
              ? t('pages.codeReviews.hideCliOutput')
              : t('pages.codeReviews.showCliOutput')}
          </button>
        )}
        {showOutput && (
          <div className="w-full space-y-2">
            {stdout && (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-text-faint">
                  stdout
                </div>
                <pre className="thin-scrollbar max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[10.5px] text-text-secondary">
                  {stdout}
                </pre>
              </div>
            )}
            {stderr && (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-text-faint">
                  stderr
                </div>
                <pre className="thin-scrollbar max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[10.5px] text-accent-yellow">
                  {stderr}
                </pre>
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onRetry}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-red/40 px-3 text-[12px] font-medium text-accent-red hover:bg-accent-red/10 disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {t('common.retry')}
        </button>
      </div>
    </div>
  );
}

const PHASE_ORDER = ['fetch', 'prompt', 'spawn', 'analyzing', 'parse'];

function phaseLabelFor(phase: string, t: TFunction): string {
  const map: Record<string, string> = {
    fetch: 'pages.codeReviews.phaseFetch',
    prompt: 'pages.codeReviews.phasePrompt',
    spawn: 'pages.codeReviews.phaseSpawn',
    analyzing: 'pages.codeReviews.phaseAnalyzing',
    parse: 'pages.codeReviews.phaseParse',
  };
  return map[phase] ? t(map[phase]) : phase;
}

const TIP_KEYS = [
  'pages.codeReviews.tip1',
  'pages.codeReviews.tip2',
  'pages.codeReviews.tip3',
  'pages.codeReviews.tip4',
  'pages.codeReviews.tip5',
];

function AnalyzingState({
  phase,
  reviewer,
  stdout,
  stderr,
  startedAt,
  t,
}: {
  phase: { phase: string; message: string } | null;
  reviewer?: Agent;
  stdout?: string;
  stderr?: string;
  /** ISO timestamp de quando a review começou — usado pra contador persistente. */
  startedAt?: string;
  t: TFunction;
}) {
  // Timer baseado em startedAt (não no mount), pra sobreviver ao remount
  const [elapsed, setElapsed] = useState(() => {
    if (!startedAt) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  });
  const [tipIdx, setTipIdx] = useState(0);
  useEffect(() => {
    const tickerStart = startedAt ? new Date(startedAt).getTime() : Date.now();
    const t = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - tickerStart) / 1000)));
    }, 1000);
    const tipTimer = setInterval(() => {
      setTipIdx((i) => (i + 1) % TIP_KEYS.length);
    }, 5000);
    return () => {
      clearInterval(t);
      clearInterval(tipTimer);
    };
  }, [startedAt]);

  const phaseLabel = phase ? phaseLabelFor(phase.phase, t) : t('pages.codeReviews.starting');
  const currentPhaseIdx = phase ? PHASE_ORDER.indexOf(phase.phase) : -1;

  return (
    <div className="flex flex-col gap-5 px-6 py-6">
      {/* Hero com spinner + timer + reviewer chip */}
      <div className="flex flex-col items-center rounded-xl border border-hairline bg-surface-whisper py-8 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent-blue" />
        <div className="mt-3 text-[14px] font-medium text-text-primary">{phaseLabel}</div>
        <div className="mt-1.5 max-w-md px-4 text-[12px] leading-relaxed text-text-muted">
          {phase?.message ?? t('pages.codeReviews.preparingAnalysis')}
        </div>
        <div className="mt-3 flex items-center gap-2 text-[10.5px] text-text-faint">
          <Clock className="h-3 w-3" />
          <span className="font-mono tabular-nums">{fmtElapsed(elapsed)}</span>
        </div>
        {reviewer && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-hairline bg-surface-faint px-2 py-1 text-[10.5px] text-text-secondary">
            <Bot className="h-3 w-3 text-text-muted" />
            {reviewer.name}
            <span className="text-text-faint">·</span>
            <span className="font-mono">{reviewer.adapterType}</span>
            {reviewer.model && (
              <>
                <span className="text-text-faint">·</span>
                <span className="font-mono">{reviewer.model}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Passos */}
      <div className="rounded-lg border border-hairline bg-surface-whisper p-4">
        <div className="mb-3 text-[10px] font-medium uppercase tracking-wider text-text-faint">
          {t('pages.codeReviews.progress')}
        </div>
        <ol className="flex flex-col gap-2">
          {PHASE_ORDER.map((p, idx) => {
            const done = currentPhaseIdx > idx;
            const active = currentPhaseIdx === idx;
            return (
              <li key={p} className="flex items-center gap-2.5 text-[12px]">
                {done ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent-green" />
                ) : active ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-blue" />
                ) : (
                  <CircleDot className="h-3.5 w-3.5 shrink-0 text-text-faint" />
                )}
                <span
                  className={cn(
                    done
                      ? 'text-text-secondary line-through decoration-text-faint/40'
                      : active
                        ? 'font-medium text-text-primary'
                        : 'text-text-muted',
                  )}
                >
                  {phaseLabelFor(p, t)}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Dica rotativa */}
      <div className="rounded-md border border-hairline-soft bg-surface-whisper px-3 py-2 text-[11.5px] text-text-muted">
        <Sparkles className="mr-1.5 inline h-3 w-3 text-text-faint" />
        <span className="italic">{t(TIP_KEYS[tipIdx])}</span>
      </div>

      {/* Live output do CLI — só aparece se houver algo */}
      {(stdout || stderr) && (
        <div className="rounded-lg border border-hairline bg-black/30 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-faint">
            <Terminal className="h-3 w-3" />
            {t('pages.codeReviews.realtimeOutput')}
          </div>
          {stdout && (
            <pre className="thin-scrollbar max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-text-secondary">
              {stdout}
            </pre>
          )}
          {stderr && (
            <pre className="thin-scrollbar mt-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-accent-yellow">
              {stderr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function fmtElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-center text-[13px] text-text-muted">
      <div className="max-w-md px-6">{children}</div>
    </div>
  );
}

function ListEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center px-6 py-12 text-center text-[12px] text-text-muted">
      {children}
    </div>
  );
}

export function PageShell({
  title,
  description,
  children,
  toolbar,
  back,
}: {
  title: string;
  description: string;
  children: ReactNode;
  toolbar?: ReactNode;
  /** Botão de voltar à esquerda. Recebe handler. */
  back?: () => void;
}) {
  const { t } = useT();
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <div className="window-drag flex flex-wrap items-start justify-between gap-x-3 gap-y-2.5 border-b border-hairline-soft px-8 py-5">
          <div className="flex min-w-0 items-start gap-3">
            {back && (
              <button
                type="button"
                onClick={back}
                className="window-no-drag mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary"
                title={t('common.back')}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-[18px] font-semibold tracking-tight text-text-primary">
                {title}
              </h1>
              <p className="truncate text-[12.5px] text-text-muted">{description}</p>
            </div>
          </div>
          {toolbar && <div className="window-no-drag shrink-0">{toolbar}</div>}
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

function fmtRelative(iso: string, t: TFunction): string {
  try {
    const d = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return t('pages.codeReviews.relNow');
    if (diff < 3600) return t('pages.codeReviews.relMin', { n: Math.floor(diff / 60) });
    if (diff < 86400) return t('pages.codeReviews.relHour', { n: Math.floor(diff / 3600) });
    return t('pages.codeReviews.relDay', { n: Math.floor(diff / 86400) });
  } catch {
    return iso;
  }
}
