import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * Peças reutilizáveis das views do Docker (Volumes/Images/Networks): layout de duas
 * colunas (lista + detalhe) e os blocos de "Info" no estilo OrbStack.
 */

export function TwoPane({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div className="grid h-full grid-cols-[300px_1fr]">
      <div className="min-h-0 overflow-y-auto border-r border-border">{list}</div>
      <div className="min-h-0">{detail}</div>
    </div>
  );
}

export function EmptyDetail({ label }: { label: string }) {
  return <div className="grid h-full place-items-center text-sm text-text-muted">{label}</div>;
}

export function InfoScroll({ children }: { children: ReactNode }) {
  return (
    <div className="thin-scrollbar h-full space-y-5 overflow-y-auto p-4 font-sans text-text-secondary">
      {children}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-hairline-soft bg-surface-faint">
      {children}
    </div>
  );
}

export function Row({
  label,
  value,
  mono,
  divider,
}: {
  label: string;
  value: string;
  mono?: boolean;
  divider?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 px-3.5 py-2.5',
        divider && 'border-t border-hairline-faint',
      )}
    >
      <span className="shrink-0 text-[12.5px] text-text-muted">{label}</span>
      <span
        className={cn('min-w-0 truncate text-[12.5px] text-text-primary', mono && 'font-mono')}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-text-faint">
        {title}
      </h3>
      {children}
    </div>
  );
}

/** Tabela Key/Value (Labels). Trunca com tooltip; não vaza de coluna. */
export function KVTable({ rows }: { rows: [string, string][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-hairline-soft bg-surface-faint">
      <table className="w-full table-fixed">
        <thead>
          <tr className="bg-surface-1">
            <th className="px-3.5 py-2 text-left text-[11px] font-medium text-text-muted">Key</th>
            <th className="px-3.5 py-2 text-left text-[11px] font-medium text-text-muted">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-hairline-faint">
              <td className="max-w-0 px-3.5 py-2 align-top">
                <span
                  className="block truncate font-mono text-[12px] text-text-secondary"
                  title={k}
                >
                  {k}
                </span>
              </td>
              <td className="max-w-0 px-3.5 py-2 align-top">
                <span
                  className="block truncate font-mono text-[12px] text-text-secondary"
                  title={v}
                >
                  {v}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
