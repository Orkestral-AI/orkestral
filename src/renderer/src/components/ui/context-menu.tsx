import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@renderer/lib/utils';

/**
 * Menu de contexto leve (estilo GitHub Desktop) — zero dependências externas.
 *
 * Uso:
 *   const ctx = useContextMenu();
 *   <div onContextMenu={ctx.open}> … </div>
 *   {ctx.state && (
 *     <ContextMenu x={ctx.state.x} y={ctx.state.y} onClose={ctx.close} items={[…]} />
 *   )}
 *
 * Fecha em: click fora, Escape, scroll, resize, blur da janela.
 */

export type ContextMenuItem =
  | { type: 'separator' }
  | { type: 'label'; label: string }
  | {
      type?: 'item';
      label: string;
      icon?: ReactNode;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      hint?: string;
    };

export interface ContextMenuState {
  x: number;
  y: number;
}

export function useContextMenu(): {
  state: ContextMenuState | null;
  open: (e: React.MouseEvent) => void;
  close: () => void;
} {
  const [state, setState] = useState<ContextMenuState | null>(null);
  const open = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY });
  }, []);
  const close = useCallback(() => setState(null), []);
  return { state, open, close };
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Reposiciona dentro da viewport depois de medir.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let nx = x;
    let ny = y;
    if (x + rect.width + pad > window.innerWidth)
      nx = Math.max(pad, window.innerWidth - rect.width - pad);
    if (y + rect.height + pad > window.innerHeight)
      ny = Math.max(pad, window.innerHeight - rect.height - pad);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = () => onClose();
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    window.addEventListener('scroll', onScroll, true);
    // pointerdown na captura → fecha antes de qualquer click interno conflitar
    window.addEventListener('mousedown', onPointer, true);
    window.addEventListener('contextmenu', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('mousedown', onPointer, true);
      window.removeEventListener('contextmenu', onPointer, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[1000] min-w-[200px] select-none overflow-hidden rounded-lg border border-hairline-strong p-1 shadow-2xl shadow-black/50 backdrop-blur-xl"
      style={{ left: pos.x, top: pos.y, background: 'var(--color-dialog)' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.type === 'separator') {
          return <div key={`sep-${i}`} className="my-1 h-px bg-hairline" />;
        }
        if (item.type === 'label') {
          return (
            <div
              key={`lbl-${i}`}
              className="px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wider text-text-faint"
            >
              {item.label}
            </div>
          );
        }
        return (
          <button
            key={`item-${i}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
              item.disabled
                ? 'cursor-not-allowed text-text-faint opacity-50'
                : item.danger
                  ? 'text-accent-red hover:bg-accent-red/15'
                  : 'text-text-secondary hover:bg-surface-active hover:text-text-primary',
            )}
          >
            {item.icon && (
              <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">{item.icon}</span>
            )}
            <span className="flex-1 truncate">{item.label}</span>
            {item.hint && (
              <span className="shrink-0 text-[10.5px] text-text-faint">{item.hint}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
