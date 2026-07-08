import type { AdapterModel, AdapterDescriptor, AdapterConfigField } from '@shared/types';
import type { AdapterModule } from '../types';
import { aggregateResult, run, which } from '../probe';

/**
 * Builder para adapters CLI locais reais: probe verifica binário no PATH e
 * roda `<bin> --version`. Espelha o shape da probe do claude-local.
 */
function makeCliAdapter(opts: {
  descriptor: AdapterDescriptor;
  cliBinary: string;
  models: AdapterModel[];
}): AdapterModule {
  return {
    descriptor: opts.descriptor,
    async listModels() {
      return opts.models;
    },
    async testEnvironment() {
      const startedAt = Date.now();
      const checks: Awaited<ReturnType<AdapterModule['testEnvironment']>>['checks'] = [];

      const bin = await which(opts.cliBinary);
      if (!bin) {
        checks.push({
          label: `CLI \`${opts.cliBinary}\` no PATH`,
          status: 'fail',
          detail: `Não encontrei o binário \`${opts.cliBinary}\`. Instale antes de usar este adapter.`,
        });
        return aggregateResult(checks, startedAt);
      }
      checks.push({ label: `CLI \`${opts.cliBinary}\` no PATH`, status: 'pass', detail: bin });

      const versionRun = await run(opts.cliBinary, ['--version'], { timeoutMs: 5_000 });
      if (!versionRun.ok) {
        checks.push({
          label: 'Versão do CLI',
          status: 'warn',
          detail: versionRun.stderr.trim() || 'CLI não respondeu a --version.',
        });
      } else {
        checks.push({ label: 'Versão do CLI', status: 'pass', detail: versionRun.stdout.trim() });
      }
      return aggregateResult(checks, startedAt, `${opts.descriptor.name} pronto pra trabalhar.`);
    },
  };
}

const commandField = (placeholder: string, name: string): AdapterConfigField => ({
  key: 'command',
  label: 'Comando (override)',
  type: 'text',
  placeholder,
  hint: `Path ou comando para invocar o ${name} CLI. Default: ${placeholder}.`,
});

// ---------------------------------------------------------------------------
// Cursor (CLI local)
// ---------------------------------------------------------------------------
export const cursorLocal = makeCliAdapter({
  descriptor: {
    type: 'cursor_local',
    name: 'Cursor',
    description: 'Local Cursor agent',
    icon: 'MousePointer2',
    configSchema: {
      fields: [
        {
          key: 'mode',
          label: 'Modo',
          type: 'select',
          options: [
            { value: '', label: 'Autônomo (padrão)' },
            { value: 'plan', label: 'Plan' },
            { value: 'ask', label: 'Ask' },
          ],
          default: '',
          hint: 'Passado via --mode.',
        },
        commandField('cursor-agent', 'Cursor'),
      ],
    },
  },
  cliBinary: 'cursor-agent',
  models: [
    { id: 'default', label: 'Default (auto)' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
    { id: 'sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { id: 'opus-4.1', label: 'Claude Opus 4.1' },
  ],
});

// ---------------------------------------------------------------------------
// Grok (CLI local)
// ---------------------------------------------------------------------------
export const grokLocal = makeCliAdapter({
  descriptor: {
    type: 'grok_local',
    name: 'Grok Build',
    description: 'Local Grok Build agent',
    icon: 'Bot',
    configSchema: { fields: [commandField('grok', 'Grok')] },
  },
  cliBinary: 'grok',
  models: [
    { id: 'default', label: 'Default (configurado no CLI)' },
    { id: 'grok-4', label: 'Grok 4' },
    { id: 'grok-4-fast', label: 'Grok 4 Fast' },
    { id: 'grok-3', label: 'Grok 3' },
    { id: 'grok-3-mini', label: 'Grok 3 Mini' },
  ],
});

// ---------------------------------------------------------------------------
// Hermes (CLI local)
// ---------------------------------------------------------------------------
export const hermesLocal = makeCliAdapter({
  descriptor: {
    type: 'hermes_local',
    name: 'Hermes Agent',
    description: 'Local Hermes CLI agent',
    icon: 'Flame',
    configSchema: { fields: [commandField('hermes', 'Hermes')] },
  },
  cliBinary: 'hermes',
  models: [{ id: 'default', label: 'Default (configurado no CLI)' }],
});

// ---------------------------------------------------------------------------
// OpenCode (CLI local, formato provider/model)
// ---------------------------------------------------------------------------
export const opencodeLocal = makeCliAdapter({
  descriptor: {
    type: 'opencode_local',
    name: 'OpenCode',
    description: 'Local multi-provider agent',
    icon: 'Terminal',
    configSchema: {
      fields: [
        {
          key: 'variant',
          label: 'Variante',
          type: 'select',
          options: [
            { value: 'minimal', label: 'Minimal' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'xHigh' },
            { value: 'max', label: 'Max' },
          ],
          default: 'medium',
          hint: 'Variante de raciocínio passada via --variant.',
        },
        commandField('opencode', 'OpenCode'),
        {
          key: 'cwd',
          label: 'Diretório de trabalho',
          type: 'text',
          hint: 'Override opcional do cwd da execução.',
        },
      ],
    },
  },
  cliBinary: 'opencode',
  models: [
    { id: 'default', label: 'Default (configurado no CLI)' },
    { id: 'openai/gpt-5.4', label: 'openai/gpt-5.4' },
    { id: 'openai/gpt-5.1-codex-mini', label: 'openai/gpt-5.1-codex-mini' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'anthropic/claude-sonnet-4-6' },
    { id: 'xai/grok-4', label: 'xai/grok-4' },
    { id: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro' },
  ],
});

// ---------------------------------------------------------------------------
// Pi (CLI local, formato provider/model)
// ---------------------------------------------------------------------------
export const piLocal = makeCliAdapter({
  descriptor: {
    type: 'pi_local',
    name: 'Pi',
    description: 'Local Pi agent',
    icon: 'TerminalSquare',
    configSchema: {
      fields: [
        {
          key: 'thinking',
          label: 'Thinking',
          type: 'select',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'minimal', label: 'Minimal' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'xHigh' },
          ],
          default: 'medium',
          hint: 'Passado via --thinking.',
        },
        commandField('pi', 'Pi'),
      ],
    },
  },
  cliBinary: 'pi',
  models: [
    { id: 'default', label: 'Default (configurado no CLI)' },
    { id: 'openai/gpt-5.4', label: 'openai/gpt-5.4' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'anthropic/claude-sonnet-4-6' },
    { id: 'xai/grok-4', label: 'xai/grok-4' },
    { id: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro' },
  ],
});

// ---------------------------------------------------------------------------
// Cursor Cloud (config-driven, SDK) — selecionável mas execução é follow-up.
// ---------------------------------------------------------------------------
export const cursorCloud: AdapterModule = {
  descriptor: {
    type: 'cursor_cloud',
    name: 'Cursor Cloud',
    description: 'Managed remote Cursor agent',
    icon: 'Cloud',
    configSchema: {
      fields: [
        {
          key: 'repoUrl',
          label: 'URL do repositório',
          type: 'text',
          required: true,
          placeholder: 'https://github.com/org/repo',
        },
        {
          key: 'runtimeEnvType',
          label: 'Ambiente de runtime',
          type: 'select',
          options: [
            { value: 'cloud', label: 'Cloud' },
            { value: 'pool', label: 'Pool' },
            { value: 'machine', label: 'Machine' },
          ],
          default: 'cloud',
        },
        { key: 'autoCreatePR', label: 'Criar PR automaticamente', type: 'toggle', default: false },
      ],
    },
  },
  async listModels() {
    return [{ id: 'default', label: 'Default (conta configurada)' }];
  },
  async testEnvironment() {
    const startedAt = Date.now();
    // Config (repoUrl + CURSOR_API_KEY) é validada em runtime no
    // cursor-cloud-client. A execução de background agents exige o SDK
    // proprietário @cursor/sdk (não instalado) — o cliente lança um erro
    // honesto nesse caso, sem fingir sucesso.
    return aggregateResult(
      [
        {
          label: 'Configuração',
          status: 'warn',
          detail:
            'Cursor Cloud: defina repoUrl + CURSOR_API_KEY no agente. A execução de background agents requer o SDK @cursor/sdk (não instalado) — integração pendente.',
        },
      ],
      startedAt,
    );
  },
};

// ---------------------------------------------------------------------------
// OpenClaw Gateway (config-driven, WebSocket) — execução é follow-up.
// ---------------------------------------------------------------------------
export const openclawGateway: AdapterModule = {
  descriptor: {
    type: 'openclaw_gateway',
    name: 'OpenClaw Gateway',
    description: 'Remote executor via OpenClaw WebSocket gateway',
    icon: 'Workflow',
    executorOnly: true,
    configSchema: {
      fields: [
        {
          key: 'url',
          label: 'URL do gateway',
          type: 'text',
          required: true,
          placeholder: 'wss://gateway.example.com',
        },
        { key: 'authToken', label: 'Auth token', type: 'password' },
        { key: 'clientId', label: 'Client ID', type: 'text' },
        { key: 'scopes', label: 'Scopes', type: 'text', hint: 'Scopes separados por espaço.' },
        {
          key: 'sessionKeyStrategy',
          label: 'Estratégia de session key',
          type: 'select',
          options: [
            { value: 'issue', label: 'Por issue' },
            { value: 'fixed', label: 'Fixa' },
            { value: 'run', label: 'Por run' },
          ],
          default: 'issue',
        },
      ],
    },
  },
  async listModels() {
    // Modelo vem do gateway remoto.
    return [{ id: 'default', label: 'Default (gateway configurado)' }];
  },
  async testEnvironment() {
    const startedAt = Date.now();
    // Execução real via WebSocket frame-RPC (openclaw-client). O probe aqui não
    // recebe adapterConfig nesta app, então só orienta a configurar URL/token;
    // a conexão WebSocket é validada na primeira execução (chat/issue).
    return aggregateResult(
      [
        {
          label: 'Configuração',
          status: 'warn',
          detail:
            'OpenClaw Gateway: defina a Gateway URL (ws:// ou wss://) e o Auth Token no agente. A conexão WebSocket é validada na primeira execução.',
        },
      ],
      startedAt,
    );
  },
};
