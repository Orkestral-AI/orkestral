import { registerHandler } from '../register';
import { getAdapter, listAdapterDescriptors } from '../../adapters/registry';
import { toolSecretRepo, providerApiKeySecretKey } from '../../db/repositories/tool-secret.repo';
import { providerSupportsApiKey } from '../../services/provider-auth';

export function registerAdapterHandlers(): void {
  registerHandler('adapter:list', () => listAdapterDescriptors());

  registerHandler('adapter:list-models', async ({ type }) => {
    const adapter = getAdapter(type);
    return adapter.listModels();
  });

  registerHandler('adapter:test', async ({ type }) => {
    const adapter = getAdapter(type);
    return adapter.testEnvironment();
  });

  // ── Provedores: API key cifrada por adapter (página Provedores) ──────────────
  // O valor em claro NUNCA volta pro renderer — só "configured: sim/não" e se o
  // provedor aceita key. A chave é injetada no env do spawn (provider-auth.ts).
  registerHandler('provider:key-status', () => {
    return listAdapterDescriptors().map((d) => ({
      type: d.type,
      supportsApiKey: providerSupportsApiKey(d.type),
      apiKeyConfigured: toolSecretRepo.has(providerApiKeySecretKey(d.type)),
    }));
  });

  registerHandler('provider:set-key', ({ type, apiKey }) => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      toolSecretRepo.clear(providerApiKeySecretKey(type));
      return { configured: false };
    }
    toolSecretRepo.set(providerApiKeySecretKey(type), trimmed);
    return { configured: true };
  });

  registerHandler('provider:clear-key', ({ type }) => {
    toolSecretRepo.clear(providerApiKeySecretKey(type));
    return { configured: false };
  });
}
