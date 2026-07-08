import type { JSX } from 'react';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, CheckCircle2, XCircle, AlertTriangle, KeyRound, Settings2 } from 'lucide-react';
import type { AdapterDescriptor } from '@shared/types';
import { ProviderIcon } from '@renderer/components/ProviderIcon';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';

interface KeyStatus {
  supportsApiKey: boolean;
  apiKeyConfigured: boolean;
}

/**
 * Card de um PROVEDOR (adapter) na página Provedores. Mostra o provedor (logo, nome,
 * descrição), o status do CLI (testável sob demanda) e — quando o provedor aceita —
 * o campo de API key (cifrada no main, nunca volta em claro pro renderer). O usuário
 * configura por CLI (login/keychain) OU colando a key aqui.
 */
export function ProviderConfigCard({
  descriptor,
  keyStatus,
}: {
  descriptor: AdapterDescriptor;
  keyStatus: KeyStatus;
}): JSX.Element {
  const { t } = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');

  const test = useMutation({
    mutationFn: () => window.orkestral['adapter:test']({ type: descriptor.type }),
  });

  const saveKey = useMutation({
    mutationFn: (value: string) =>
      window.orkestral['provider:set-key']({ type: descriptor.type, apiKey: value }),
    onSuccess: () => {
      setApiKey('');
      void qc.invalidateQueries({ queryKey: ['provider-key-status'] });
    },
  });
  const clearKey = useMutation({
    mutationFn: () => window.orkestral['provider:clear-key']({ type: descriptor.type }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['provider-key-status'] }),
  });

  const status = test.data?.status; // 'pass' | 'warn' | 'fail'

  return (
    <div className="group relative flex h-full flex-col rounded-xl border border-hairline-med bg-surface-veil p-4 transition-colors hover:border-hairline-bright">
      <div className="flex items-center gap-2.5">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-hairline-strong bg-surface-1">
          <ProviderIcon provider={descriptor.type} className="h-[15px] w-[15px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-text-primary">
            {descriptor.name}
          </div>
        </div>
        {keyStatus.apiKeyConfigured && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded border border-accent-green/30 bg-accent-green/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-green">
            <KeyRound className="h-3 w-3" />
            API key
          </span>
        )}
      </div>

      <p className="mt-2.5 line-clamp-2 text-[12px] leading-relaxed text-text-muted">
        {descriptor.description}
      </p>

      {open && (
        <div className="mt-3 flex flex-col gap-2 rounded-lg border border-hairline bg-surface-faint p-2.5">
          {keyStatus.supportsApiKey ? (
            <>
              <label className="text-[11px] font-medium text-text-secondary">
                {t('pages.providers.apiKeyLabel')}
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    keyStatus.apiKeyConfigured
                      ? t('pages.providers.apiKeySet')
                      : t('pages.providers.apiKeyPlaceholder')
                  }
                  className="h-8 flex-1 rounded-md border border-hairline-strong bg-surface-subtle px-2.5 text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
                />
                <button
                  type="button"
                  disabled={!apiKey.trim() || saveKey.isPending}
                  onClick={() => saveKey.mutate(apiKey)}
                  className="inline-flex h-8 items-center rounded-md bg-accent px-2.5 text-[11.5px] font-medium text-white transition-opacity hover:bg-accent/90 disabled:opacity-50"
                >
                  {saveKey.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t('common.save')
                  )}
                </button>
              </div>
              {keyStatus.apiKeyConfigured && (
                <button
                  type="button"
                  onClick={() => clearKey.mutate()}
                  className="self-start text-[11px] text-text-muted underline-offset-2 hover:text-accent-red hover:underline"
                >
                  {t('pages.providers.clearKey')}
                </button>
              )}
            </>
          ) : (
            <div className="text-[11px] text-text-muted">{t('pages.providers.cliOnly')}</div>
          )}

          <button
            type="button"
            disabled={test.isPending}
            onClick={() => test.mutate()}
            className="mt-1 inline-flex h-7 w-fit items-center gap-1.5 rounded-md border border-hairline-heavy bg-surface-2 px-2.5 text-[11.5px] font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
          >
            {test.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Settings2 className="h-3.5 w-3.5" />
            )}
            {t('pages.providers.testCli')}
          </button>
          {status && (
            <div
              className={cn(
                'flex items-start gap-1.5 text-[11px]',
                status === 'pass'
                  ? 'text-accent-green'
                  : status === 'warn'
                    ? 'text-accent-yellow'
                    : 'text-accent-red',
              )}
            >
              {status === 'pass' ? (
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
              ) : status === 'warn' ? (
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              ) : (
                <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
              )}
              <span>{test.data?.message ?? status}</span>
            </div>
          )}
        </div>
      )}

      <div className="mt-3.5 flex items-center justify-between gap-2">
        <span className="truncate rounded border border-hairline-heavy bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-text-secondary">
          {descriptor.recommended
            ? t('pages.providers.recommended')
            : t('pages.providers.category')}
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-hairline-heavy bg-surface-2 px-3 text-[11.5px] font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          <Settings2 className="h-3.5 w-3.5" />
          {open ? t('common.close') : t('pages.providers.configure')}
        </button>
      </div>
    </div>
  );
}
