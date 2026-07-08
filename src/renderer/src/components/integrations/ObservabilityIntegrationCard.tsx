import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Activity, CheckCircle2, Loader2, Plug, Signal, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT } from '@renderer/i18n';
import { IntegrationCardShell } from './IntegrationCardShell';
import type { LucideIcon } from 'lucide-react';

type Provider = 'new_relic' | 'better_stack';

export function ObservabilityIntegrationCard({ provider }: { provider: Provider }) {
  const { t } = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceStore((s) => s.active?.id);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const providerName = t(`observability.providers.${provider}`);
  const description =
    provider === 'new_relic'
      ? t('observability.card.newRelicDescription')
      : t('observability.card.betterStackDescription');
  const Icon = provider === 'new_relic' ? Activity : Signal;
  const accountQuery = useQuery({
    queryKey: ['observability', 'account', provider, workspaceId],
    queryFn: () =>
      window.orkestral['observability:get-account']({ workspaceId: workspaceId!, provider }),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
  const account = accountQuery.data ?? null;

  async function handleDisconnect() {
    if (!workspaceId) return;
    setDisconnecting(true);
    try {
      await window.orkestral['observability:disconnect']({ workspaceId, provider });
      await qc.invalidateQueries({ queryKey: ['observability'] });
    } finally {
      setDisconnecting(false);
    }
  }

  const action = accountQuery.isPending ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />
  ) : account ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void handleDisconnect();
      }}
      disabled={disconnecting}
      className="inline-flex items-center gap-1 rounded-md border border-hairline-heavy bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent-red/40 hover:bg-accent-red/15 hover:text-text-primary disabled:opacity-50"
    >
      {disconnecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
      {t('observability.card.disconnect')}
    </button>
  ) : (
    <button
      type="button"
      onClick={() => setDialogOpen(true)}
      className="inline-flex items-center gap-1 rounded-md border border-hairline-heavy bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent-purple/40 hover:bg-accent-purple/15 hover:text-text-primary"
    >
      <Plug className="h-3 w-3" />
      {t('observability.card.connect')}
    </button>
  );

  const shell = (
    <IntegrationCardShell
      icon={Icon as LucideIcon}
      name={providerName}
      description={description}
      category={t('observability.card.category')}
      badge={
        account ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent-green/25 bg-accent-green/10 py-0.5 pl-1 pr-2 text-[10px] font-medium text-accent-green">
            <CheckCircle2 className="h-3 w-3" />
            {account.displayName ?? providerName}
          </span>
        ) : undefined
      }
      action={action}
    />
  );

  return (
    <>
      {account ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => navigate(`/observability/${provider}`)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(`/observability/${provider}`);
          }}
          className="cursor-pointer rounded-xl outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          {shell}
        </div>
      ) : (
        shell
      )}
      <ObservabilityConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        provider={provider}
        workspaceId={workspaceId ?? null}
        onConnected={() => {
          setDialogOpen(false);
          void qc.invalidateQueries({ queryKey: ['observability'] });
        }}
      />
    </>
  );
}

function ObservabilityConnectDialog({
  open,
  onOpenChange,
  provider,
  workspaceId,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  provider: Provider;
  workspaceId: string | null;
  onConnected: () => void;
}) {
  const { t } = useT();
  const providerName = t(`observability.providers.${provider}`);
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [logsEndpoint, setLogsEndpoint] = useState('');
  const [logsUsername, setLogsUsername] = useState('');
  const [logsPassword, setLogsPassword] = useState('');
  const [logsSource, setLogsSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      await window.orkestral['observability:connect']({
        workspaceId,
        provider,
        token: token.trim(),
        config:
          provider === 'new_relic'
            ? { accountId: Number(accountId) }
            : {
                logsEndpoint: logsEndpoint.trim(),
                logsUsername: logsUsername.trim(),
                logsPassword: logsPassword.trim(),
                logsSource: logsSource.trim(),
              },
      });
      onConnected();
      setToken('');
      setAccountId('');
      setLogsEndpoint('');
      setLogsUsername('');
      setLogsPassword('');
      setLogsSource('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="p-6">
          <DialogTitle className="pr-8 text-[15px]">
            {t('observability.card.dialogConnect', { name: providerName })}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px] text-text-muted">
            {provider === 'new_relic'
              ? t('observability.card.newRelicHint')
              : t('observability.card.betterStackHint')}
          </DialogDescription>

          <div className="mt-4 flex flex-col gap-3">
            {provider === 'new_relic' && (
              <Field label={t('observability.card.accountId')}>
                <input
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  placeholder="1234567"
                  className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
                />
              </Field>
            )}
            <Field
              label={
                provider === 'new_relic'
                  ? t('observability.card.userApiKey')
                  : t('observability.card.uptimeApiToken')
              }
            >
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 font-mono text-[12.5px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
              />
            </Field>
            {provider === 'better_stack' && (
              <>
                <Field label={t('observability.card.logsEndpoint')}>
                  <input
                    value={logsEndpoint}
                    onChange={(e) => setLogsEndpoint(e.target.value)}
                    placeholder="https://...betterstackdata.com"
                    className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('observability.card.logsUsername')}>
                    <input
                      value={logsUsername}
                      onChange={(e) => setLogsUsername(e.target.value)}
                      className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
                    />
                  </Field>
                  <Field label={t('observability.card.logsPassword')}>
                    <input
                      type="password"
                      value={logsPassword}
                      onChange={(e) => setLogsPassword(e.target.value)}
                      className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
                    />
                  </Field>
                </div>
                <Field label={t('observability.card.logsSource')}>
                  <input
                    value={logsSource}
                    onChange={(e) => setLogsSource(e.target.value)}
                    placeholder="t123456_source"
                    className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
                  />
                </Field>
              </>
            )}
          </div>

          {error && (
            <div className="mt-3 rounded-md border border-accent-red/30 bg-accent-red/[0.07] px-3 py-2 text-[11.5px] text-accent-red">
              {error}
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="rounded-md border border-hairline-heavy px-3 py-1.5 text-[12.5px] text-text-secondary hover:bg-surface-1 disabled:opacity-50"
            >
              {t('observability.card.cancel')}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={
                busy ||
                !workspaceId ||
                !token.trim() ||
                (provider === 'new_relic' && !accountId.trim())
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plug className="h-3.5 w-3.5" />
              )}
              {t('observability.card.connect')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
        {label}
      </span>
      {children}
    </label>
  );
}
