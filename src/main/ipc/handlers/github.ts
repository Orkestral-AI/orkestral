import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { registerHandler } from '../register';
import { resolveWorkspaceDir } from '../../db/connection';
import {
  startDeviceFlow,
  pollDeviceFlow,
  getConnectedAccount,
  listConnectedAccounts,
  disconnectAccount,
  listUserRepos,
  cloneRepo,
  openInBrowser,
  openOAuthAccessSettings,
  listPullRequests,
} from '../../services/github';

export function registerGithubHandlers(): void {
  registerHandler('github:get-account', () => getConnectedAccount());

  registerHandler('github:list-accounts', () => listConnectedAccounts());

  registerHandler('github:start-device-flow', async () => {
    return await startDeviceFlow();
  });

  registerHandler('github:poll-device-flow', async (req) => {
    return await pollDeviceFlow(req.deviceCode);
  });

  registerHandler('github:open-verification', (req) => {
    openInBrowser(req.url);
    return { ok: true as const };
  });

  registerHandler('github:open-access-settings', () => {
    openOAuthAccessSettings();
    return { ok: true as const };
  });

  registerHandler('github:disconnect', (req) => {
    disconnectAccount(req?.accountLogin);
    return { ok: true as const };
  });

  registerHandler('github:list-repos', async (req) => {
    return await listUserRepos(req?.accountLogin);
  });

  registerHandler('github:list-prs', async ({ ownerRepo }) => {
    return await listPullRequests(ownerRepo);
  });

  registerHandler('github:clone-repo', async (req) => {
    const wsDir = resolveWorkspaceDir(req.workspaceId);
    const targetDir = join(wsDir, 'repo');
    // git clone exige diretório vazio/inexistente — remove tentativas anteriores
    // que ficaram pela metade (interrompido, falha de auth, etc.).
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    const result = await cloneRepo({
      ownerRepo: req.ownerRepo,
      targetDir,
      branch: req.branch,
      depth: 1,
    });
    return { path: result.path };
  });
}
