import { registerHandler } from '../register';
import {
  disconnectAzureDevops,
  getAzureDevopsAccount,
  listAzureDevopsRepos,
  openAzureDevopsVerification,
  pollAzureDevopsDeviceFlow,
  startAzureDevopsDeviceFlow,
} from '../../services/azure-devops';

export function registerAzureDevopsHandlers(): void {
  registerHandler('azure-devops:get-account', () => getAzureDevopsAccount());

  registerHandler('azure-devops:start-device-flow', async () => {
    return await startAzureDevopsDeviceFlow();
  });

  registerHandler('azure-devops:poll-device-flow', async ({ deviceCode }) => {
    return await pollAzureDevopsDeviceFlow(deviceCode);
  });

  registerHandler('azure-devops:open-verification', ({ url }) => {
    openAzureDevopsVerification(url);
    return { ok: true as const };
  });

  registerHandler('azure-devops:disconnect', () => {
    disconnectAzureDevops();
    return { ok: true as const };
  });

  registerHandler('azure-devops:list-repos', async ({ organization }) => {
    return await listAzureDevopsRepos(organization);
  });
}
