import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Github, Loader2, CheckCircle2, X } from 'lucide-react';
import { DeviceFlowDialog } from '@renderer/components/onboarding/GithubConnect';
import { useT } from '@renderer/i18n';
import { IntegrationCardShell } from './IntegrationCardShell';

/**
 * Card do GitHub no estilo do marketplace de MCPs — reusado na página
 * Integrações e no painel Settings → Integrações. Conecta/desconecta a conta
 * via Device Flow (mesmo fluxo do onboarding), sem o RepoPicker.
 */
export function GithubIntegrationCard() {
  const { t } = useT();
  const qc = useQueryClient();
  const accountQuery = useQuery({
    queryKey: ['github', 'account'],
    queryFn: () => window.orkestral['github:get-account'](),
    staleTime: 30_000,
  });
  const account = accountQuery.data ?? null;
  const [flowOpen, setFlowOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await window.orkestral['github:disconnect']();
      await qc.invalidateQueries({ queryKey: ['github'] });
    } finally {
      setDisconnecting(false);
    }
  }

  const action = accountQuery.isPending ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />
  ) : account ? (
    <button
      type="button"
      onClick={handleDisconnect}
      disabled={disconnecting}
      className="inline-flex items-center gap-1 rounded-md border border-hairline-heavy bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent-red/40 hover:bg-accent-red/15 hover:text-text-primary disabled:opacity-50"
    >
      {disconnecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
      {t('pages.integrations.disconnect')}
    </button>
  ) : (
    <button
      type="button"
      onClick={() => setFlowOpen(true)}
      className="inline-flex items-center gap-1 rounded-md border border-hairline-heavy bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent-purple/40 hover:bg-accent-purple/15 hover:text-text-primary"
    >
      <Github className="h-3 w-3" />
      {t('pages.integrations.connect')}
    </button>
  );

  return (
    <>
      <IntegrationCardShell
        icon={Github}
        name={t('pages.integrations.github.name')}
        description={t('pages.integrations.github.description')}
        category={t('pages.integrations.github.category')}
        badge={
          account ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent-green/25 bg-accent-green/10 py-0.5 pl-1 pr-2 text-[10px] font-medium text-accent-green">
              <CheckCircle2 className="h-3 w-3" />@{account.login}
            </span>
          ) : undefined
        }
        action={action}
      />
      <DeviceFlowDialog
        open={flowOpen}
        onOpenChange={setFlowOpen}
        onConnected={() => setFlowOpen(false)}
      />
    </>
  );
}
