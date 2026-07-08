import * as DialogPrimitive from '@radix-ui/react-dialog';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-radix-dialog-overlay
    style={{ zIndex: 100 }}
    className={cn('fixed inset-0 bg-black/55 backdrop-blur-[3px]', className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    {/* Constrange a modal pra nunca colar nas bordas da janela:
     * top/bottom 48px, com flexbox pra centralizar verticalmente quando cabe
     * e permitir scroll interno quando o conteúdo é maior que o viewport. */}
    <DialogPrimitive.Content
      ref={ref}
      data-radix-dialog-content
      style={{ zIndex: 101, pointerEvents: 'auto', background: 'var(--color-dialog)' }}
      className={cn(
        // window-no-drag: sem isso, regiões `-webkit-app-region: drag` (sidebar,
        // header) interceptam o clique no nível da janela mesmo sob a modal,
        // deixando o X e os botões não-clicáveis no Electron.
        'window-no-drag fixed left-1/2 top-1/2 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2',
        'flex max-h-[calc(100vh-96px)] flex-col overflow-hidden',
        'rounded-xl border border-hairline-strong text-text-primary shadow-2xl shadow-black/40',
        'focus:outline-none',
        className,
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-4 top-4 z-10 rounded-md p-1.5 text-text-muted hover:bg-surface-active hover:text-text-primary focus:outline-none">
          <X className="h-4 w-4" />
          <span className="sr-only">Fechar</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-xl font-semibold tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-text-secondary', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
