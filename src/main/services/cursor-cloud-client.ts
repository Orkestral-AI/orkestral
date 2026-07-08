/**
 * Cliente Cursor Cloud (background agents).
 *
 * HONESTIDADE: a implementação do paperclip
 * (packages/adapters/cursor-cloud/src/server/execute.ts) usa o pacote
 * proprietário `@cursor/sdk` (`Agent.create/resume/send`, `run.wait/stream`,
 * `Cursor.me`, `Cursor.models.list`). Esse SDK encapsula um protocolo
 * proprietário do Cursor Cloud que NÃO possui uma API HTTP pública e estável
 * que possamos replicar de forma confiável sem o próprio SDK.
 *
 * `@cursor/sdk` NÃO é dependência deste app (e não foi adicionado
 * especulativamente). Portanto:
 *   - a config (repoUrl + CURSOR_API_KEY) é validada de verdade aqui;
 *   - a EXECUÇÃO lança um erro preciso e acionável em vez de fingir sucesso.
 *
 * Quando/se `@cursor/sdk` for adicionado às dependências, basta implementar
 * `runCursorCloud` chamando o SDK (espelhando o paperclip).
 */

export interface CursorCloudConfigCheck {
  ok: boolean;
  errorMessage?: string;
  repoUrl: string | null;
  apiKey: string | null;
  model: string | null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function looksLikeRepoUrl(value: string): boolean {
  return /^(https?:\/\/|git@)/i.test(value.trim());
}

/** Resolve CURSOR_API_KEY de adapterConfig.apiKey ou adapterConfig.env. */
function resolveApiKey(config: Record<string, unknown>): string | null {
  const direct = nonEmpty(config.apiKey);
  if (direct) return direct;
  const env = config.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const rec = env as Record<string, unknown>;
    const k = rec.CURSOR_API_KEY;
    if (typeof k === 'string') return nonEmpty(k);
    if (k && typeof k === 'object' && !Array.isArray(k)) {
      const inner = k as Record<string, unknown>;
      if (inner.type === 'plain' && typeof inner.value === 'string') return nonEmpty(inner.value);
    }
  }
  return null;
}

/** Valida a config do Cursor Cloud (repoUrl + API key) sem executar nada. */
export function checkCursorCloudConfig(
  config: Record<string, unknown>,
  workspaceRepoUrl?: string | null,
): CursorCloudConfigCheck {
  const repoUrl = nonEmpty(config.repoUrl) ?? nonEmpty(workspaceRepoUrl);
  const apiKey = resolveApiKey(config);
  const model = nonEmpty(config.model);

  if (!repoUrl) {
    return {
      ok: false,
      errorMessage: 'Cursor Cloud: configure repoUrl no adapterConfig (ou no workspace).',
      repoUrl: null,
      apiKey,
      model,
    };
  }
  if (!looksLikeRepoUrl(repoUrl)) {
    return {
      ok: false,
      errorMessage: 'Cursor Cloud: repoUrl deve ser uma URL http(s) ou git SSH.',
      repoUrl,
      apiKey,
      model,
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      errorMessage: 'Cursor Cloud: CURSOR_API_KEY é obrigatório (configure em env do adapter).',
      repoUrl,
      apiKey: null,
      model,
    };
  }
  return { ok: true, repoUrl, apiKey, model };
}

export interface CursorCloudRunOptions {
  config: Record<string, unknown>;
  workspaceRepoUrl?: string | null;
  prompt: string;
  runId: string;
  agentName?: string | null;
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface CursorCloudRunResult {
  ok: boolean;
  summary: string | null;
  errorMessage?: string;
  errorCode?: string;
}

/**
 * Executa um agente no Cursor Cloud. Hoje lança um erro honesto porque o
 * `@cursor/sdk` (proprietário) não está instalado — não há caminho HTTP
 * público para replicar a execução sem ele.
 */
export async function runCursorCloud(opts: CursorCloudRunOptions): Promise<CursorCloudRunResult> {
  const check = checkCursorCloudConfig(opts.config, opts.workspaceRepoUrl);
  if (!check.ok) {
    return {
      ok: false,
      summary: null,
      errorMessage: check.errorMessage,
      errorCode: 'cursor_cloud_config_invalid',
    };
  }

  const detail =
    'Cursor Cloud requer o SDK proprietário @cursor/sdk para executar agentes ' +
    '(Agent.create/send + streaming). Esse SDK não está instalado neste app e a ' +
    'API do Cursor Cloud não é pública/estável o suficiente para replicar via HTTP. ' +
    'Config validada com sucesso (repoUrl + CURSOR_API_KEY), mas a execução de ' +
    'background agents está pendente da integração do @cursor/sdk.';
  opts.onLog?.('stderr', `[cursor-cloud] ${detail}\n`);
  return {
    ok: false,
    summary: null,
    errorMessage: detail,
    errorCode: 'cursor_cloud_sdk_required',
  };
}
