import type { Agent } from '../../shared/types';
import { getPermissionMode } from '../cli/permission';

/**
 * Política de permissões resolvida pra um spawn de adapter CLI.
 *
 * Decidida a partir das capacidades do agente (`canEditFiles`/`canRunCommands`)
 * + `bypassSandbox`. É a ÚNICA fonte de verdade pra decidir as flags de
 * permissão dos 3 spawns (chat, execução de issue, heartbeat) — antes disso as
 * flags eram hardcoded e `canEditFiles`/`canRunCommands` eram decorativos.
 */
export interface SpawnPolicy {
  /**
   * Pula TODA confirmação de permissão (Claude `--dangerously-skip-permissions`
   * / Codex `--yolo`). É o comportamento atual quando `bypassSandbox` é true
   * (o default do CEO/onboarding e de qualquer agente que não pediu restrição).
   */
  skipPermissions: boolean;
  /**
   * Whitelist de tools (apenas Claude). `undefined` = sem whitelist (todas as
   * tools liberadas). Só é preenchida quando o agente pediu restrição explícita
   * — restringe Bash/Write/Edit conforme as capacidades.
   */
  allowedTools?: string[];
  /**
   * Modo de sandbox do Codex (`--sandbox <mode>`). `undefined` = não passar
   * `--sandbox` (mantém o default do CLI). Preenchido só quando restrito.
   */
  codexSandboxMode?: 'read-only' | 'workspace-write';
  /** true quando o agente está sob restrição (não é bypass total). */
  sandbox: boolean;
}

/**
 * Capacidades mínimas que a policy consome. Aceita `Agent` completo ou um
 * subset (heartbeat/execução já carregam o `Agent`, mas tipar pelo subset deixa
 * a função pura testável sem montar um Agent inteiro).
 */
type PolicyInput = Pick<Agent, 'canEditFiles' | 'canRunCommands'> & {
  runtimeConfig?: Record<string, unknown> | null;
};

/**
 * Tools do Claude consideradas "leitura/análise" — sempre liberadas mesmo no
 * modo restrito, pra que análise de source não trave. Não inclui Bash, Write
 * nem Edit (essas dependem das capacidades).
 */
const CLAUDE_READONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'NotebookRead',
  'Task',
] as const;

const CLAUDE_EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
const CLAUDE_COMMAND_TOOLS = ['Bash'] as const;

/**
 * Resolve a política de permissões de spawn pra um agente, por adapter.
 *
 * REGRA DE OURO: `bypassSandbox === true` (o default) ⇒ comportamento ATUAL,
 * INALTERADO (`skipPermissions: true`, sem whitelist, sem sandbox). A policy só
 * RESTRINGE quando o agente pediu restrição explícita
 * (`bypassSandbox === false`). Errar pro lado restritivo quebra o fluxo feliz.
 */
export function resolveSpawnPolicy(agent: PolicyInput): SpawnPolicy {
  const runtimeConfig = (agent.runtimeConfig ?? {}) as { bypassSandbox?: boolean };
  // Default true = comportamento atual. Só false explícito ativa a restrição.
  const bypassSandbox = runtimeConfig.bypassSandbox ?? true;

  if (bypassSandbox) {
    return { skipPermissions: true, sandbox: false };
  }

  // --- Modo restrito: agente pediu restrição explícita (bypassSandbox=false) ---
  // MCP tools (mcp__*) ficam sempre liberadas — são a integração do Orkestral.
  const allowedTools = [...CLAUDE_READONLY_TOOLS, 'mcp__*'];
  if (agent.canEditFiles) allowedTools.push(...CLAUDE_EDIT_TOOLS);
  if (agent.canRunCommands) allowedTools.push(...CLAUDE_COMMAND_TOOLS);

  return {
    skipPermissions: false,
    allowedTools,
    // Sem permissão de comando ⇒ read-only. Com comando ⇒ workspace-write.
    codexSandboxMode: agent.canRunCommands ? 'workspace-write' : 'read-only',
    sandbox: true,
  };
}

/**
 * Aplica a policy aos args do Claude CLI. Mantém o comportamento atual quando
 * `skipPermissions` (bypass) e injeta `--allowedTools` no modo restrito.
 *
 * O modo de permissão da CLI (`getPermissionMode`) é uma camada ADITIVA: só a
 * CLI o muda. Pra GUI o modo é sempre `default` (NO-OP), então o resultado fica
 * byte-idêntico ao de antes. `dangerously-skip` força a flag de skip mesmo
 * quando a policy restringiria (é a escolha explícita do operador da CLI).
 * `acceptEdits`/`plan` mapeiam pro `--permission-mode` do claude CLI e VENCEM o
 * skip da policy — o operador pediu explicitamente um modo mais contido que o
 * full-auto (pedir "plan" e pular toda permissão seria contraditório); a
 * whitelist `--allowedTools` do modo restrito continua valendo junto.
 */
export function applyClaudePolicy(args: string[], policy: SpawnPolicy): void {
  const mode = getPermissionMode();
  if (mode === 'acceptEdits' || mode === 'plan') {
    // Guard contra flag duplicada (o chamador pode tê-la passado / outra
    // chamada já pode tê-la adicionado) — mesmo padrão da flag de skip.
    if (!args.includes('--permission-mode')) {
      args.push('--permission-mode', mode);
    }
  } else if (policy.skipPermissions || mode === 'dangerously-skip') {
    // Guard contra flag duplicada (policy já pode tê-la adicionado em outra
    // chamada / o chamador pode tê-la passado).
    if (!args.includes('--dangerously-skip-permissions')) {
      args.push('--dangerously-skip-permissions');
    }
    return;
  }
  if (policy.allowedTools && policy.allowedTools.length > 0) {
    args.push('--allowedTools', policy.allowedTools.join(','));
  }
}

// ─── Esforço de raciocínio (claude --effort) ────────────────────────────────

/** Níveis que o CLI `claude --effort` aceita. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const CLI_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Normaliza o effort configurado (adapterConfig.effort) pro nível do CLI. 'auto' ou
 *  vazio → null (deixa o CLI decidir); 'minimal' → 'low' (o CLI não tem 'minimal'). */
export function normalizeReasoningEffort(raw: unknown): ReasoningEffort | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'minimal') return 'low';
  return CLI_EFFORTS.includes(v) ? (v as ReasoningEffort) : null;
}

type EffortCarrier =
  | {
      adapterConfig?: Record<string, unknown> | null;
      runtimeConfig?: { thinkingEffort?: unknown; fastMode?: unknown } | null;
    }
  | null
  | undefined;

/** Esforço EFETIVO de raciocínio pro spawn: o do próprio agente e, na ausência, o do
 *  ORQUESTRADOR (baseline do time, configurado no onboarding) — assim TODOS os agentes
 *  respeitam o effort do CEO. null = não passa --effort (default do CLI).
 *
 *  Fonte por agente: runtimeConfig.thinkingEffort (o que a UI edita) tem precedência
 *  sobre adapterConfig.effort (legado/retrocompat). 'auto'/vazio normaliza pra null e
 *  cai pra próxima fonte — assim o valor escolhido no onboarding (e depois na config do
 *  agente) chega ao --effort de verdade, sem a divergência "UI diz high mas roda auto". */
export function resolveReasoningEffort(
  agent: EffortCarrier,
  orchestrator?: EffortCarrier,
): ReasoningEffort | null {
  // Esforço explícito do agente vence sempre.
  const explicit = normalizeReasoningEffort(agent?.runtimeConfig?.thinkingEffort);
  if (explicit) return explicit;
  // Modo rápido (executores): sem esforço explícito, força 'low' pra rodar mais
  // rápido (menos raciocínio). É o que faz o toggle "Modo rápido" funcionar de fato.
  if (agent?.runtimeConfig?.fastMode === true) return 'low';
  return (
    normalizeReasoningEffort(agent?.adapterConfig?.effort) ??
    normalizeReasoningEffort(orchestrator?.runtimeConfig?.thinkingEffort) ??
    normalizeReasoningEffort(orchestrator?.adapterConfig?.effort)
  );
}

/** Adiciona `--effort <level>` aos args do claude quando há effort efetivo. */
export function applyClaudeEffort(args: string[], effort: ReasoningEffort | null): void {
  if (effort) args.push('--effort', effort);
}

/**
 * Aplica a policy aos args do Codex CLI. Mantém `--yolo` quando bypass; no modo
 * restrito troca por `--sandbox <mode>`.
 *
 * Mesmo contrato aditivo do `applyClaudePolicy`: `getPermissionMode()` só é
 * mexido pela CLI. `default` (estado da GUI) = NO-OP → byte-idêntico.
 * `dangerously-skip` força `--yolo` (full-auto do Codex). `acceptEdits`/`plan`
 * = no-op DE PROPÓSITO: o Codex CLI não tem equivalente ao `--permission-mode`
 * do claude (só `--sandbox`/`--yolo`, que são outra semântica) — o modo fica
 * guardado sem inventar flag, e a UI do REPL rotula esses modos como
 * "(claude only)" pra expectativa ficar honesta.
 */
export function applyCodexPolicy(args: string[], policy: SpawnPolicy): void {
  if (policy.skipPermissions || getPermissionMode() === 'dangerously-skip') {
    if (!args.includes('--yolo')) args.push('--yolo');
    return;
  }
  if (policy.codexSandboxMode) {
    args.push('--sandbox', policy.codexSandboxMode);
  }
}

/**
 * Regex de nomes de var OBVIAMENTE sensíveis que o CLI do agente NÃO precisa
 * (tokens/keys/secrets que o usuário exportou no shell e seriam herdados pelo
 * filho sem necessidade). Casado por segmento separado por `_` (ou início/fim).
 */
const SENSITIVE_ENV_RE =
  /(^|_)(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)($|_)/i;

/**
 * Allow-list de vars que os CLIs/git LEGITIMAMENTE consomem — nunca removidas,
 * mesmo casando o regex acima. Tirar qualquer uma destas QUEBRA o fluxo feliz
 * (auth do modelo, PATH/HOME, ssh/credential-helper do git).
 */
const SCRUB_KEEP = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CODEX_HOME',
  'PATH',
  'HOME',
  'SSH_AUTH_SOCK',
]);

/** Prefixos KEEP por família (CLAUDE_*, CODEX_*, GIT_* — auth/config dos CLIs e do git). */
const SCRUB_KEEP_PREFIXES = ['CLAUDE_', 'CODEX_', 'GIT_'];

/**
 * Deny-list explícita de secrets internos do app que o regex pode não pegar
 * pelo nome, e que o agente nunca precisa (tokens de push do GitHub). Removidos
 * mesmo que estivessem fora do padrão.
 */
const SCRUB_DENY = new Set(['GITHUB_TOKEN', 'GH_TOKEN']);

/**
 * Devolve uma CÓPIA fresca de `base` com as vars obviamente sensíveis removidas,
 * preservando a allow-list de auth/PATH/git. NÃO altera o default de permissões
 * (`--yolo`/`--dangerously-skip-permissions`) — isso é decisão de produto à
 * parte. Os envVars que o agente declarou explicitamente (runtimeConfig) devem
 * ser reaplicados DEPOIS deste scrub pelo chamador, pra que um agente que
 * legitimamente precisa de uma key ainda a receba.
 *
 * `keepKeys` = chaves que o agente DECLAROU em `runtimeConfig.envVars` — são
 * preservadas mesmo casando o regex/deny (ex.: um agente que roda `gh`/`git push`
 * e declarou `GITHUB_TOKEN`/`GH_TOKEN` herda o valor do shell em vez de ter a var
 * apagada). Sem isso, um token DENY era removido aqui e só voltava se o chamador
 * o tivesse com VALOR no declared; herdar do shell ficava impossível.
 */
export function scrubSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
  keepKeys?: Iterable<string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const declared = keepKeys ? new Set(keepKeys) : null;
  for (const key of Object.keys(env)) {
    if (SCRUB_KEEP.has(key) || SCRUB_KEEP_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (declared?.has(key)) continue;
    if (SCRUB_DENY.has(key) || SENSITIVE_ENV_RE.test(key)) delete env[key];
  }
  return env;
}

/**
 * Extrai as chaves de env que um agente declarou no `runtimeConfig.envVars` —
 * passadas a `scrubSpawnEnv` como allow-list pra que o scrub não apague vars que
 * o agente legitimamente pediu (ex.: `GITHUB_TOKEN` pra `gh`/`git`).
 */
export function declaredEnvKeys(
  runtimeConfig?: { envVars?: Array<{ key: string }> } | null,
): string[] {
  return (runtimeConfig?.envVars ?? []).map((v) => v.key.trim()).filter((k) => k.length > 0);
}
