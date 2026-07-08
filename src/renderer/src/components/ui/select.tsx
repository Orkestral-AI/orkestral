import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '@renderer/lib/utils';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 text-[13px] text-text-primary',
      'transition-colors hover:bg-surface-hover focus:outline-none focus:border-[var(--color-input-border-focus)] focus:ring-1 focus:ring-hairline-strong',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[placeholder]:text-text-muted',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', style, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={4}
      // Default = --color-dialog; um `style` passado pelo caller faz override
      // (ex: onboarding usa um fundo arroxeado próprio). Merge, não substitui.
      style={{ background: 'var(--color-dialog)', zIndex: 200, ...style }}
      className={cn(
        'relative min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-hairline-strong text-text-primary shadow-xl shadow-black/40',
        position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
        className,
      )}
      {...props}
    >
      {/* Limita à altura disponível no lado preferido (popper) e rola — assim o
          conteúdo cabe abaixo do trigger em vez de "flipar" pra cima. */}
      <SelectPrimitive.Viewport className="thin-scrollbar max-h-[min(24rem,var(--radix-select-content-available-height))] overflow-y-auto p-1">
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-pointer select-none items-center rounded-md py-1.5 pl-8 pr-2.5 text-[13px] text-text-secondary outline-none',
      'data-[highlighted]:bg-surface-active data-[highlighted]:text-text-primary',
      'data-[state=checked]:text-text-primary',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-3.5 w-3.5" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;
