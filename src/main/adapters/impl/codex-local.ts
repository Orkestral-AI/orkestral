import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterModel } from '@shared/types';
import type { AdapterModule } from '../types';
import { aggregateResult, run, which } from '../probe';

/** Diretório de config do Codex (respeita CODEX_HOME). */
function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

/**
 * Lê os modelos disponíveis do cache que o próprio Codex CLI mantém em
 * `~/.codex/models_cache.json` (atualizado pelo servidor a cada run).
 * Assim a lista reflete o que a conta realmente tem acesso — sem hardcode.
 */
function readCodexModels(): AdapterModel[] | null {
  try {
    const raw = readFileSync(join(codexHome(), 'models_cache.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        description?: string;
        visibility?: string;
      }>;
    };
    const models = (parsed.models ?? [])
      // visibility != "list" são modelos internos (ex: auto-review) — fora do seletor.
      .filter((m) => m.slug && m.visibility === 'list')
      .map((m) => ({
        id: m.slug as string,
        label: m.display_name || (m.slug as string),
        description: m.description,
      }));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/**
 * Adapter pro `codex` CLI (OpenAI Codex CLI).
 */
export const codexLocal: AdapterModule = {
  descriptor: {
    type: 'codex_local',
    name: 'Codex',
    description: 'Local Codex agent',
    icon: 'Code',
    recommended: true,
    configSchema: {
      fields: [
        {
          key: 'modelReasoningEffort',
          label: 'Esforço de raciocínio',
          type: 'select',
          options: [
            { value: 'minimal', label: 'Mínimo' },
            { value: 'low', label: 'Baixo' },
            { value: 'medium', label: 'Médio' },
            { value: 'high', label: 'Alto' },
            { value: 'xhigh', label: 'Muito alto' },
          ],
          default: 'medium',
          hint: 'Passado via -c model_reasoning_effort=...',
        },
        {
          key: 'search',
          label: 'Busca na web (--search)',
          type: 'toggle',
          default: false,
        },
        {
          key: 'command',
          label: 'Comando (override)',
          type: 'text',
          placeholder: 'codex',
          hint: 'Path ou comando para invocar o CLI. Default: codex.',
        },
      ],
    },
  },

  async listModels(): Promise<AdapterModel[]> {
    const base: AdapterModel = {
      id: 'default',
      label: 'Default (configurado no CLI)',
      description: 'Usa o modelo padrão do Codex CLI',
    };
    // Prefere o cache real do CLI (~/.codex/models_cache.json) quando existe;
    // senão cai pra uma lista estática versionada (newest-first).
    const dynamic = readCodexModels();
    if (dynamic) return [base, ...dynamic];
    return [
      base,
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
      { id: 'gpt-5-nano', label: 'GPT-5 Nano' },
      { id: 'o3', label: 'OpenAI o3' },
      { id: 'o3-mini', label: 'OpenAI o3-mini' },
      { id: 'o4-mini', label: 'OpenAI o4-mini' },
      { id: 'codex-mini-latest', label: 'Codex Mini' },
    ];
  },

  async testEnvironment() {
    const startedAt = Date.now();
    const checks: Awaited<ReturnType<AdapterModule['testEnvironment']>>['checks'] = [];

    const bin = await which('codex');
    if (!bin) {
      checks.push({
        label: 'CLI `codex` no PATH',
        status: 'fail',
        detail:
          'Não encontrei o binário `codex`. Instale via `npm i -g @openai/codex` ou siga o guia oficial.',
      });
      return aggregateResult(checks, startedAt);
    }
    checks.push({ label: 'CLI `codex` no PATH', status: 'pass', detail: bin });

    const versionRun = await run('codex', ['--version'], { timeoutMs: 5_000 });
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

    // Probe via exec headless. stdin é fechado automaticamente pelo helper.
    const probe = await run('codex', ['exec', '--skip-git-repo-check', '--yolo', '-'], {
      timeoutMs: 45_000,
      input: 'Respond with hello.',
    });
    const cleanStderr = probe.stderr
      .replace(/Warning: no stdin data received[^\n]*\n?/g, '')
      .replace(/If piping from a slow command[^\n]*\n?/g, '')
      .trim();

    const combined = (cleanStderr + ' ' + probe.stdout).toLowerCase();
    const needsAuth =
      combined.includes('please log in') ||
      combined.includes('codex login') ||
      combined.includes('not authenticated') ||
      combined.includes('unauthorized') ||
      combined.includes('api key');

    if (needsAuth) {
      checks.push({
        label: 'Resposta do agente',
        status: 'warn',
        detail: 'Não autenticado. Rode `codex auth`/`codex login` ou exporte OPENAI_API_KEY.',
      });
    } else if (probe.stdout.toLowerCase().includes('hello')) {
      checks.push({ label: 'Resposta do agente', status: 'pass', detail: 'hello recebido ✓' });
    } else if (probe.timedOut) {
      checks.push({
        label: 'Resposta do agente',
        status: 'warn',
        detail: 'Probe timed out — tente novamente.',
      });
    } else {
      checks.push({
        label: 'Resposta do agente',
        status: 'warn',
        detail: (cleanStderr || probe.stdout.trim() || 'Resposta inesperada.').slice(0, 220),
      });
    }

    return aggregateResult(checks, startedAt, 'Codex pronto pra trabalhar.');
  },
};
