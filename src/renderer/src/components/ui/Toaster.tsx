import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertCircle, Info, X, Check } from 'lucide-react';
import { useToastStore, type ToastTone } from '@renderer/stores/toastStore';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';

const TONE: Record<
  ToastTone,
  { Icon: typeof CheckCircle2; ring: string; icon: string; glow: string; progress: string }
> = {
  success: {
    Icon: CheckCircle2,
    ring: 'border-accent-green/30',
    icon: 'text-accent-green',
    glow: 'bg-accent-green/12',
    progress: 'bg-accent-green',
  },
  error: {
    Icon: AlertCircle,
    ring: 'border-accent-red/30',
    icon: 'text-accent-red',
    glow: 'bg-accent-red/12',
    progress: 'bg-accent-red',
  },
  info: {
    Icon: Info,
    ring: 'border-accent-purple/30',
    icon: 'text-accent-purple',
    glow: 'bg-accent-purple/12',
    progress: 'bg-accent-purple',
  },
};

/** Stack de toasts no canto inferior-direito. Montado uma vez no App. */
export function Toaster() {
  const { t } = useT();
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="window-no-drag pointer-events-none fixed bottom-4 right-4 z-[200] flex w-[340px] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const tone = TONE[toast.tone];
          const Icon = tone.Icon;
          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 28, scale: 0.96 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                'pointer-events-auto flex items-start gap-3 rounded-xl border bg-surface/95 pl-4 pr-5 pt-3.5 pb-4 shadow-[0_8px_30px_rgba(0,0,0,0.4)] backdrop-blur',
                tone.ring,
              )}
            >
              <span
                className={cn(
                  'mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full',
                  tone.glow,
                )}
              >
                <Icon className={cn('h-4 w-4', tone.icon)} />
              </span>
              <div className="min-w-0 flex-1">
                {/* Corpo clicável (ex.: ir pra Caixa de entrada). */}
                <div
                  className={cn(toast.onClick && 'cursor-pointer')}
                  onClick={
                    toast.onClick
                      ? () => {
                          toast.onClick?.();
                          dismiss(toast.id);
                        }
                      : undefined
                  }
                >
                  <div className="text-[12.5px] font-semibold text-text-primary">{toast.title}</div>
                  {toast.description && (
                    <div className="mt-0.5 break-words text-[11.5px] leading-snug text-text-muted">
                      {toast.description}
                    </div>
                  )}
                </div>
                {toast.action && (
                  <button
                    type="button"
                    onClick={() => {
                      toast.action?.onClick();
                      dismiss(toast.id);
                    }}
                    className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-accent-green/15 px-2.5 text-[11.5px] font-medium text-accent-green transition-colors hover:bg-accent-green/25"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {toast.action.label}
                  </button>
                )}
                {typeof toast.progress === 'number' && (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-strong">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all duration-300',
                        tone.progress,
                      )}
                      style={{ width: `${Math.max(0, Math.min(100, toast.progress))}%` }}
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="-mr-1 shrink-0 rounded p-0.5 text-text-faint transition-colors hover:text-text-primary"
                aria-label={t('layout.ui.close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
