import { Check, Globe } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { ProviderIcon } from '@renderer/components/ProviderIcon';
import { useT } from '@renderer/i18n';
import { ALL_MODELS_SCOPE, type ModelScopeOption } from './shared';

/** Toggle visual (não interativo) — o clique vem do container. Acento roxo. */
function Toggle({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        on ? 'bg-accent-purple' : 'border border-border bg-surface-elevated',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
          on ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </span>
  );
}

interface ModelScopeManagerProps {
  options: ModelScopeOption[];
  /** Scopes selecionados. `['*']` = todos os modelos. */
  value: string[];
  onChange: (scopes: string[]) => void;
}

/**
 * Seleciona em quais modelos um MCP fica habilitado. "Todos os modelos" (`*`)
 * é o default — garante que trocar o adapter do agente mantém o MCP ativo.
 */
export function ModelScopeManager({ options, value, onChange }: ModelScopeManagerProps) {
  const { t } = useT();
  const allModels = value.length === 0 || value.includes(ALL_MODELS_SCOPE);

  function toggleAll(next: boolean) {
    if (next) onChange([ALL_MODELS_SCOPE]);
    else onChange([]);
  }

  function toggleScope(scope: string) {
    const base = value.filter((s) => s !== ALL_MODELS_SCOPE);
    const next = base.includes(scope) ? base.filter((s) => s !== scope) : [...base, scope];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => toggleAll(!allModels)}
        className={cn(
          'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
          allModels
            ? 'border-accent-purple/40 bg-accent-purple/[0.07]'
            : 'border-border bg-surface hover:bg-surface-elevated',
        )}
      >
        <Globe
          className={cn('h-4 w-4 shrink-0', allModels ? 'text-accent-purple' : 'text-text-muted')}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-text-primary">
            {t('pages.marketplace.allModels')}
          </div>
          <div className="text-[11px] text-text-muted">{t('pages.marketplace.allModelsDesc')}</div>
        </div>
        <Toggle on={allModels} />
      </button>

      {!allModels && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-2">
          <div className="px-1 pb-1 text-[10.5px] font-medium uppercase tracking-wide text-text-faint">
            {t('pages.marketplace.specificModels')}
          </div>
          {options.length === 0 ? (
            <div className="px-1 py-1.5 text-[11.5px] text-text-muted">
              {t('pages.marketplace.noAgentsUseAll')}
            </div>
          ) : (
            options.map((opt) => {
              const checked = value.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggleScope(opt.value)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                    checked ? 'bg-surface-active' : 'hover:bg-surface-hover',
                  )}
                >
                  <span
                    className={cn(
                      'grid h-4 w-4 shrink-0 place-items-center rounded border',
                      checked
                        ? 'border-accent-purple bg-accent-purple text-white'
                        : 'border-border',
                    )}
                  >
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <ProviderIcon
                    provider={opt.value.split(':')[0]}
                    className="h-3.5 w-3.5 text-text-secondary"
                  />
                  <span className="flex-1 truncate text-[12.5px] text-text-secondary">
                    {opt.label}
                  </span>
                  <span className="font-mono text-[10px] text-text-faint">
                    {opt.count}{' '}
                    {opt.count === 1 ? t('pages.marketplace.agent') : t('pages.marketplace.agents')}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
