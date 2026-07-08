import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';

interface PanelShellProps {
  title: string;
  description?: string;
  /** Ícone opcional no cabeçalho (badge). */
  icon?: LucideIcon;
  /** Badge "em breve" ao lado do título. */
  soon?: boolean;
  children: ReactNode;
}

/**
 * Shell padrão de um painel de configurações.
 * Cabeçalho (ícone badge + título + descrição), depois as seções com
 * espaçamento vertical que respeita a densidade escolhida (--density-gap).
 */
export function PanelShell({ title, description, icon: Icon, soon, children }: PanelShellProps) {
  const { t } = useT();
  return (
    <div className="flex flex-col">
      <header className="flex items-start gap-3 pb-6">
        {Icon && (
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-accent-purple/25 bg-accent-purple/15">
            <Icon className="h-4 w-4 text-accent-purple" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[19px] font-semibold tracking-tight text-text-primary">{title}</h2>
            {soon && (
              <span className="rounded-full border border-hairline-heavy px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-faint">
                {t('settings.panelShell.soonBadge')}
              </span>
            )}
          </div>
          {description && (
            <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">{description}</p>
          )}
        </div>
      </header>
      <div className="flex flex-col" style={{ gap: 'var(--density-gap, 1.25rem)' }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Card de seção — agrupa controls relacionados num bloco bordado (estilo
 * DevSenses). Panels podem usar pra organizar visualmente.
 */
export function SettingsSection({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-hairline bg-surface-veil p-5', className)}>
      {(title || description) && (
        <div className="mb-4">
          {title && <div className="text-[13px] font-semibold text-text-primary">{title}</div>}
          {description && (
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">
              {description}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text-primary">{label}</div>
        {description && (
          <div className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  right,
}: {
  label: string;
  description?: string;
  right: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text-primary">{label}</div>
        {description && (
          <div className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{description}</div>
        )}
      </div>
      <div className="flex shrink-0 justify-end">{right}</div>
    </div>
  );
}
