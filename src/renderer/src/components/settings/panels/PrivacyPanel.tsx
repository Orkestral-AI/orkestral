import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Trash2, Eraser, Shield } from 'lucide-react';
import { Switch } from '@renderer/components/ui/switch';
import { Button } from '@renderer/components/ui/button';
import { PanelShell, SettingsSection, Field, ToggleRow } from './PanelShell';
import { WorkspacePicker } from '@renderer/components/workspace/WorkspacePicker';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useToastStore } from '@renderer/stores/toastStore';
import { useT } from '@renderer/i18n';
import type { Workspace } from '@shared/types';

/**
 * Privacidade — honesto sobre o que existe HOJE.
 *
 * As três flags persistem de verdade (settings.privacy), mas o app ainda NÃO
 * tem coleta de telemetria nem um motor que aplique mascaramento/bloqueio —
 * então elas são PREFERÊNCIAS registradas que o futuro respeitará. As notas
 * deixam isso claro: nada é enviado pra lugar nenhum.
 *
 * As AÇÕES (limpar cache, limpar histórico de chat) são reais e têm efeito
 * imediato.
 */
export function PrivacyPanel() {
  const { t } = useT();
  const privacy = useSettingsStore((s) => s.settings?.privacy);
  const update = useSettingsStore((s) => s.updatePrivacy);
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const pushToast = useToastStore((s) => s.push);
  const queryClient = useQueryClient();

  const [clearingCache, setClearingCache] = useState(false);
  const [confirmClearChat, setConfirmClearChat] = useState(false);
  const [clearingChat, setClearingChat] = useState(false);

  // Workspace alvo do "limpar histórico": inicia no ativo, mas o usuário pode
  // trocar pelo WorkspacePicker sem sair das configs (não mexe no ativo global).
  // Só a ação de limpar chat é escopada — telemetria/máscara/cache são globais.
  const [viewWs, setViewWs] = useState<Workspace | null>(activeWorkspace);
  useEffect(() => {
    if (!viewWs && activeWorkspace) setViewWs(activeWorkspace);
  }, [activeWorkspace, viewWs]);

  const telemetry = privacy?.localTelemetry ?? false;
  const maskSecrets = privacy?.maskSecrets ?? true;
  const blockSensitive = privacy?.blockSensitiveFiles ?? true;

  async function clearCache() {
    setClearingCache(true);
    try {
      await window.orkestral['data:clear-cache']();
      pushToast({ title: t('settings.privacy.cacheClearedTitle'), tone: 'success' });
    } catch (err) {
      pushToast({
        title: t('settings.privacy.clearCacheFailTitle'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setClearingCache(false);
    }
  }

  async function clearChatHistory() {
    if (!viewWs) return;
    setClearingChat(true);
    try {
      const res = await window.orkestral['data:clear-chat-history']({
        workspaceId: viewWs.id,
      });
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['sessions', viewWs.id] });
      pushToast({
        title: t('settings.privacy.chatClearedTitle'),
        description: t('settings.privacy.chatClearedDescription', {
          sessions: res.deletedSessions,
          messages: res.deletedMessages,
        }),
        tone: 'success',
      });
    } catch (err) {
      pushToast({
        title: t('settings.privacy.clearChatFailTitle'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setClearingChat(false);
      setConfirmClearChat(false);
    }
  }

  return (
    <PanelShell
      icon={Shield}
      title={t('settings.privacy.title')}
      description={t('settings.privacy.description')}
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SettingsSection title={t('settings.privacy.groupPreferences')}>
          <ToggleRow
            label={t('settings.privacy.telemetryLabel')}
            description={t('settings.privacy.telemetryDescription')}
            right={
              <Switch
                checked={telemetry}
                onCheckedChange={(v) => void update({ localTelemetry: v })}
              />
            }
          />
          <ToggleRow
            label={t('settings.privacy.maskSecretsLabel')}
            description={t('settings.privacy.maskSecretsDescription')}
            right={
              <Switch
                checked={maskSecrets}
                onCheckedChange={(v) => void update({ maskSecrets: v })}
              />
            }
          />
          <ToggleRow
            label={t('settings.privacy.blockSensitiveLabel')}
            description={t('settings.privacy.blockSensitiveDescription')}
            right={
              <Switch
                checked={blockSensitive}
                onCheckedChange={(v) => void update({ blockSensitiveFiles: v })}
              />
            }
          />
        </SettingsSection>

        <SettingsSection title={t('settings.privacy.groupData')}>
          <Field
            label={t('settings.privacy.clearBrowsingLabel')}
            description={t('settings.privacy.clearBrowsingDescription')}
          >
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              onClick={clearCache}
              disabled={clearingCache}
            >
              <Eraser className="h-3.5 w-3.5" />
              {clearingCache ? t('settings.privacy.clearing') : t('settings.privacy.clearCache')}
            </Button>
          </Field>

          {/* Seletor de workspace: escopa a limpeza de chat sem trocar o ativo global */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-text-muted">
              {t('settings.privacy.scopeLabel')}
            </span>
            <WorkspacePicker
              value={viewWs?.id}
              onChange={(ws) => {
                setViewWs(ws);
                setConfirmClearChat(false);
              }}
              align="end"
            />
          </div>

          <Field
            label={t('settings.privacy.clearChatLabel')}
            description={
              viewWs
                ? t('settings.privacy.clearChatDescription', { name: viewWs.name })
                : t('settings.privacy.clearChatNoWorkspace')
            }
          >
            {!confirmClearChat ? (
              <Button
                variant="destructive"
                size="sm"
                className="w-fit"
                onClick={() => setConfirmClearChat(true)}
                disabled={!viewWs}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('settings.privacy.clearChatButton')}
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-accent-red" />
                <span className="text-[12px] text-text-secondary">
                  {t('settings.privacy.clearChatConfirmPrompt')}
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={clearChatHistory}
                  disabled={clearingChat}
                >
                  {clearingChat ? t('settings.privacy.clearingChat') : t('common.confirm')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmClearChat(false)}
                  disabled={clearingChat}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            )}
          </Field>
        </SettingsSection>
      </div>
    </PanelShell>
  );
}
