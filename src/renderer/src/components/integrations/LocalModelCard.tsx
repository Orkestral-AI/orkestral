import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Wand2, Loader2, CheckCircle2, Download } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { IntegrationCardShell } from './IntegrationCardShell';

type LocalModel = 'embeddings' | 'fast-apply';

/**
 * Card de download de modelo local (fast-apply e embeddings). O download robusto
 * (retry/backoff/resume) vive no model-download-service. O progresso vem do evento
 * global `models:download-progress`: a BARRA só acende quando ESTE card disparou o
 * download (`active`), mas o fim (`done`) revalida o status sempre — assim um download
 * LAZY em background (ex.: embeddings disparados pela KB) também faz o card virar
 * "Instalado" sem reabrir a aba.
 */
export function LocalModelCard({ model }: { model: LocalModel }): JSX.Element {
  const { t } = useT();
  const qc = useQueryClient();
  const active = useRef(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window.orkestralEvents?.onModelDownloadProgress !== 'function') return;
    return window.orkestralEvents.onModelDownloadProgress((p) => {
      if (p.done) {
        // Um download terminou — pode ter sido o LAZY (disparado pela KB/busca semântica
        // em background, SEM passar por este card; típico do embedder). Revalida o status
        // SEMPRE pra "Baixar" virar "Instalado" sem reabrir a aba. O progresso/erro local
        // só mexe quando foi ESTE card que disparou (active).
        if (active.current) {
          active.current = false;
          setPercent(null);
          if (p.failed) setError(t('pages.integrations.models.failed'));
        }
        void qc.invalidateQueries({ queryKey: ['model-status', model] });
      } else if (active.current) {
        setPercent(p.percent);
      }
    });
  }, [qc, t, model]);

  const statusQuery = useQuery({
    queryKey: ['model-status', model],
    queryFn: () =>
      model === 'fast-apply'
        ? window.orkestral['models:fast-apply-status']()
        : window.orkestral['models:embeddings-status'](),
    staleTime: 10_000,
  });
  const present = statusQuery.data?.present ?? false;
  const downloading = statusQuery.data?.downloading ?? false;
  const busy = downloading || percent !== null;

  const download = useMutation({
    mutationFn: () =>
      model === 'fast-apply'
        ? window.orkestral['models:download-fast-apply']()
        : window.orkestral['models:download-embeddings'](),
    onMutate: () => {
      setError(null);
      setPercent(0);
      active.current = true;
    },
    onError: (e) => {
      active.current = false;
      setPercent(null);
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  let action: JSX.Element;
  if (statusQuery.isPending) {
    action = <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />;
  } else if (busy) {
    action = (
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('pages.integrations.models.downloading')}
      </span>
    );
  } else if (present) {
    action = (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-green">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {t('pages.integrations.models.installed')}
      </span>
    );
  } else {
    action = (
      <button
        type="button"
        onClick={() => download.mutate()}
        className="inline-flex items-center gap-1 rounded-md border border-hairline-heavy bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent-purple/40 hover:bg-accent-purple/15 hover:text-text-primary"
      >
        <Download className="h-3 w-3" />
        {error ? t('pages.integrations.models.errorRetry') : t('pages.integrations.models.install')}
      </button>
    );
  }

  const progressFooter = (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center justify-between text-[10.5px] font-medium text-text-secondary">
        <span>{t('pages.integrations.models.downloading')}</span>
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

  const name = t(
    model === 'fast-apply'
      ? 'pages.integrations.fastApply.name'
      : 'pages.integrations.embeddings.name',
  );
  const description = t(
    model === 'fast-apply'
      ? 'pages.integrations.fastApply.description'
      : 'pages.integrations.embeddings.description',
  );

  const badge = present ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent-green/25 bg-accent-green/10 py-0.5 pl-1 pr-2 text-[10px] font-medium text-accent-green">
      <CheckCircle2 className="h-3 w-3" />
      {t('pages.integrations.models.installed')}
    </span>
  ) : undefined;

  return (
    <IntegrationCardShell
      icon={model === 'fast-apply' ? Wand2 : Boxes}
      name={name}
      description={description}
      category={t('pages.integrations.models.category')}
      badge={badge}
      action={action}
      footerOverride={busy ? progressFooter : undefined}
    />
  );
}
