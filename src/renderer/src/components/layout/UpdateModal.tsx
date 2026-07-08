import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, Download } from 'lucide-react';
import { useT } from '@renderer/i18n';
import rocketImg from '@renderer/assets/update-rocket.png';

const DISMISS_PREFIX = 'orkestral:update-dismissed:';
const REFETCH_MS = 6 * 60 * 60 * 1000;

type Phase = 'idle' | 'downloading' | 'done' | 'failed';

/**
 * Modal de atualização — boot-check via GitHub Releases. Substitui o banner antigo
 * por um card bonito (foguete). O botão baixa o instalador DENTRO do app (progresso
 * em barra) e abre o instalador no fim — sem mandar pro navegador. No macOS sem
 * assinatura ainda é instalação manual (arrastar pra Applications); Win/Linux têm o
 * auto-update seamless separado (electron-updater).
 */
export function UpdateModal() {
  const { t } = useT();
  const { data } = useQuery({
    queryKey: ['update:check'],
    queryFn: () => window.orkestral['update:check'](),
    staleTime: REFETCH_MS,
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: false,
  });

  const version = data?.latestVersion ?? null;
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);

  const persistedDismiss =
    version != null && localStorage.getItem(DISMISS_PREFIX + version) === '1';
  const show = Boolean(data?.hasUpdate) && !dismissed && !persistedDismiss;

  useEffect(() => {
    if (typeof window.orkestralEvents?.onUpdateDownloadProgress !== 'function') return;
    return window.orkestralEvents.onUpdateDownloadProgress((p) => {
      if (p.failed) {
        setPhase('failed');
        return;
      }
      setPercent(p.percent);
      if (p.done) setPhase('done');
    });
  }, []);

  const dismiss = (): void => {
    if (version) localStorage.setItem(DISMISS_PREFIX + version, '1');
    setDismissed(true);
  };

  const startUpdate = (): void => {
    const url = data?.url;
    if (!url) return;
    setPhase('downloading');
    setPercent(0);
    void window.orkestral['update:download']({ url });
  };

  const onPrimary = (): void => {
    if (phase === 'done') dismiss();
    else startUpdate();
  };

  const bullets = [t('layout.update.b1'), t('layout.update.b2'), t('layout.update.b3')];
  const busy = phase === 'downloading';

  return (
    <AnimatePresence>
      {show && data && (
        <motion.div
          key="update-modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="window-no-drag fixed inset-0 z-[300] grid place-items-center bg-black/55 p-6 backdrop-blur-sm"
        >
          <motion.div
            key="update-modal-card"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-[380px] overflow-hidden rounded-2xl border border-hairline-strong bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
          >
            {/* Foguete com fade pro card */}
            <div className="relative h-[196px] w-full">
              <img
                src={rocketImg}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
              />
              <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-surface to-transparent" />
            </div>

            <div className="-mt-2 px-6 pb-6">
              <h2 className="text-center text-[19px] font-bold tracking-tight text-text-primary">
                {t('layout.update.available')}
              </h2>
              <p className="mx-auto mt-1.5 max-w-[300px] text-center text-[13px] leading-snug text-text-secondary">
                {t('layout.update.modalDesc')}
              </p>

              <ul className="mx-auto mt-4 max-w-[300px] space-y-1.5">
                {bullets.map((b, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[12.5px] leading-snug text-text-secondary"
                  >
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent-purple" />
                    {b}
                  </li>
                ))}
              </ul>

              {(phase === 'downloading' || phase === 'done') && (
                <div className="mt-4">
                  <div className="mb-1 flex justify-between text-[11px] font-medium text-text-muted">
                    <span>
                      {phase === 'done'
                        ? t('layout.update.installHint')
                        : t('layout.update.downloading')}
                    </span>
                    <span className="tabular-nums">{percent}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-strong">
                    <div
                      className="h-full rounded-full bg-accent-purple transition-[width] duration-300"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="mt-5 space-y-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onPrimary}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent-purple to-accent-blue text-[14px] font-semibold text-white shadow-[0_8px_24px_rgba(124,92,255,0.35)] transition-opacity hover:opacity-95 disabled:opacity-60"
                >
                  {busy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('layout.update.downloading')}
                    </>
                  ) : phase === 'done' ? (
                    t('layout.update.close')
                  ) : (
                    <>
                      <Download className="h-4 w-4" />
                      {phase === 'failed' ? t('layout.update.retry') : t('layout.update.updateNow')}
                    </>
                  )}
                </button>
                {phase !== 'done' && (
                  <button
                    type="button"
                    onClick={dismiss}
                    className="h-11 w-full rounded-xl border border-accent-purple/30 text-[14px] font-medium text-accent-purple transition-colors hover:bg-accent-purple/10"
                  >
                    {t('layout.update.remindLater')}
                  </button>
                )}
              </div>

              {phase === 'failed' && (
                <p className="mt-2 text-center text-[11.5px] text-accent-red">
                  {t('layout.update.failed')}
                </p>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
