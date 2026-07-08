import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Integração com a CLI oficial da Microsoft (`@microsoft/teams.cli`) pra criar o
 * app/bot do Teams sem o usuário registrar nada à mão no Azure. Um comando
 * (`teams app create`) cria a aplicação Entra ID, gera o client secret, sobe o
 * manifesto do app e registra o bot (Teams-managed). A CLI age COMO o usuário,
 * então exige um `teams login` prévio (browser) e permissão de sideload no tenant
 * — coisas que nenhuma automação burla. Aqui orquestramos a CLI, lemos a saída e
 * devolvemos as credenciais já parseadas pro app preencher sozinho.
 */

export interface TeamsAppCreds {
  appId: string;
  appPassword: string;
  tenantId: string;
  /** ID do app Teams (manifesto) — usado pra reapontar o endpoint via `app update`. */
  teamsAppId?: string;
}

/** Código de erro estruturado pra UI reagir (ex.: pedir login). */
export type TeamsCliErrorCode = 'not-logged-in' | 'cli-missing' | 'failed';

export class TeamsCliError extends Error {
  constructor(
    readonly code: TeamsCliErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TeamsCliError';
  }
}

const CLI_SPEC = '@microsoft/teams.cli@preview';
/** Timeout generoso: o create faz chamadas ao Azure; o login espera o browser. */
const RUN_TIMEOUT_MS = 240_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Apps de GUI no macOS não herdam o PATH do shell — reforça os bins comuns. */
function runEnv(): NodeJS.ProcessEnv {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.npm-global/bin')];
  return { ...process.env, PATH: [process.env.PATH, ...extra].filter(Boolean).join(':') };
}

function run(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    // stdin fechado: com `--json` a CLI não deve prompt; o EOF evita travar caso prompte.
    const child = spawn('npx', ['-y', CLI_SPEC, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: runEnv(),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (res: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* já morto */
      }
      finish({ code: -1, stdout, stderr: `${stderr}\n[timeout]` });
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => finish({ code: -1, stdout, stderr: `${stderr}\n${String(err)}` }));
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}

/** Garante que a URL termina em /api/messages (o endpoint do bot). */
export function normalizeMessagingEndpoint(raw: string): string {
  const url = raw.trim().replace(/\/+$/, '');
  if (!url) throw new TeamsCliError('failed', 'URL pública (túnel) vazia.');
  return /\/api\/messages$/i.test(url) ? url : `${url}/api/messages`;
}

/** Casa uma chave (de .env ou JSON) com o campo de credencial, sem depender do
 *  nome exato que a CLI usa (CLIENT_ID / BOT_ID / MicrosoftAppId / appId …). */
function classifyKey(key: string): keyof TeamsAppCreds | null {
  const k = key.toLowerCase().replace(/[^a-z]/g, '');
  if (/(client|app|bot|microsoftapp)id$/.test(k) || k === 'clientid' || k === 'botid')
    return 'appId';
  if (/(secret|password)$/.test(k)) return 'appPassword';
  if (/tenantid$/.test(k)) return 'tenantId';
  return null;
}

/** Extrai as 3 credenciais de um conjunto plano chave→valor (defensivo). */
function pickCreds(entries: Array<[string, string]>): TeamsAppCreds | null {
  const out: Partial<TeamsAppCreds> = {};
  for (const [key, value] of entries) {
    const field = classifyKey(key);
    if (field && value && !out[field]) out[field] = value;
  }
  if (out.appId && out.appPassword && out.tenantId) {
    return { appId: out.appId, appPassword: out.appPassword, tenantId: out.tenantId };
  }
  return null;
}

function parseEnvFile(path: string): TeamsAppCreds | null {
  if (!existsSync(path)) return null;
  const entries: Array<[string, string]> = [];
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) entries.push([m[1], m[2].replace(/^["']|["']$/g, '')]);
  }
  return pickCreds(entries);
}

function flatten(obj: unknown, into: Array<[string, string]>): void {
  if (!obj || typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value && typeof value === 'object') flatten(value, into);
    else if (value != null) into.push([key, String(value)]);
  }
}

function parseJson(stdout: string): unknown {
  const match = /\{[\s\S]*\}/.exec(stdout);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function credsFromJson(parsed: unknown): TeamsAppCreds | null {
  if (!parsed) return null;
  const entries: Array<[string, string]> = [];
  flatten(parsed, entries);
  return pickCreds(entries);
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Procura o Teams App ID (manifesto) na saída JSON — chave teamsAppId/manifestId. */
function findTeamsAppId(parsed: unknown): string | undefined {
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const [key, value] of Object.entries(cur as Record<string, unknown>)) {
      const nk = key.toLowerCase().replace(/[^a-z]/g, '');
      if (
        (nk.includes('teamsappid') || nk === 'manifestid') &&
        typeof value === 'string' &&
        GUID_RE.test(value)
      ) {
        return value;
      }
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return undefined;
}

function looksNotLoggedIn(text: string): boolean {
  return /not\s+logged\s+in|teams\s+login|not\s+authenticated|unauthorized|please\s+log\s?in|run\s+`?teams login/i.test(
    text,
  );
}

function looksCliMissing(text: string): boolean {
  return /command not found|ENOENT|not recognized|could not determine executable|npm error/i.test(
    text,
  );
}

/**
 * Cria o app/bot do Teams via CLI e devolve as credenciais já parseadas.
 * `endpoint` é a URL PÚBLICA (do túnel) — normalizada pra terminar em /api/messages.
 */
export async function teamsCreateApp(params: {
  name: string;
  endpoint: string;
}): Promise<TeamsAppCreds> {
  const endpoint = normalizeMessagingEndpoint(params.endpoint);
  const dir = mkdtempSync(join(tmpdir(), 'orkestral-teams-'));
  const envPath = join(dir, 'creds.env');
  try {
    const res = await run(
      [
        'app',
        'create',
        '-n',
        params.name,
        '-e',
        endpoint,
        '--teams-managed',
        '--env',
        envPath,
        '--json',
      ],
      dir,
    );
    const parsed = parseJson(res.stdout);
    const creds = parseEnvFile(envPath) ?? credsFromJson(parsed);
    if (creds) {
      const teamsAppId = findTeamsAppId(parsed);
      return teamsAppId ? { ...creds, teamsAppId } : creds;
    }

    const blob = `${res.stdout}\n${res.stderr}`;
    if (looksNotLoggedIn(blob)) {
      throw new TeamsCliError(
        'not-logged-in',
        'Faça login na sua conta Microsoft antes de criar o app.',
      );
    }
    if (res.code === -1 && looksCliMissing(blob)) {
      throw new TeamsCliError(
        'cli-missing',
        'Não foi possível executar a CLI do Teams (npx indisponível).',
      );
    }
    throw new TeamsCliError(
      'failed',
      (res.stderr || res.stdout || 'Falha ao criar o app.').trim().slice(0, 600),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Reaponta o messaging endpoint do app Teams (necessário quando a URL do túnel
 * muda entre sessões). `endpoint` é a URL pública — normalizada pra /api/messages.
 */
export async function teamsUpdateEndpoint(teamsAppId: string, endpoint: string): Promise<void> {
  const url = normalizeMessagingEndpoint(endpoint);
  const res = await run(['app', 'update', teamsAppId, '--endpoint', url], tmpdir());
  if (res.code === 0) return;
  const blob = `${res.stdout}\n${res.stderr}`;
  if (looksNotLoggedIn(blob)) {
    throw new TeamsCliError('not-logged-in', 'Faça login na sua conta Microsoft.');
  }
  throw new TeamsCliError(
    'failed',
    (res.stderr || res.stdout || 'Falha ao atualizar o endpoint.').trim().slice(0, 600),
  );
}

export interface TeamsDeviceCode {
  /** Página onde o usuário cola o código (microsoft.com/devicelogin). */
  url: string;
  /** Código de uso único que o usuário digita na página. */
  code: string;
}

/** Processo de login pendente (fica vivo fazendo poll até o usuário concluir). */
let loginChild: ChildProcess | null = null;

/** Cancela um login pendente (novo login ou no fechamento do app). */
export function stopLogin(): void {
  if (!loginChild) return;
  try {
    loginChild.kill('SIGTERM');
  } catch {
    /* já morto */
  }
  loginChild = null;
}

function parseDeviceCode(out: string): TeamsDeviceCode | null {
  // Formato real do MSAL (confirmado na CLI):
  // "...open the page https://login.microsoft.com/device and enter the code E9BN4XGST..."
  const both = /open the page\s+(https:\/\/\S+?)\s+and enter the code\s+([A-Z0-9-]+)/i.exec(out);
  let url: string | undefined = both?.[1];
  let code: string | undefined = both?.[2];
  if (!code) {
    code = (/enter the code\s+([A-Z0-9-]{4,})/i.exec(out) ??
      /\bcode\b[:\s]+([A-Z0-9]{6,})/i.exec(out))?.[1];
    // Só aceita a URL de device login da Microsoft — nunca a URL de broker
    // (vscode.dev/redirect…) que a CLI também imprime e dá erro de OAuth.
    url = (/https:\/\/\S*microsoft\.com\/device\S*/i.exec(out) ??
      /https:\/\/\S*device(?:login|auth)\S*/i.exec(out))?.[0];
  }
  if (!code) return null;
  return { url: (url ?? 'https://login.microsoft.com/device').replace(/[).,]+$/, ''), code };
}

/**
 * Garante que o usuário está logado (device code). Roda `teams login --device-code`:
 *  - se já está logado, a CLI sai 0 rápido (sem código) → resolve direto;
 *  - senão, imprime URL+código (emitimos via `onCode`) e o processo segue fazendo
 *    poll até o usuário concluir no navegador; quando sai 0, resolve.
 *
 * Isso é o que evita o bug do vscode.dev: `teams app create` rodado SEM login
 * dispara um login INTERATIVO (abre o broker no navegador). Garantindo o login por
 * device code ANTES do create, o create já encontra o token em cache e não abre nada.
 */
export function teamsEnsureLogin(onCode: (dc: TeamsDeviceCode) => void): Promise<void> {
  stopLogin();
  console.log('[teams][login-first] spawn: npx', CLI_SPEC, 'login --device-code');
  return new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['-y', CLI_SPEC, 'login', '--device-code'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: runEnv(),
    });
    loginChild = child;
    let out = '';
    let settled = false;
    let codeShown = false;
    let logged = false;
    let codeTimer: ReturnType<typeof setTimeout>;
    let doneTimer: ReturnType<typeof setTimeout>;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(codeTimer);
      clearTimeout(doneTimer);
      fn();
    };
    const onData = (chunk: Buffer): void => {
      out += String(chunk);
      if (!logged) {
        logged = true;
        console.log('[teams][login-first] primeira saída da CLI:', String(chunk).slice(0, 240));
      }
      if (codeShown) return;
      const dc = parseDeviceCode(out);
      if (!dc) return;
      codeShown = true;
      clearTimeout(codeTimer); // já temos o código; agora esperamos o usuário concluir
      console.log('[teams][login-first] device code:', dc.code, '→', dc.url);
      onCode(dc);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) =>
      finish(() => {
        loginChild = null;
        reject(
          looksCliMissing(String(err))
            ? new TeamsCliError('cli-missing', 'Não foi possível executar a CLI do Teams.')
            : new TeamsCliError('failed', String(err)),
        );
      }),
    );
    child.on('close', (code) => {
      if (loginChild === child) loginChild = null;
      finish(() => {
        console.log('[teams][login-first] login encerrou com código', code);
        if (code === 0) resolve();
        else reject(new TeamsCliError('failed', (out || 'Falha no login.').trim().slice(0, 400)));
      });
    });
    // Sem código nem saída em 60s → algo travou ao iniciar o login.
    codeTimer = setTimeout(() => {
      finish(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* já morto */
        }
        reject(new TeamsCliError('failed', 'Tempo esgotado iniciando o login.'));
      });
    }, 60_000);
    // Depois do código, dá 10 min pro usuário concluir no navegador.
    doneTimer = setTimeout(() => {
      finish(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* já morto */
        }
        // O caso mais comum de o login nunca concluir é conta pessoal (o Teams
        // exige conta corporativa/escolar) — orienta direto.
        reject(
          new TeamsCliError(
            'failed',
            'Login não concluído. O Teams exige conta corporativa/escolar (Microsoft 365) — contas pessoais (outlook/hotmail) não funcionam.',
          ),
        );
      });
    }, 600_000);
  });
}
