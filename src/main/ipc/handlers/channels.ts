import { registerHandler } from '../register';
import { channelManager } from '../../services/channels/channel-manager';
import { channelRepo } from '../../db/repositories/channel.repo';
import { shell } from '../../platform/electron';
import { TeamsCliError } from '../../services/channels/teams-cli';

export function registerChannelHandlers(): void {
  registerHandler('channels:list', (req) => channelManager.listSnapshots(req?.channelType));

  registerHandler('channels:session-meta', ({ workspaceId }) =>
    channelRepo.listSessionMetaByWorkspace(workspaceId),
  );

  registerHandler('channels:create', ({ channelType, workspaceId, agentId }) =>
    channelManager.createAccount({ channelType, workspaceId, agentId }),
  );

  registerHandler('channels:set-config', ({ accountId, agentId, allowlist, token, teams }) =>
    channelManager.setConfig(accountId, { agentId, allowlist, token, teams }),
  );

  registerHandler('channels:set-telegram-token', ({ accountId, token }) =>
    channelManager.setTelegramToken(accountId, token),
  );

  registerHandler('channels:connect', ({ accountId }) => channelManager.connect(accountId));

  registerHandler('channels:disconnect', ({ accountId }) => channelManager.disconnect(accountId));

  registerHandler('channels:logout', ({ accountId }) => channelManager.logout(accountId));

  registerHandler('channels:delete', async ({ accountId }) => {
    await channelManager.deleteAccount(accountId);
    return { ok: true as const };
  });

  registerHandler('channels:teams-create-app', async ({ accountId, name }) => {
    try {
      const creds = await channelManager.createTeamsApp(accountId, { name });
      return { ok: true as const, ...creds };
    } catch (err) {
      if (err instanceof TeamsCliError)
        return { ok: false as const, code: err.code, message: err.message };
      return { ok: false as const, code: 'failed' as const, message: String(err) };
    }
  });

  // Abre a página de login no navegador externo (acionado pelo botão da UI).
  registerHandler('channels:teams-open-page', async ({ url }) => {
    if (!shell) throw new Error('Abrir o navegador está disponível apenas no app desktop.');
    await shell.openExternal(url);
    return { ok: true as const };
  });
}
