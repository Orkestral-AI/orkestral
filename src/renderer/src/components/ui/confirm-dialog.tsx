import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';

/**
 * Modal de confirmação reutilizável — substitui o `confirm()` nativo do SO.
 * Renderizado via portal no document.body com overlay próprio (window-no-drag),
 * pra ficar acima de qualquer stacking context do Electron. O caller monta
 * condicionalmente (ex.: `{pending && <ConfirmDialog … onCancel=… />}`).
 */
export function ConfirmDialog({
  title,
  body,
  icon,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  variant = 'danger',
  busy = false,
  warning,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: ReactNode;
  icon?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
  busy?: boolean;
  warning?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isDanger = variant === 'danger';
  return createPortal(
    <div
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: 99999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          WebkitAppRegion: 'no-drag',
        } as CSSProperties
      }
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-dialog"
        style={
          {
            position: 'relative',
            zIndex: 100000,
            pointerEvents: 'auto',
            border: '1px solid var(--color-hairline, rgba(255,255,255,0.08))',
            borderRadius: 12,
            padding: 24,
            width: '100%',
            maxWidth: 440,
            boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            WebkitAppRegion: 'no-drag',
          } as CSSProperties
        }
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
              isDanger ? 'bg-accent-red/10' : 'bg-surface-1',
            )}
          >
            {icon ?? (
              <Trash2
                className={cn('h-4 w-4', isDanger ? 'text-accent-red' : 'text-text-primary')}
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold tracking-tight text-text-primary">
              {title}
            </div>
            {body && (
              <div className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">{body}</div>
            )}
            {warning && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{warning}</span>
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            className={cn(isDanger && 'bg-accent-red text-white hover:bg-accent-red/90')}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
