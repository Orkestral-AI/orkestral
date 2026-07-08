import type { JSX } from 'react';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Loader2, CheckCircle2, Download, X } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { IntegrationCardShell } from './IntegrationCardShell';

/**
 * Card de Transcrição Local (Whisper) — instala/remove o Voice Pack (~575 MB)
 * sob demanda. Compartilha a query key ['voice','status'] com o DictateButton,
 * então instalar aqui ativa automaticamente o botão de ditado.
 *
 * Simplificações em relação ao branch feat/voice-wake-word:
 * - useVoiceStore removido (não existe em main)
 * - onVoiceInstallProgress removido (não exposto em OrkestralEvents em main)
 * - Progresso mostrado via mutation.isPending + mensagem "Instalando…"
 */
export function VoiceIntegrationCard(): JSX.Element {
  const { t } = useT();
  const qc = useQueryClient();
  const [installError, setInstallError] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => {
    const off = window.orkestralEvents.onVoiceInstallProgress((ev) => {
      if (ev.type === 'start') setPercent(0);
      else if (ev.type === 'progress') setPercent(Math.round(ev.percent));
      else if (ev.type === 'done' || ev.type === 'error') {
        setPercent(null);
        void qc.invalidateQueries({ queryKey: ['voice'] });
      }
    });
    return off;
  }, [qc]);

  const statusQuery = useQuery({
    queryKey: ['voice', 'status'],
    queryFn: () => window.orkestral['voice:get-status'](),
    staleTime: 10_000,
  });
  const status = statusQuery.data ?? null;
  const installed = status?.installed ?? false;

  const installMutation = useMutation({
    mutationFn: () => window.orkestral['voice:install'](),
    onMutate: () => {
      setInstallError(null);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['voice'] });
    },
    onError: (e) => {
      setInstallError(e instanceof Error ? e.message : String(e));
      void qc.invalidateQueries({ queryKey: ['voice'] });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: () => window.orkestral['voice:uninstall'](),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['voice'] });
    },
  });

  const isInstalling =
    installMutation.isPending || (status?.installing ?? false) || percent !== null;

  let action: JSX.Element;
  if (statusQuery.isPending) {
    action = <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />;
  } else if (isInstalling) {
    action = (
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('pages.integrations.voice.installing')}
      </span>
    );
  } else if (installError) {
    action = (
      <button
        type="button"
        onClick={() => installMutation.mutate()}
        className="inline-flex items-center gap-1 rounded-md border border-accent-red/40 bg-accent-red/15 px-2 py-1 text-[11px] font-medium text-text-primary"
      >
        <Download className="h-3 w-3" />
        {t('pages.integrations.voice.errorRetry')}
      </button>
    );
  } else if (installed) {
    action = (
      <button
        type="button"
        onClick={() => uninstallMutation.mutate()}
        disabled={uninstallMutation.isPending}
        className="inline-flex items-center gap-1 rounded-md border border-hairline-heavy bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent-red/40 hover:bg-accent-red/15 hover:text-text-primary disabled:opacity-50"
      >
        {uninstallMutation.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <X className="h-3 w-3" />
        )}
        {t('pages.integrations.voice.remove')}
      </button>
    );
  } else {
    action = (
      <button
        type="button"
        onClick={() => installMutation.mutate()}
        className="inline-flex items-center gap-1 rounded-md border border-hairline-heavy bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent-purple/40 hover:bg-accent-purple/15 hover:text-text-primary"
      >
        <Download className="h-3 w-3" />
        {t('pages.integrations.voice.install')}
      </button>
    );
  }

  const progressFooter = (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center justify-between text-[10.5px] font-medium text-text-secondary">
        <span>{t('pages.integrations.voice.downloading')}</span>
        <span className="tabular-nums">{percent ?? 0}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-strong">
        <div
          className="h-full rounded-full bg-accent-purple transition-[width] duration-300"
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
    </div>
  );

  return (
    <IntegrationCardShell
      icon={AudioLines}
      name={t('pages.integrations.voice.name')}
      description={t('pages.integrations.voice.description')}
      category={t('pages.integrations.voice.category')}
      badge={
        installed ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent-green/25 bg-accent-green/10 py-0.5 pl-1 pr-2 text-[10px] font-medium text-accent-green">
            <CheckCircle2 className="h-3 w-3" />
            {t('pages.integrations.voice.installed')}
          </span>
        ) : undefined
      }
      action={action}
      footerOverride={isInstalling ? progressFooter : undefined}
    />
  );
}
