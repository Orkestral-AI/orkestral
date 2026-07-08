import { afterEach, describe, expect, it } from 'vitest';
import {
  applyClaudePolicy,
  scrubSpawnEnv,
  declaredEnvKeys,
  resolveReasoningEffort,
  type SpawnPolicy,
} from './spawn-policy';
import { setPermissionMode } from '../cli/permission';

function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    // sensíveis — devem sair
    GITHUB_TOKEN: 'ghp_xxx',
    GH_TOKEN: 'ghp_yyy',
    FOO_SECRET: 'shh',
    BAR_API_KEY: 'bar-key',
    SOME_PASSWORD: 'pw',
    MY_ACCESS_KEY: 'ak',
    // auth do modelo / git / sistema — devem ficar
    ANTHROPIC_API_KEY: 'anthropic',
    OPENAI_API_KEY: 'openai',
    GEMINI_API_KEY: 'gemini',
    PATH: '/usr/bin',
    HOME: '/Users/dev',
    SSH_AUTH_SOCK: '/tmp/ssh.sock',
    GIT_SSH_COMMAND: 'ssh -i ~/.ssh/id',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CODEX_HOME: '/Users/dev/.codex',
    // neutra qualquer — fica
    LANG: 'en_US.UTF-8',
  };
}

describe('scrubSpawnEnv', () => {
  it('removes obviously-sensitive vars', () => {
    const env = scrubSpawnEnv(fixtureEnv());
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.FOO_SECRET).toBeUndefined();
    expect(env.BAR_API_KEY).toBeUndefined();
    expect(env.SOME_PASSWORD).toBeUndefined();
    expect(env.MY_ACCESS_KEY).toBeUndefined();
  });

  it('keeps model-auth, git and system vars the CLIs need', () => {
    const env = scrubSpawnEnv(fixtureEnv());
    expect(env.ANTHROPIC_API_KEY).toBe('anthropic');
    expect(env.OPENAI_API_KEY).toBe('openai');
    expect(env.GEMINI_API_KEY).toBe('gemini');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/dev');
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh.sock');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/id');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('cli');
    expect(env.CODEX_HOME).toBe('/Users/dev/.codex');
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it('returns a fresh object (does not mutate input)', () => {
    const base = fixtureEnv();
    const env = scrubSpawnEnv(base);
    expect(env).not.toBe(base);
    expect(base.GITHUB_TOKEN).toBe('ghp_xxx');
    env.NEW_VAR = 'x';
    expect(base.NEW_VAR).toBeUndefined();
  });

  it('keeps declared keys even when they match the deny/regex (agent needs them)', () => {
    const env = scrubSpawnEnv(fixtureEnv(), ['GITHUB_TOKEN', 'BAR_API_KEY']);
    // declarados pelo agente → preservam o valor herdado do shell
    expect(env.GITHUB_TOKEN).toBe('ghp_xxx');
    expect(env.BAR_API_KEY).toBe('bar-key');
    // não declarados → continuam removidos
    expect(env.GH_TOKEN).toBeUndefined();
  });
});

describe('declaredEnvKeys', () => {
  it('extracts non-empty trimmed keys from runtimeConfig.envVars', () => {
    expect(
      declaredEnvKeys({
        envVars: [{ key: 'GITHUB_TOKEN' }, { key: '  GH_TOKEN  ' }, { key: '' }, { key: '   ' }],
      }),
    ).toEqual(['GITHUB_TOKEN', 'GH_TOKEN']);
    expect(declaredEnvKeys(null)).toEqual([]);
    expect(declaredEnvKeys(undefined)).toEqual([]);
  });
});

describe('applyClaudePolicy — modo de permissão da CLI', () => {
  // O modo é estado de processo — sempre volta pro default pra não vazar
  // entre testes (a GUI/os outros testes contam com `default` = no-op).
  afterEach(() => setPermissionMode('default'));

  const bypass: SpawnPolicy = { skipPermissions: true, sandbox: false };
  const restricted: SpawnPolicy = {
    skipPermissions: false,
    sandbox: true,
    allowedTools: ['Read', 'Grep'],
  };

  it('default + bypass → só a flag de skip (byte-idêntico à GUI)', () => {
    const args: string[] = [];
    applyClaudePolicy(args, bypass);
    expect(args).toEqual(['--dangerously-skip-permissions']);
  });

  it('default + restrito → só a whitelist (sem --permission-mode)', () => {
    const args: string[] = [];
    applyClaudePolicy(args, restricted);
    expect(args).toEqual(['--allowedTools', 'Read,Grep']);
  });

  it('acceptEdits mapeia pra `--permission-mode acceptEdits` e vence o skip da policy', () => {
    setPermissionMode('acceptEdits');
    const args: string[] = [];
    applyClaudePolicy(args, bypass);
    expect(args).toEqual(['--permission-mode', 'acceptEdits']);
  });

  it('plan mapeia pra `--permission-mode plan` e vence o skip da policy', () => {
    setPermissionMode('plan');
    const args: string[] = [];
    applyClaudePolicy(args, bypass);
    expect(args).toEqual(['--permission-mode', 'plan']);
  });

  it('não duplica --permission-mode quando os args já têm a flag', () => {
    setPermissionMode('plan');
    const args: string[] = [];
    applyClaudePolicy(args, bypass);
    applyClaudePolicy(args, bypass);
    expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
  });

  it('acceptEdits + restrito mantém a whitelist de tools junto', () => {
    setPermissionMode('acceptEdits');
    const args: string[] = [];
    applyClaudePolicy(args, restricted);
    expect(args).toEqual(['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Grep']);
  });

  it('dangerously-skip continua forçando a flag de skip (sem --permission-mode)', () => {
    setPermissionMode('dangerously-skip');
    const args: string[] = [];
    applyClaudePolicy(args, restricted);
    expect(args).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('resolveReasoningEffort — runtimeConfig.thinkingEffort tem precedência', () => {
  it('UI (runtimeConfig.thinkingEffort) vence adapterConfig.effort', () => {
    expect(
      resolveReasoningEffort({
        adapterConfig: { effort: 'high' },
        runtimeConfig: { thinkingEffort: 'low' },
      }),
    ).toBe('low');
  });
  it("'auto' no runtimeConfig cai pro adapterConfig.effort", () => {
    expect(
      resolveReasoningEffort({
        adapterConfig: { effort: 'high' },
        runtimeConfig: { thinkingEffort: 'auto' },
      }),
    ).toBe('high');
  });
  it('sem effort no agente herda do orquestrador (runtimeConfig)', () => {
    expect(
      resolveReasoningEffort({ adapterConfig: {} }, { runtimeConfig: { thinkingEffort: 'xhigh' } }),
    ).toBe('xhigh');
  });
  it('nada configurado → null (default do CLI)', () => {
    expect(resolveReasoningEffort({ adapterConfig: {} })).toBeNull();
  });
  it("modo rápido (fastMode) sem effort explícito força 'low' — executa mais rápido", () => {
    expect(resolveReasoningEffort({ adapterConfig: {}, runtimeConfig: { fastMode: true } })).toBe(
      'low',
    );
  });
  it('effort explícito do agente vence o fastMode', () => {
    expect(
      resolveReasoningEffort({
        adapterConfig: {},
        runtimeConfig: { fastMode: true, thinkingEffort: 'high' },
      }),
    ).toBe('high');
  });
});
