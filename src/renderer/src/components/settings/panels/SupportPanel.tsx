import { useQuery } from '@tanstack/react-query';
import { Github, Bug, Tag, ScrollText, FolderOpen, ExternalLink, LifeBuoy } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PanelShell } from './PanelShell';
import { useT } from '@renderer/i18n';

const REPO_URL = 'https://github.com/Orkestral-AI/orkestral';

/**
 * Suporte — apenas ações/links REAIS.
 *
 * Versão vem de app:get-version (não hardcoded). Links abrem no navegador via
 * o setWindowOpenHandler do main (shell.openExternal). Usamos só URLs que
 * existem de fato: o repo no GitHub, /issues e /releases. "Abrir logs" navega
 * pra rota /logs do app fechando o modal antes.
 */
export function SupportPanel({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const versionQuery = useQuery({
    queryKey: ['app-version'],
    queryFn: () => window.orkestral['app:get-version'](),
  });
  const version = versionQuery.data;

  function openLogs() {
    onClose();
    // HashRouter — navega sem depender do hook de router neste componente.
    window.location.hash = '#/logs';
  }

  async function openDataFolder() {
    try {
      await window.orkestral['data:reveal']();
    } catch {
      // best-effort
    }
  }

  return (
    <PanelShell
      icon={LifeBuoy}
      title={t('settings.support.title')}
      description={t('settings.support.description')}
    >
      {/* Bloco de versão — real */}
      <div className="rounded-lg border border-border bg-surface/40 p-4">
        <div className="text-[13px] font-medium text-text-primary">Orkestral</div>
        <div className="mt-1 text-[12px] text-text-muted">
          {version
            ? t('settings.support.versionLabel', { version: version.version })
            : t('settings.support.loadingVersion')}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
        <ActionRow
          icon={Github}
          label={t('settings.support.repoLabel')}
          hint={t('settings.support.repoHint')}
          onClick={() => window.open(REPO_URL)}
          external
        />
        <ActionRow
          icon={Bug}
          label={t('settings.support.reportLabel')}
          hint={t('settings.support.reportHint')}
          onClick={() => window.open(`${REPO_URL}/issues/new`)}
          external
        />
        <ActionRow
          icon={Tag}
          label={t('settings.support.releaseNotesLabel')}
          hint={t('settings.support.releaseNotesHint')}
          onClick={() => window.open(`${REPO_URL}/releases`)}
          external
        />
        <ActionRow
          icon={ScrollText}
          label={t('settings.support.logsLabel')}
          hint={t('settings.support.logsHint')}
          onClick={openLogs}
        />
        <ActionRow
          icon={FolderOpen}
          label={t('settings.support.dataFolderLabel')}
          hint={t('settings.support.dataFolderHint')}
          onClick={openDataFolder}
        />
      </div>
    </PanelShell>
  );
}

function ActionRow({
  icon: Icon,
  label,
  hint,
  onClick,
  external,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  onClick: () => void;
  external?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-border px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-hover"
    >
      <Icon className="h-4 w-4 shrink-0 text-text-muted" />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-text-primary">{label}</div>
        <div className="text-[11px] text-text-faint">{hint}</div>
      </div>
      {external && <ExternalLink className="h-3.5 w-3.5 shrink-0 text-text-faint" />}
    </button>
  );
}
