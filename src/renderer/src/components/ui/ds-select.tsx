import { type ReactNode } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { cn } from '@renderer/lib/utils';

export interface DSSelectOption {
  value: string;
  label: string;
  /** Hint/right-aligned text (ex: o ID do modelo em mono). */
  hint?: string;
  /** Custom node antes do label (ex: ícone). */
  icon?: ReactNode;
  /** Tag/pill DEPOIS do label (ex: "Recomendado"). Aparece no trigger e na lista. */
  badge?: ReactNode;
  /** Renderiza o label em cor apagada no trigger (ex: opção "vazio"/placeholder). */
  muted?: boolean;
}

/**
 * Sentinel usado internamente pra contornar a restrição do Radix Select
 * que proíbe value="". Quando uma opção tem value vazio, mapeamos pra
 * esse valor no Radix e convertemos de volta no onChange.
 */
const EMPTY_SENTINEL = '__ds_empty__';

/**
 * Select customizado padrão do app. Usa Radix Select sob o capô (já estilado
 * com bg #1B1C1E + border white/8% + items com highlight). Aceita lista de
 * opções simples + opcionalmente um hint à direita pra mostrar valor cru
 * (ex: ID do modelo).
 *
 * Suporta value="" via sentinel interno — útil pra opção "— Nenhum —".
 */
export function DSSelect({
  value,
  onChange,
  options,
  placeholder,
  className,
  inline,
  onboarding,
}: {
  value: string;
  onChange: (value: string) => void;
  options: DSSelectOption[];
  placeholder?: string;
  className?: string;
  /** Variante sem bordas — botão "fantasma" que destaca só no hover. */
  inline?: boolean;
  /**
   * Variante onboarding: o popover usa o MESMO fundo do seletor de repositório
   * do GitHub (#0b0a10, borda white/8%, highlight white/5%) em vez do
   * --color-dialog (cinza). Não muda o select em nenhum outro lugar.
   */
  onboarding?: boolean;
}) {
  const internalValue = value === '' ? EMPTY_SENTINEL : value;
  const selected = options.find((o) => o.value === value);
  return (
    <Select value={internalValue} onValueChange={(v) => onChange(v === EMPTY_SENTINEL ? '' : v)}>
      <SelectTrigger
        className={cn(
          // w-full + min-w-0: o trigger inline nunca estoura o container — o valor
          // trunca em vez de empurrar a largura (mata o scroll-x na sidebar da issue).
          inline &&
            'h-8 w-full min-w-0 rounded-md border-transparent bg-transparent px-2 hover:bg-surface-active focus:border-transparent focus:ring-0',
          className,
        )}
      >
        <SelectValue placeholder={placeholder} className="min-w-0 flex-1 text-left">
          {selected ? (
            <span
              className={cn('flex min-w-0 items-center gap-2', selected.muted && 'text-text-faint')}
            >
              {selected.icon}
              <span className="truncate">{selected.label}</span>
              {selected.badge}
            </span>
          ) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        className={onboarding ? 'border-hairline-strong' : undefined}
        style={onboarding ? { background: '#0b0a10' } : undefined}
      >
        {options.map((opt) => (
          <SelectItem
            key={opt.value || EMPTY_SENTINEL}
            value={opt.value === '' ? EMPTY_SENTINEL : opt.value}
            className={onboarding ? 'data-[highlighted]:bg-surface-2' : undefined}
          >
            <span className="flex items-center gap-2">
              {opt.icon}
              <span>{opt.label}</span>
              {opt.badge}
              {opt.hint && (
                <span className="ml-auto pl-3 font-mono text-[10.5px] text-text-faint">
                  {opt.hint}
                </span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
