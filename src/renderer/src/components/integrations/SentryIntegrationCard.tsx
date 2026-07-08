import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Loader2, CheckCircle2, X, Plug } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@renderer/components/ui/dialog';
import { SentryIcon } from '@renderer/components/brand-icons';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT } from '@renderer/i18n';
import { IntegrationCardShell } from './IntegrationCardShell';
import type { LucideIcon } from 'lucide-react';

/**
 * Card do Sentry — conecta via auth token (org + projeto opcional). Quando
 * conectado, mostra o status e um atalho "Ver erros" pra página do Sentry.
 */
export function SentryIntegrationCard() {
  const { t } = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceStore((s) => s.active?.id);
  const accountQuery = useQuery({
    queryKey: ['sentry', 'account', workspaceId],
    queryFn: () => window.orkestral['sentry:get-account']({ workspaceId: workspaceId! }),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
  const account = accountQuery.data ?? null;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (!workspaceId) return;
    setDisconnecting(true);
    try {
      await window.orkestral['sentry:disconnect']({ workspaceId });
      await qc.invalidateQueries({ queryKey: ['sentry'] });
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
      {t('pages.integrations.disconnect')}
    </button>
  ) : (
    <button
      type="button"
      onClick={() => setDialogOpen(true)}
      className="inline-flex items-center gap-1 rounded-md border border-hairline-heavy bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent-purple/40 hover:bg-accent-purple/15 hover:text-text-primary"
    >
      <Plug className="h-3 w-3" />
      {t('pages.integrations.connect')}
    </button>
  );

  // Conectado → o CARD inteiro vira atalho pra página de erros (sem botão "Ver
  // erros" separado). O botão de desconectar para a propagação do clique.
  const shell = (
    <IntegrationCardShell
      icon={SentryIcon as unknown as LucideIcon}
      name={t('pages.integrations.sentry.name')}
      description={t('pages.integrations.sentry.description')}
      category={t('pages.integrations.sentry.category')}
      badge={
        account ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent-green/25 bg-accent-green/10 py-0.5 pl-1 pr-2 text-[10px] font-medium text-accent-green">
            <CheckCircle2 className="h-3 w-3" />
            {account.orgSlug}
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
          onClick={() => navigate('/sentry')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate('/sentry');
          }}
          className="cursor-pointer rounded-xl outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          {shell}
        </div>
      ) : (
        shell
      )}
      <SentryConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={workspaceId ?? null}
        onConnected={() => {
          setDialogOpen(false);
          void qc.invalidateQueries({ queryKey: ['sentry'] });
        }}
      />
    </>
  );
}

function SentryConnectDialog({
  open,
  onOpenChange,
  workspaceId,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string | null;
  onConnected: () => void;
}) {
  const { t } = useT();
  const [org, setOrg] = useState('');
  const [project, setProject] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await window.orkestral['sentry:connect']({
        workspaceId: workspaceId!,
        orgSlug: org.trim(),
        projectSlug: project.trim() || null,
        authToken: token.trim(),
      });
      onConnected();
      setOrg('');
      setProject('');
      setToken('');
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
          {/* pr-8: o X do DialogContent fica absolute no canto — dá respiro pro título. */}
          <div className="flex items-center gap-2.5 pr-8">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-hairline-strong bg-surface-1 text-text-secondary">
              <SentryIcon className="h-4 w-4" />
            </div>
            <DialogTitle className="text-[15px]">
              {t('pages.integrations.sentry.connectTitle')}
            </DialogTitle>
          </div>
          <DialogDescription className="mt-2 text-[12px] leading-relaxed text-text-muted">
            {t('pages.integrations.sentry.connectHint')}
          </DialogDescription>

          <div className="mt-4 flex flex-col gap-3">
            <Field label={t('pages.integrations.sentry.orgLabel')}>
              <input
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                placeholder="minha-org"
                className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
              />
            </Field>
            <Field label={t('pages.integrations.sentry.projectLabel')}>
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder={t('pages.integrations.sentry.projectPlaceholder')}
                className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 text-[13px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
              />
            </Field>
            <Field label={t('pages.integrations.sentry.tokenLabel')}>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="sntrys_..."
                className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 font-mono text-[12.5px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
              />
            </Field>
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
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !workspaceId || !org.trim() || !token.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plug className="h-3.5 w-3.5" />
              )}
              {t('pages.integrations.connect')}
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
