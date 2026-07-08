import { Download, Check, Star, Loader2, ArrowUpRight } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { MarketplaceIcon } from './MarketplaceIcon';
import { PricingBadge } from './PricingBadge';
import { formatStars, logoSrc, type MarketplaceCatalogItem } from './shared';

interface MarketplaceCardProps {
  item: MarketplaceCatalogItem;
  installed: boolean;
  installing?: boolean;
  onOpen: () => void;
  onInstall: () => void;
}

/** Card de um item do marketplace — clica no corpo pra abrir o detalhe. */
export function MarketplaceCard({
  item,
  installed,
  installing,
  onOpen,
  onInstall,
}: MarketplaceCardProps) {
  const { t } = useT();
  const stars = formatStars(item.stars);
  const src = logoSrc(item);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group relative flex h-full flex-col rounded-xl border bg-surface-veil p-4 text-left transition-colors',
        'hover:bg-surface-3',
        installed
          ? 'border-accent-green/25 hover:border-accent-green/40'
          : 'border-hairline-med hover:border-hairline-bright',
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-md border border-hairline-strong bg-surface-1 text-text-secondary">
          <MarketplaceIcon
            iconKey={item.iconKey}
            src={src}
            kind={item.kind}
            className="h-[15px] w-[15px]"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-text-primary">{item.name}</div>
        </div>
        <PricingBadge pricing={item.pricing} />
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-text-faint transition-colors group-hover:text-text-secondary" />
      </div>

      <p className="mt-2.5 line-clamp-2 flex-1 text-[12px] leading-relaxed text-text-muted">
        {item.description}
      </p>

      <div className="mt-3.5 flex items-center justify-between gap-2">
        {item.category ? (
          <span className="truncate rounded border border-hairline-heavy bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-text-secondary">
            {item.category}
          </span>
        ) : (
          <span />
        )}

        <div className="flex shrink-0 items-center gap-2.5">
          {stars && (
            <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
              <Star className="h-3 w-3" />
              {stars}
            </span>
          )}
          {installed ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-green">
              <Check className="h-3 w-3" />
              {t('pages.marketplace.installed')}
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onInstall();
              }}
              disabled={installing}
              className="inline-flex items-center gap-1 rounded-md border border-hairline-heavy bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent-purple/40 hover:bg-accent-purple/15 hover:text-text-primary disabled:opacity-50"
            >
              {installing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {t('pages.marketplace.install')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
