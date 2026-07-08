import { useMemo, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { cn } from '@renderer/lib/utils';

/**
 * DatePicker custom — substitui o `<input type="date">` nativo (feio, não
 * tematiza). Popover (portal, tema dark/light via tokens) com calendário.
 *
 * value/onChange usam o formato ISO curto "YYYY-MM-DD" (igual o input date),
 * pra ser drop-in. Display em dd/mm/aaaa.
 */
const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseISO(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function DatePicker({
  value,
  onChange,
  placeholder = 'dd/mm/aaaa',
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => parseISO(value), [value]);
  const [view, setView] = useState<Date>(() => selected ?? new Date());

  const display = selected
    ? `${String(selected.getDate()).padStart(2, '0')}/${String(selected.getMonth() + 1).padStart(2, '0')}/${selected.getFullYear()}`
    : null;

  const grid = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const cells: Array<{ date: Date; inMonth: boolean }> = [];
    // Dias do mês anterior (preenchimento)
    for (let i = startDow - 1; i >= 0; i--) {
      cells.push({ date: new Date(view.getFullYear(), view.getMonth(), -i), inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(view.getFullYear(), view.getMonth(), d), inMonth: true });
    }
    // Completa a última semana
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1].date;
      cells.push({
        date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1),
        inMonth: false,
      });
    }
    return cells;
  }, [view]);

  const todayISO = toISO(new Date());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-9 w-full items-center gap-2 rounded-md border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 text-[13px] transition-colors hover:border-border-strong focus:outline-none',
            className,
          )}
        >
          <Calendar className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          <span
            className={cn('flex-1 text-left', display ? 'text-text-primary' : 'text-text-faint')}
          >
            {display ?? placeholder}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[260px] p-2">
        {/* Header: mês/ano + navegação */}
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[12.5px] font-medium capitalize text-text-primary">
            {MONTHS[view.getMonth()]} de {view.getFullYear()}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
              className="grid h-6 w-6 place-items-center rounded text-text-muted transition-colors hover:bg-surface-1 hover:text-text-primary"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
              className="grid h-6 w-6 place-items-center rounded text-text-muted transition-colors hover:bg-surface-1 hover:text-text-primary"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Dias da semana */}
        <div className="grid grid-cols-7 gap-0.5 px-0.5 pb-1">
          {WEEKDAYS.map((w, i) => (
            <div
              key={i}
              className="grid h-6 place-items-center text-[10px] font-medium text-text-faint"
            >
              {w}
            </div>
          ))}
        </div>

        {/* Grid de dias */}
        <div className="grid grid-cols-7 gap-0.5 px-0.5">
          {grid.map(({ date, inMonth }, i) => {
            const iso = toISO(date);
            const isSelected = iso === value;
            const isToday = iso === todayISO;
            return (
              <button
                key={i}
                type="button"
                onClick={() => {
                  onChange(iso);
                  setOpen(false);
                }}
                className={cn(
                  'grid h-7 place-items-center rounded text-[12px] tabular-nums transition-colors',
                  isSelected
                    ? 'bg-accent text-white'
                    : cn(
                        inMonth ? 'text-text-primary' : 'text-text-faint',
                        'hover:bg-surface-1',
                        isToday && 'ring-1 ring-accent-purple/50',
                      ),
                )}
              >
                {date.getDate()}
              </button>
            );
          })}
        </div>

        {/* Rodapé: limpar / hoje */}
        <div className="mt-2 flex items-center justify-between border-t border-hairline-soft px-1 pt-2">
          <button
            type="button"
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
            className="text-[11.5px] text-text-muted transition-colors hover:text-text-primary"
          >
            Limpar
          </button>
          <button
            type="button"
            onClick={() => {
              onChange(todayISO);
              setView(new Date());
              setOpen(false);
            }}
            className="text-[11.5px] font-medium text-accent-purple transition-colors hover:opacity-80"
          >
            Hoje
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
