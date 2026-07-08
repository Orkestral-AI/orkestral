import type { AdapterModel } from '@shared/types';
import type { AdapterModule } from '../types';
import { aggregateResult, run, which } from '../probe';

/**
 * Adapter pro `claude` CLI (Claude Code da Anthropic).
 * Probe roda `claude --version` e tenta um prompt mínimo.
 */
export const claudeLocal: AdapterModule = {
  descriptor: {
    type: 'claude_local',
    name: 'Claude Code',
    description: 'Local Claude agent',
    icon: 'Sparkles',
    recommended: true,
    configSchema: {
      fields: [
        {
          key: 'effort',
          label: 'Esforço de raciocínio',
          type: 'select',
          options: [
            { value: 'low', label: 'Baixo' },
            { value: 'medium', label: 'Médio' },
            { value: 'high', label: 'Alto' },
          ],
          default: 'medium',
          hint: 'Passado via --effort para o CLI.',
        },
        {
          key: 'chrome',
          label: 'Ferramentas de browser (Chrome)',
          type: 'toggle',
          default: false,
        },
        {
          key: 'instructionsFilePath',
          label: 'Arquivo de instruções',
          type: 'file',
          placeholder: '/caminho/para/INSTRUCTIONS.md',
          hint: 'Markdown injetado no system prompt em runtime.',
        },
        {
          key: 'command',
          label: 'Comando (override)',
          type: 'text',
          placeholder: 'claude',
          hint: 'Path ou comando para invocar o CLI. Default: claude.',
        },
      ],
    },
  },

  async listModels(): Promise<AdapterModel[]> {
    // Versões explícitas (newest-first) + aliases de tier. Os aliases o CLI
    // resolve sempre pro modelo mais novo (`claude --model opus`).
    return [
      {
        id: 'default',
        label: 'Default (configurado no CLI)',
        description: 'Usa o modelo configurado no CLI',
      },
      {
        id: 'claude-fable-5',
        label: 'Claude Fable 5',
        description: 'Tier Mythos — acima do Opus, o mais capaz',
      },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
      { id: 'opus', label: 'Opus (alias)', description: 'Mais recente do tier Opus' },
      { id: 'sonnet', label: 'Sonnet (alias)', description: 'Mais recente do tier Sonnet' },
      { id: 'haiku', label: 'Haiku (alias)', description: 'Mais recente do tier Haiku' },
    ];
  },

  async testEnvironment() {
    const startedAt = Date.now();
    const checks: Awaited<ReturnType<AdapterModule['testEnvironment']>>['checks'] = [];

    // 1. CLI no PATH?
    const bin = await which('claude');
    if (!bin) {
      checks.push({
        label: 'CLI `claude` no PATH',
        status: 'fail',
        detail:
          'Não encontrei o binário `claude`. Instale via `npm i -g @anthropic-ai/claude-code` ou siga o guia oficial.',
      });
      return aggregateResult(checks, startedAt);
    }
    checks.push({ label: 'CLI `claude` no PATH', status: 'pass', detail: bin });

    // 2. --version responde?
    const versionRun = await run('claude', ['--version'], { timeoutMs: 5_000 });
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

    // 3. Probe — mesma abordagem do paperclip:
    //    `claude --print - --dangerously-skip-permissions` com o prompt vindo
    //    via stdin. O `-` diz pro claude ler o prompt do stdin.
    //    `--dangerously-skip-permissions` evita prompts interativos de permissão
    //    que travariam o probe.
    const probe = await run('claude', ['--print', '-', '--dangerously-skip-permissions'], {
      timeoutMs: 45_000,
      input: 'Respond with hello.',
    });

    // Filtra warnings benignos do stderr (várias variações)
    const cleanStderr = probe.stderr
      .replace(/Warning: no stdin data received[^\n]*\n?/g, '')
      .replace(/If piping from a slow command[^\n]*\n?/g, '')
      .trim();

    // Detecta login necessário antes de avaliar conteúdo
    const combined = (cleanStderr + ' ' + probe.stdout).toLowerCase();
    const needsLogin =
      combined.includes('please log in') ||
      combined.includes('claude login') ||
      combined.includes('not authenticated') ||
      combined.includes('unauthorized');

    if (needsLogin) {
      checks.push({
        label: 'Resposta do agente',
        status: 'warn',
        detail: 'Não está logado. Rode `claude login` no terminal e tente novamente.',
      });
    } else if (probe.stdout.toLowerCase().includes('hello')) {
      checks.push({ label: 'Resposta do agente', status: 'pass', detail: 'hello recebido ✓' });
    } else if (probe.timedOut) {
      checks.push({
        label: 'Resposta do agente',
        status: 'warn',
        detail: 'Probe timed out — tente novamente ou rode `claude` no terminal pra verificar.',
      });
    } else {
      checks.push({
        label: 'Resposta do agente',
        status: 'warn',
        detail: (cleanStderr || probe.stdout.trim() || 'Resposta inesperada.').slice(0, 220),
      });
    }

    return aggregateResult(checks, startedAt, 'Claude Code pronto pra trabalhar.');
  },
};
