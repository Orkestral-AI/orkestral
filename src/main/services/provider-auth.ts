import { toolSecretRepo, providerApiKeySecretKey } from '../db/repositories/tool-secret.repo';

/**
 * Env var que cada PROVEDOR (adapter CLI) usa pra a API key. Quando o usuário
 * configura a chave do provedor na página Provedores, ela é guardada cifrada no
 * secret store e injetada aqui no spawn. Sem chave configurada, o CLI usa a auth
 * dele (login/keychain/env do shell) — não tocamos.
 */
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  claude_local: 'ANTHROPIC_API_KEY',
  codex_local: 'OPENAI_API_KEY',
  gemini_local: 'GEMINI_API_KEY',
};

/** Provedores que aceitam API key (além do CLI). Usado pela UI e pela injeção. */
export function providerSupportsApiKey(adapterType: string): boolean {
  return adapterType in PROVIDER_API_KEY_ENV;
}

/**
 * Injeta a API key configurada do provedor (secret store) no env do spawn, se houver.
 * Mutável de propósito (mesmo contrato dos outros aplicadores de env do spawn). Roda
 * DEPOIS do scrubSpawnEnv — a key explícita do usuário vence o que veio do shell.
 */
export function applyProviderApiKey(
  env: NodeJS.ProcessEnv,
  adapterType: string | null | undefined,
): void {
  if (!adapterType) return;
  const envVar = PROVIDER_API_KEY_ENV[adapterType];
  if (!envVar) return;
  const key = toolSecretRepo.get(providerApiKeySecretKey(adapterType));
  if (key) env[envVar] = key;
}
