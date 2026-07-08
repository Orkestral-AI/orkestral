import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Regex,
  Replace,
  WholeWord,
  X,
  Folder,
  Ellipsis,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { getFileIconUrl } from '@renderer/lib/materialIcons';
import { useT } from '@renderer/i18n';
import { useCodeIdeStore } from '@renderer/stores/codeIdeStore';
import { useCodeTabsStore } from '@renderer/stores/codeTabsStore';
import { toast } from '@renderer/stores/toastStore';

type SearchMatch = { line: number; column: number; preview: string };
type SearchFile = { relPath: string; matches: SearchMatch[] };
type SearchResult = {
  results: SearchFile[];
  truncated: boolean;
  fileCount: number;
  matchCount: number;
};

/** Per-source result group produced by the fan-out query. */
type SourceGroup = {
  sourceId: string;
  sourceLabel: string;
  files: SearchFile[];
  truncated: boolean;
};

export type SearchSource = { id: string; label: string; path: string };

const baseName = (p: string) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildHighlightRegex(
  query: string,
  opts: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
): RegExp | null {
  if (!query) return null;
  try {
    let pattern = opts.regex ? query : escapeRegExp(query);
    if (opts.wholeWord) pattern = `\\b${pattern}\\b`;
    return new RegExp(pattern, `g${opts.caseSensitive ? '' : 'i'}`);
  } catch {
    return null;
  }
}

function Highlighted({ preview, regex }: { preview: string; regex: RegExp | null }) {
  if (!regex) return <>{preview}</>;
  // Clone into a local matcher so we never mutate the shared prop instance.
  const matcher = new RegExp(regex.source, regex.flags);
  const parts: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = matcher.exec(preview)) !== null && guard < 1000) {
    guard++;
    if (m.index > last) parts.push({ text: preview.slice(last, m.index), hit: false });
    parts.push({ text: m[0] || '', hit: true });
    last = m.index + (m[0]?.length || 0);
    if (m[0] === '') matcher.lastIndex++; // avoid zero-width infinite loop
  }
  if (last < preview.length) parts.push({ text: preview.slice(last), hit: false });
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <span key={i} className="rounded bg-accent-purple/25 text-text-primary">
            {p.text}
          </span>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

function Toggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn('flex h-6 w-6 items-center justify-center rounded transition-colors', {
        'bg-accent-purple/20 text-accent-purple': active,
        'text-text-muted hover:bg-surface-subtle hover:text-text-secondary': !active,
      })}
    >
      {children}
    </button>
  );
}

function FileGroup({
  collapseKey,
  file,
  collapsed,
  onToggleCollapse,
  highlight,
  onOpenMatch,
}: {
  /** Unique key used for collapse state — must be unique across sources. */
  collapseKey: string;
  file: SearchFile;
  collapsed: boolean;
  onToggleCollapse: (key: string) => void;
  highlight: RegExp | null;
  onOpenMatch: (relPath: string, line: number) => void;
}) {
  const name = baseName(file.relPath);
  const iconUrl = getFileIconUrl(name);
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleCollapse(collapseKey)}
        className="flex h-7 w-full items-center gap-1 rounded-md px-1 text-left text-text-secondary transition-colors hover:bg-surface-subtle hover:text-text-primary"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        )}
        {iconUrl ? (
          <img src={iconUrl} className="h-4 w-4 shrink-0" alt="" />
        ) : (
          <FileIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
        )}
        <span className="truncate">{name}</span>
        <span className="ml-auto shrink-0 rounded bg-surface-subtle px-1.5 text-[11px] text-text-muted">
          {file.matches.length}
        </span>
      </button>
      {!collapsed &&
        file.matches.map((match, i) => (
          <button
            key={`${match.line}:${match.column}:${i}`}
            type="button"
            onClick={() => onOpenMatch(file.relPath, match.line)}
            className="flex w-full items-start gap-2 rounded-md py-1 pl-7 pr-2 text-left transition-colors hover:bg-surface-subtle"
          >
            <span className="w-9 shrink-0 text-right tabular-nums text-text-faint">
              {match.line}
            </span>
            <span className="min-w-0 truncate font-mono text-text-secondary">
              <Highlighted preview={match.preview} regex={highlight} />
            </span>
          </button>
        ))}
    </div>
  );
}

export function SearchPanel({ sources }: { sources: SearchSource[] }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const openTab = useCodeTabsStore((s) => s.openTab);
  const requestGoTo = useCodeIdeStore((s) => s.requestGoTo);
  const focusSearch = useCodeIdeStore((s) => s.focusSearch);
  const searchScope = useCodeIdeStore((s) => s.searchScope);
  const setSearchScope = useCodeIdeStore((s) => s.setSearchScope);

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [replacement, setReplacement] = useState('');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [debInclude, setDebInclude] = useState('');
  const [debExclude, setDebExclude] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  // Collapse state keyed by `sourceId + ' ' + relPath` for uniqueness across sources.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Debounce dos campos que disparam busca (query + globs include/exclude).
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebounced(query);
      setDebInclude(include);
      setDebExclude(exclude);
    }, 250);
    return () => window.clearTimeout(id);
  }, [query, include, exclude]);

  // Focus on mount and whenever focusSearch changes.
  useEffect(() => {
    inputRef.current?.focus();
  }, [focusSearch]);

  const opts = { caseSensitive, wholeWord, regex };

  // When scope is set, only search that one source; else fan out to all.
  const sourcesToSearch = searchScope
    ? sources.filter((s) => s.id === searchScope.sourceId)
    : sources;

  const sourceIds = sourcesToSearch.map((s) => s.id);

  const search = useQuery<SourceGroup[]>({
    queryKey: [
      'source-search-multi',
      sourceIds,
      debounced,
      caseSensitive,
      wholeWord,
      regex,
      searchScope,
      debInclude,
      debExclude,
    ],
    enabled: debounced.trim().length > 0 && sourcesToSearch.length > 0,
    retry: false,
    queryFn: async () => {
      const results = await Promise.all(
        sourcesToSearch.map(async (src) => {
          try {
            const res: SearchResult = await window.orkestral['source:search']({
              sourceId: src.id,
              query: debounced,
              opts: { caseSensitive, wholeWord, regex },
              scope: searchScope?.sourceId === src.id ? searchScope.relPath : undefined,
              include: debInclude || undefined,
              exclude: debExclude || undefined,
            });
            return {
              sourceId: src.id,
              sourceLabel: src.label,
              files: res.results,
              truncated: res.truncated,
            } satisfies SourceGroup;
          } catch {
            // Non-text or errored source: return empty group.
            return {
              sourceId: src.id,
              sourceLabel: src.label,
              files: [],
              truncated: false,
            } satisfies SourceGroup;
          }
        }),
      );
      return results;
    },
  });

  const groups = search.data ?? [];
  const totalMatchCount = groups.reduce(
    (acc, g) => acc + g.files.reduce((a, f) => a + f.matches.length, 0),
    0,
  );
  const totalFileCount = groups.reduce((acc, g) => acc + g.files.length, 0);
  const anyTruncated = groups.some((g) => g.truncated);

  const highlight = useMemo(
    () => buildHighlightRegex(debounced, opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debounced, caseSensitive, wholeWord, regex],
  );

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const handleOpenMatch = (sourceId: string, relPath: string, line: number) => {
    openTab(sourceId, relPath, baseName(relPath));
    requestGoTo(sourceId, relPath, line);
  };

  const canReplace = replacement.length > 0 && totalMatchCount > 0;

  const handleReplaceAll = async () => {
    if (totalMatchCount === 0) return;
    if (
      !window.confirm(
        t('layout.codeIde.search.replaceConfirm', {
          occurrences: totalMatchCount,
          files: totalFileCount,
        }),
      )
    )
      return;

    let totalOccurrences = 0;
    let hadError = false;

    for (const src of sourcesToSearch) {
      try {
        const res = await window.orkestral['source:replace-all']({
          sourceId: src.id,
          query: debounced,
          replacement,
          opts,
          scope: searchScope?.sourceId === src.id ? searchScope.relPath : undefined,
          include: debInclude || undefined,
          exclude: debExclude || undefined,
        });
        totalOccurrences += res.occurrences;
        queryClient.invalidateQueries({ queryKey: ['source-file', src.id] });
        queryClient.invalidateQueries({ queryKey: ['source-search-multi'] });
      } catch (err) {
        hadError = true;
        const msg = (err as Error)?.message;
        toast.error(
          msg === 'bad-regex'
            ? t('layout.codeIde.search.badRegex')
            : t('layout.codeIde.search.replaceAll'),
        );
        break;
      }
    }

    if (!hadError) {
      toast.success(t('layout.codeIde.search.replaced', { occurrences: totalOccurrences }));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto text-[12.5px]">
      {/* Header — chevron de replace + query/replace + filtros de arquivo (estilo VS Code) */}
      <div className="flex items-start gap-1 border-b border-hairline-soft p-2">
        <button
          type="button"
          onClick={() => setShowReplace((v) => !v)}
          title={t('layout.codeIde.search.toggleReplace')}
          aria-label={t('layout.codeIde.search.toggleReplace')}
          aria-expanded={showReplace}
          className="mt-0.5 grid h-7 w-4 shrink-0 place-items-center rounded text-text-faint transition-colors hover:text-text-secondary"
        >
          {showReplace ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="relative flex items-center">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('layout.codeIde.search.placeholder')}
              className="h-7 w-full rounded border border-hairline bg-surface-1 py-1 pl-2 pr-[5.5rem] text-text-primary outline-none focus:border-accent-purple/40"
            />
            <div className="absolute right-1 flex items-center gap-0.5">
              <Toggle
                active={caseSensitive}
                label={t('layout.codeIde.search.caseSensitive')}
                onClick={() => setCaseSensitive((v) => !v)}
              >
                <CaseSensitive className="h-4 w-4" />
              </Toggle>
              <Toggle
                active={wholeWord}
                label={t('layout.codeIde.search.wholeWord')}
                onClick={() => setWholeWord((v) => !v)}
              >
                <WholeWord className="h-4 w-4" />
              </Toggle>
              <Toggle
                active={regex}
                label={t('layout.codeIde.search.regex')}
                onClick={() => setRegex((v) => !v)}
              >
                <Regex className="h-4 w-4" />
              </Toggle>
            </div>
          </div>

          {showReplace && (
            <div className="relative flex items-center">
              <input
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                placeholder={t('layout.codeIde.search.replacePlaceholder')}
                className="h-7 w-full rounded border border-hairline bg-surface-1 py-1 pl-2 pr-8 text-text-primary outline-none focus:border-accent-purple/40"
              />
              <button
                type="button"
                disabled={!canReplace}
                onClick={handleReplaceAll}
                title={t('layout.codeIde.search.replaceAll')}
                aria-label={t('layout.codeIde.search.replaceAll')}
                className={cn('absolute right-1 flex h-6 w-6 items-center justify-center rounded', {
                  'text-text-muted hover:bg-surface-subtle hover:text-text-secondary': canReplace,
                  'cursor-not-allowed text-text-faint': !canReplace,
                })}
              >
                <Replace className="h-4 w-4" />
              </button>
            </div>
          )}

          {showFilters && (
            <div className="flex flex-col gap-1">
              <label className="text-[10.5px] font-medium uppercase tracking-wider text-text-faint">
                {t('layout.codeIde.search.filesToInclude')}
              </label>
              <input
                value={include}
                onChange={(e) => setInclude(e.target.value)}
                placeholder={t('layout.codeIde.search.includePlaceholder')}
                className="h-7 w-full rounded border border-hairline bg-surface-1 px-2 py-1 text-text-primary outline-none focus:border-accent-purple/40"
              />
              <label className="mt-0.5 text-[10.5px] font-medium uppercase tracking-wider text-text-faint">
                {t('layout.codeIde.search.filesToExclude')}
              </label>
              <input
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
                placeholder={t('layout.codeIde.search.excludePlaceholder')}
                className="h-7 w-full rounded border border-hairline bg-surface-1 px-2 py-1 text-text-primary outline-none focus:border-accent-purple/40"
              />
            </div>
          )}

          {searchScope && (
            <div className="flex items-center gap-1.5 rounded border border-hairline bg-surface-1 px-1.5 py-1 text-text-secondary">
              <Folder className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate" title={searchScope.relPath}>
                {searchScope.relPath}
              </span>
              <button
                type="button"
                onClick={() => setSearchScope(null)}
                title={t('layout.codeIde.search.clearScope')}
                aria-label={t('layout.codeIde.search.clearScope')}
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-subtle hover:text-text-primary"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          title={t('layout.codeIde.search.toggleFilters')}
          aria-label={t('layout.codeIde.search.toggleFilters')}
          aria-pressed={showFilters}
          className={cn(
            'mt-0.5 grid h-7 w-6 shrink-0 place-items-center rounded transition-colors',
            {
              'bg-accent-purple/20 text-accent-purple': showFilters,
              'text-text-faint hover:bg-surface-subtle hover:text-text-secondary': !showFilters,
            },
          )}
        >
          <Ellipsis className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2">
        {debounced.trim().length === 0 ? (
          <p className="px-1 text-text-muted">{t('layout.codeIde.search.emptyHint')}</p>
        ) : search.isLoading ? (
          <p className="px-1 text-text-muted">{t('layout.codeIde.search.searching')}</p>
        ) : search.isError ? (
          <p className="px-1 text-rose-400">{t('layout.codeIde.search.badRegex')}</p>
        ) : groups.length > 0 ? (
          <>
            <div className="px-1 pb-1.5 text-text-muted">
              {t('layout.codeIde.search.resultsCount', {
                matches: totalMatchCount,
                files: totalFileCount,
              })}
            </div>
            {anyTruncated && (
              <div className="px-1 pb-1.5 text-[11px] text-text-faint">
                {t('layout.codeIde.search.truncated')}
              </div>
            )}
            {totalMatchCount === 0 ? (
              <p className="px-1 text-text-muted">{t('layout.codeIde.search.noResults')}</p>
            ) : (
              <div className="flex flex-col">
                {groups
                  .filter((g) => g.files.length > 0)
                  .map((group) => (
                    <div key={group.sourceId} className="mb-2">
                      {/* Source header — only shown when multiple sources are present. */}
                      {!searchScope && sources.length > 1 && (
                        <div className="mb-0.5 flex items-center gap-1 px-1 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-faint">
                          <Folder className="h-3 w-3 shrink-0" />
                          <span className="truncate">{group.sourceLabel}</span>
                        </div>
                      )}
                      {group.files.map((file) => {
                        const collapseKey = `${group.sourceId} ${file.relPath}`;
                        return (
                          <FileGroup
                            key={collapseKey}
                            collapseKey={collapseKey}
                            file={file}
                            collapsed={collapsed.has(collapseKey)}
                            onToggleCollapse={toggleCollapse}
                            highlight={highlight}
                            onOpenMatch={(relPath, line) =>
                              handleOpenMatch(group.sourceId, relPath, line)
                            }
                          />
                        );
                      })}
                    </div>
                  ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
