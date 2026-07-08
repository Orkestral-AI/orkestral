import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from './popover';
import { cn } from '@renderer/lib/utils';

export interface ComboOption {
  value: string;
  label: string;
  /** Texto extra pra busca (não exibido). */
  keywords?: string;
  /** Ícone antes do label. */
  icon?: ReactNode;
}

/**
 * Select COM BUSCA (combobox) — Radix Popover + input que filtra as options +
 * navegação por teclado. Substitui o `<select>` nativo (cuja lista é o dropdown
 * feio do SO) por uma lista estilizada e pesquisável, igual ao resto do app.
 */
export function ComboSelect({
  value,
  options,
  onChange,
  placeholder = 'Selecionar…',
  searchPlaceholder = 'Buscar…',
  inline,
  align = 'start',
  className,
  /** Mantém o valor selecionado visível (default). Em pickers "+ adicionar" use false. */
  showSelected = true,
}: {
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  inline?: boolean;
  align?: 'start' | 'center' | 'end';
  className?: string;
  showSelected?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = showSelected ? options.find((o) => o.value === value) : undefined;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.keywords ?? ''}`.toLowerCase().includes(q));
  }, [options, query]);

  function commit(v: string): void {
    onChange(v);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[active];
      if (opt) commit(opt.value);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setQuery('');
          setActive(0);
          setTimeout(() => inputRef.current?.focus(), 0);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition-colors',
            inline
              ? 'border border-transparent bg-transparent hover:bg-surface-active'
              : 'border border-[var(--color-input-border)] bg-[var(--color-input-bg)] hover:bg-surface-hover',
            className,
          )}
        >
          {selected?.icon}
          <span className={cn('flex-1 truncate', !selected && 'text-text-muted')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-[var(--radix-popover-trigger-width)] min-w-[240px] p-0"
      >
        <div className="flex items-center gap-2 border-b border-hairline px-2.5 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="h-5 w-full bg-transparent text-[12.5px] text-text-primary placeholder:text-text-faint focus:outline-none"
          />
        </div>
        <div className="max-h-[260px] overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-center text-[12px] text-text-muted">Nada encontrado</div>
          ) : (
            filtered.map((o, i) => (
              <button
                key={o.value || '__empty__'}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(o.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]',
                  i === active ? 'bg-surface-active text-text-primary' : 'text-text-secondary',
                )}
              >
                {o.icon}
                <span className="flex-1 truncate">{o.label}</span>
                {showSelected && o.value === value && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-accent-purple" />
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
