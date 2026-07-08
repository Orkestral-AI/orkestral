import type { AdapterModel } from '@shared/types';
import type { AdapterModule } from '../types';
import { aggregateResult, run, which } from '../probe';

/**
 * Adapter pro `gemini` CLI (Google Gemini CLI).
 */
export const geminiLocal: AdapterModule = {
  descriptor: {
    type: 'gemini_local',
    name: 'Gemini CLI',
    description: 'Local Gemini agent',
    icon: 'Gem',
    configSchema: {
      fields: [
        {
          key: 'sandbox',
          label: 'Rodar em sandbox',
          type: 'toggle',
          default: false,
          hint: 'Passa --sandbox para o CLI.',
        },
        {
          key: 'command',
          label: 'Comando (override)',
          type: 'text',
          placeholder: 'gemini',
          hint: 'Path ou comando para invocar o CLI. Default: gemini.',
        },
      ],
    },
  },

  async listModels(): Promise<AdapterModel[]> {
    return [
      { id: 'default', label: 'Default', description: 'Usa o modelo configurado no CLI' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Mais rápido e barato' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite' },
    ];
  },

  async testEnvironment() {
    const startedAt = Date.now();
    const checks: Awaited<ReturnType<AdapterModule['testEnvironment']>>['checks'] = [];

    const bin = await which('gemini');
    if (!bin) {
      checks.push({
        label: 'CLI `gemini` no PATH',
        status: 'fail',
        detail: 'Não encontrei o binário `gemini`. Instale via `npm i -g @google/gemini-cli`.',
      });
      return aggregateResult(checks, startedAt);
    }
    checks.push({ label: 'CLI `gemini` no PATH', status: 'pass', detail: bin });

    const versionRun = await run('gemini', ['--version'], { timeoutMs: 5_000 });
    if (!versionRun.ok) {
      checks.push({
        label: 'Versão do CLI',
        status: 'fail',
        detail: versionRun.stderr.trim() || 'CLI não respondeu a --version.',
      });
      return aggregateResult(checks, startedAt);
    }
    checks.push({
      label: 'Versão do CLI',
      status: 'pass',
      detail: versionRun.stdout.trim(),
    });

    // Credenciais Google
    const hasAdc = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const hasKey = !!process.env.GEMINI_API_KEY;
    if (!hasAdc && !hasKey) {
      checks.push({
        label: 'Credenciais Google',
        status: 'warn',
        detail:
          'Nem GOOGLE_APPLICATION_CREDENTIALS nem GEMINI_API_KEY definidas. Pode falhar no run.',
      });
    } else {
      checks.push({
        label: 'Credenciais Google',
        status: 'pass',
        detail: hasKey ? 'GEMINI_API_KEY presente' : 'GOOGLE_APPLICATION_CREDENTIALS presente',
      });
    }

    return aggregateResult(checks, startedAt, 'Gemini CLI pronto pra trabalhar.');
  },
};
