import { DollarSign } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';

/**
 * Selo de cobrança. Só renderiza pra 'freemium' (tier grátis + planos pagos) e
 * 'paid' (exige licença/uso pago) — itens livres não ganham selo.
 */
export function PricingBadge({
  pricing,
  className,
}: {
  pricing?: 'free' | 'freemium' | 'paid';
  className?: string;
}) {
  const { t } = useT();
  if (!pricing || pricing === 'free') return null;
  const isPaid = pricing === 'paid';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full border border-accent-green/30 bg-accent-green/10 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-accent-green',
        className,
      )}
      title={
        isPaid
          ? t('pages.marketplace.pricingTitlePaid')
          : t('pages.marketplace.pricingTitleFreemium')
      }
    >
      <DollarSign className="h-2.5 w-2.5" />
      {isPaid ? t('pages.marketplace.pricingPaid') : t('pages.marketplace.pricingFreemium')}
    </span>
  );
}
