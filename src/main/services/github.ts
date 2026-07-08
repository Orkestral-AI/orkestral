import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { secrets } from '../platform/host';
import { openExternalSafe } from '../utils/safe-shell';
import { GithubAccountRepository } from '../db/repositories/github.repo';

/**
 * Client ID da OAuth App registrada no GitHub. Device Flow não usa secret.
 * Pode ser override via env var ORKESTRAL_GITHUB_CLIENT_ID (útil pra
 * desenvolvedores que querem testar com sua própria app).
 */
const DEFAULT_CLIENT_ID = 'Ov23liWTkD5zkdxoY5fz';

function getClientId(): string {
  return process.env.ORKESTRAL_GITHUB_CLIENT_ID || DEFAULT_CLIENT_ID;
}

function oauthApplicationSettingsUrl(): string {
  return `https://github.com/settings/connections/applications/${encodeURIComponent(getClientId())}`;
}

/**
 * Scopes do GitHub. `repo` cobre repos privados; `read:user` lê perfil.
 * Se o usuário só tiver repos públicos, `public_repo` seria suficiente —
 * mas vamos abrangente pra cobrir o caso real.
 */
const SCOPES = 'repo read:user';

const USER_AGENT = 'Orkestral/0.1 (Electron Desktop)';

const MAX_RATE_LIMIT_RETRIES = 2;

const repo = new GithubAccountRepository();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch que respeita rate-limit do GitHub: 429 (Retry-After) e o 403 de
 * secondary-rate-limit (x-ratelimit-remaining: 0 → espera o x-ratelimit-reset).
 * Sem isso, throttle vira erro opaco "HTTP 403/429" no meio da paginação.
 * Teto de 30s por espera pra não pendurar a UI.
 */
async function fetchGithub(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const res = await fetch(url, init);
    const rateLimited =
      res.status === 429 ||
      (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
    if (!rateLimited || attempt >= MAX_RATE_LIMIT_RETRIES) return res;
    await sleep(rateLimitWaitMs(res));
  }
  return fetch(url, init); // inalcançável: o loop sempre retorna na última tentativa
}

/** Espera derivada de Retry-After (segundos) ou x-ratelimit-reset (epoch s), teto 30s. */
function rateLimitWaitMs(res: Response): number {
  const retryAfter = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1000 - Date.now(), 0), 30_000);
  }
  return 1000;
}

// ---------------------------------------------------------------------------
// Device Flow
// ---------------------------------------------------------------------------

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface RawDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  // GitHub's /login/* endpoints aceitam form-urlencoded de forma mais confiável
  // que JSON. Accept: application/json é o que faz eles devolverem JSON.
  const body = new URLSearchParams({
    client_id: getClientId(),
    scope: SCOPES,
  });
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(decodeGithubError(res.status, raw, 'device code'));
  }

  const data = (await res.json()) as RawDeviceCode & {
    error?: string;
    error_description?: string;
  };
  // Mesmo com 200, GitHub pode devolver um JSON de erro pra OAuth Apps sem
  // Device Flow habilitado. Trata isso explicitamente.
  if (data.error) {
    throw new Error(decodeGithubError(200, JSON.stringify(data), 'device code'));
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

/**
 * Decodifica respostas de erro do GitHub OAuth e devolve mensagem actionable.
 * O caso mais comum é "device_flow_disabled" — OAuth App sem o checkbox marcado.
 */
function decodeGithubError(status: number, body: string, stage: string): string {
  let parsed: { error?: string; error_description?: string } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    // body não é JSON — usa direto na mensagem
  }

  if (parsed.error === 'device_flow_disabled') {
    return (
      'Device Flow não está habilitado nesta OAuth App. Vai em ' +
      'github.com/settings/applications, abre a app, marca o checkbox ' +
      '"Enable Device Flow" e salva.'
    );
  }
  if (parsed.error === 'incorrect_client_credentials' || parsed.error === 'invalid_client') {
    return (
      'Client ID inválido ou desconhecido. Confere o GITHUB_CLIENT_ID — ' +
      'a OAuth App precisa existir e o ID precisa bater exatamente.'
    );
  }
  if (parsed.error && parsed.error_description) {
    return `GitHub ${stage}: ${parsed.error_description} (${parsed.error})`;
  }
  if (parsed.error) {
    return `GitHub ${stage}: ${parsed.error}`;
  }
  return `GitHub ${stage} falhou (HTTP ${status})${body ? `: ${body.slice(0, 200)}` : ''}`;
}

export type DeviceFlowPollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'authorized'; account: PublicGithubAccount };

interface RawTokenResponse {
  access_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

/**
 * Faz UM poll do endpoint de token. Retorna o status corrente — o caller
 * (handler IPC) decide se continua polando.
 */
export async function pollDeviceFlow(deviceCode: string): Promise<DeviceFlowPollResult> {
  const body = new URLSearchParams({
    client_id: getClientId(),
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(decodeGithubError(res.status, raw, 'token poll'));
  }

  const data = (await res.json()) as RawTokenResponse;

  if (data.error) {
    switch (data.error) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'slow_down', interval: data.interval ?? 5 };
      case 'expired_token':
        return { status: 'expired' };
      case 'access_denied':
        return { status: 'denied' };
      default:
        throw new Error(data.error_description || data.error);
    }
  }

  if (!data.access_token) {
    return { status: 'pending' };
  }

  // Sucesso — busca perfil, criptografa o token e persiste.
  const user = await fetchAuthenticatedUser(data.access_token);
  const encrypted = encryptToken(data.access_token);
  const record = repo.upsert({
    login: user.login,
    displayName: user.name ?? null,
    avatarUrl: user.avatar_url ?? null,
    tokenEncrypted: encrypted,
    scope: data.scope ?? SCOPES,
  });

  return {
    status: 'authorized',
    account: toPublicAccount(record),
  };
}

// ---------------------------------------------------------------------------
// Conta conectada
// ---------------------------------------------------------------------------

export interface PublicGithubAccount {
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  scope: string;
  connectedAt: string;
}

function toPublicAccount(row: ReturnType<GithubAccountRepository['get']>): PublicGithubAccount {
  if (!row) throw new Error('Conta GitHub não encontrada');
  return {
    login: row.login,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    scope: row.scope,
    connectedAt: row.createdAt,
  };
}

export function getConnectedAccount(): PublicGithubAccount | null {
  const row = repo.get();
  return row ? toPublicAccount(row) : null;
}

export function listConnectedAccounts(): PublicGithubAccount[] {
  return repo.list().map(toPublicAccount);
}

export function disconnectAccount(login?: string | null): void {
  repo.delete(login);
}

/**
 * Retorna o token em claro pra uso interno (chamadas GitHub API, git clone).
 * Lança se não tem conta conectada ou se o token não decifra.
 */
export function getDecryptedToken(accountLogin?: string | null): string {
  const row = repo.get(accountLogin);
  if (!row) throw new Error('Nenhuma conta GitHub conectada');
  return decryptToken(row.tokenEncrypted);
}

// ---------------------------------------------------------------------------
// API REST helpers
// ---------------------------------------------------------------------------

interface RawUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

async function fetchAuthenticatedUser(token: string): Promise<RawUser> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    throw new Error(`GET /user falhou (HTTP ${res.status})`);
  }
  return (await res.json()) as RawUser;
}

export interface GithubRepoSummary {
  fullName: string;
  name: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
  htmlUrl: string;
  cloneUrl: string;
  updatedAt: string | null;
  pushedAt: string | null;
}

interface RawRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string | null;
  private: boolean;
  description: string | null;
  html_url: string;
  clone_url: string;
  updated_at: string | null;
  pushed_at: string | null;
}

/** Branch default do repo (base natural de um PR — ex.: "main"/"dev"). */
export async function fetchRepoDefaultBranch(ownerRepo: string): Promise<string> {
  const token = getDecryptedToken();
  const res = await fetch(`https://api.github.com/repos/${ownerRepo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`GET /repos/${ownerRepo} falhou (HTTP ${res.status})`);
  const data = (await res.json()) as { default_branch?: string };
  return data.default_branch || 'main';
}

/**
 * Lê o diff de um PR em formato unified. Usado pelo code review.
 */
export async function fetchPullRequestDiff(ownerRepo: string, prNumber: number): Promise<string> {
  const token = getDecryptedToken();
  const res = await fetch(`https://api.github.com/repos/${ownerRepo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3.diff',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(decodeGithubError(res.status, raw, 'fetch diff'));
  }
  return await res.text();
}

/** Detalhes do PR (head sha, base, etc) — necessário pra postar review inline. */
export async function fetchPullRequest(
  ownerRepo: string,
  prNumber: number,
): Promise<{
  number: number;
  title: string;
  author: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  htmlUrl: string;
}> {
  const token = getDecryptedToken();
  const res = await fetch(`https://api.github.com/repos/${ownerRepo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(decodeGithubError(res.status, raw, 'fetch PR'));
  }
  const data = (await res.json()) as {
    number: number;
    title: string;
    user: { login: string } | null;
    head: { ref: string; sha: string };
    base: { ref: string };
    html_url: string;
  };
  return {
    number: data.number,
    title: data.title,
    author: data.user?.login ?? null,
    headRef: data.head.ref,
    baseRef: data.base.ref,
    headSha: data.head.sha,
    htmlUrl: data.html_url,
  };
}

export interface PostReviewCommentInput {
  path: string;
  line: number;
  body: string;
  side?: 'LEFT' | 'RIGHT';
}

/**
 * Posta um review com múltiplos comments inline. Cria 1 review do GitHub
 * que agrupa todos os comments e tem um summary no topo.
 */
export async function postReview(input: {
  ownerRepo: string;
  prNumber: number;
  commitSha: string;
  body: string;
  event?: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  comments: PostReviewCommentInput[];
}): Promise<{ id: string }> {
  const token = getDecryptedToken();
  const res = await fetch(
    `https://api.github.com/repos/${input.ownerRepo}/pulls/${input.prNumber}/reviews`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        commit_id: input.commitSha,
        body: input.body,
        event: input.event ?? 'COMMENT',
        comments: input.comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side ?? 'RIGHT',
          body: c.body,
        })),
      }),
    },
  );
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(decodeGithubError(res.status, raw, 'post review'));
  }
  const data = (await res.json()) as { id: number };
  return { id: String(data.id) };
}

/**
 * Cria um Pull Request no GitHub. `head` é a branch com as mudanças,
 * `base` é onde vai mergear (geralmente "main"). Retorna o PR criado.
 */
export async function createPullRequest(input: {
  ownerRepo: string;
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}): Promise<{ number: number; htmlUrl: string }> {
  const token = getDecryptedToken();
  const res = await fetch(`https://api.github.com/repos/${input.ownerRepo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body ?? '',
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    }),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(decodeGithubError(res.status, raw, 'create PR'));
  }
  const data = (await res.json()) as { number: number; html_url: string };
  return { number: data.number, htmlUrl: data.html_url };
}

export interface GithubPullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  author: string;
  authorAvatarUrl: string | null;
  headRef: string;
  baseRef: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
}

interface RawPR {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: string | null;
  user: { login: string; avatar_url: string } | null;
  head: { ref: string };
  base: { ref: string };
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
  labels: Array<{ name: string }>;
  // Esses só vêm no detail endpoint
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

/**
 * Lista PRs abertos + recentes fechados do repo passado.
 * Não busca detalhes (additions/deletions) — só o resumo da lista.
 */
function mapRawPr(pr: RawPR): GithubPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    merged: !!pr.merged_at,
    author: pr.user?.login ?? 'desconhecido',
    authorAvatarUrl: pr.user?.avatar_url ?? null,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    htmlUrl: pr.html_url,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    comments: pr.comments,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    labels: pr.labels?.map((l) => l.name).filter(Boolean) ?? [],
  };
}

/**
 * Lista PRs do repo. Pagina automaticamente até esgotar (limite de
 * segurança: 10 páginas = 1000 PRs). Usado onde precisamos do conjunto completo
 * (ex.: picker de PR pra vincular). A LISTAGEM principal usa listPullRequestsPage
 * (paginada sob demanda) pra não buscar tudo upfront.
 */
export async function listPullRequests(ownerRepo: string): Promise<GithubPullRequest[]> {
  const results: GithubPullRequest[] = [];
  const MAX_PAGES = 10;
  const PER_PAGE = 100;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { prs, hasMore } = await listPullRequestsPage(ownerRepo, {
      state: 'all',
      page,
      perPage: PER_PAGE,
    });
    results.push(...prs);
    if (!hasMore) break;
  }
  return results;
}

/**
 * Lista UMA página de PRs do repo (infinite scroll). Ordena por updated desc.
 * hasMore = a página veio cheia (provavelmente há mais). Não pagina sozinho —
 * o caller pede a próxima página sob demanda.
 */
export async function listPullRequestsPage(
  ownerRepo: string,
  opts: { state: 'open' | 'closed' | 'all'; page: number; perPage?: number },
): Promise<{ prs: GithubPullRequest[]; hasMore: boolean }> {
  const token = getDecryptedToken();
  const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));
  const page = Math.max(1, opts.page);
  const url =
    `https://api.github.com/repos/${ownerRepo}/pulls?state=${opts.state}&per_page=${perPage}` +
    `&sort=updated&direction=desc&page=${page}`;
  const res = await fetchGithub(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(decodeGithubError(res.status, raw, 'list PRs'));
  }
  const data = (await res.json()) as RawPR[];
  return { prs: data.map(mapRawPr), hasMore: data.length >= perPage };
}

export async function listUserRepos(accountLogin?: string | null): Promise<GithubRepoSummary[]> {
  const token = getDecryptedToken(accountLogin);
  const results: GithubRepoSummary[] = [];
  let page = 1;
  // Máx 5 páginas (500 repos) — suficiente pra esmagadora maioria dos usuários.
  while (page <= 5) {
    const url =
      `https://api.github.com/user/repos?per_page=100&sort=pushed&page=${page}` +
      `&affiliation=owner,collaborator,organization_member`;
    const res = await fetchGithub(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
    });
    if (!res.ok) {
      throw new Error(`GET /user/repos falhou (HTTP ${res.status})`);
    }
    const data = (await res.json()) as RawRepo[];
    for (const r of data) {
      results.push({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        defaultBranch: r.default_branch ?? 'main',
        private: r.private,
        description: r.description,
        htmlUrl: r.html_url,
        cloneUrl: r.clone_url,
        updatedAt: r.updated_at,
        pushedAt: r.pushed_at,
      });
    }
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export interface CloneResult {
  path: string;
  branch: string;
}

/**
 * Clona um repo GitHub usando o token armazenado. Injeta o token na URL
 * `https://oauth2:<token>@github.com/owner/repo.git`. Cria o diretório
 * pai se não existir.
 *
 * Roda `git clone --depth 1` por padrão pra ser rápido — o usuário pode
 * fazer fetch full depois se quiser histórico.
 */
export function cloneRepo(input: {
  ownerRepo: string;
  targetDir: string;
  branch?: string;
  depth?: number;
  accountLogin?: string | null;
  onProgress?: (line: string) => void;
}): Promise<CloneResult> {
  return new Promise((resolve, reject) => {
    const token = getDecryptedToken(input.accountLogin);
    // URL SEM credencial — o token NÃO pode acabar persistido em claro no
    // `.git/config` do clone. Passamos o `http.extraHeader` via os env vars
    // `GIT_CONFIG_*` (não via `-c ...` no argv): assim o token fica fora da
    // lista de argumentos do processo (visível por `ps`/`/proc` a outros
    // usuários da máquina) e não é gravado no config do repo. O git usa Basic
    // auth com `x-access-token:<token>` (formato do GitHub).
    const url = `https://github.com/${input.ownerRepo}.git`;
    const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const targetParent = dirname(input.targetDir);
    if (!existsSync(targetParent)) mkdirSync(targetParent, { recursive: true });

    const args = ['clone', '--progress'];
    if (input.depth && input.depth > 0) {
      args.push('--depth', String(input.depth));
    }
    if (input.branch) {
      args.push('--branch', input.branch);
    }
    args.push(url, input.targetDir);

    const child = spawn('git', args, {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // nunca pedir senha interativa
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: authHeader,
      },
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // git clone manda progresso pra stderr. Repassa pro caller.
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) input.onProgress?.(line.trim());
      }
    });

    child.on('error', (err) => {
      reject(new Error(`git clone falhou: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ path: input.targetDir, branch: input.branch ?? 'default' });
      } else {
        // Limpa qualquer credencial da mensagem de erro antes de propagar.
        const sanitized = stderr
          .replace(/oauth2:[^@]+@/g, 'oauth2:***@')
          .replace(/Authorization: Basic [A-Za-z0-9+/=]+/g, 'Authorization: Basic ***');
        reject(new Error(`git clone falhou (exit ${code}): ${sanitized.slice(-500)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Secret helpers (host.secrets: safeStorage quando disponível, senão fallback
// crypto — VPS sem keychain funciona; decryptCompat cobre blobs legados)
// ---------------------------------------------------------------------------

function encryptToken(plain: string): Buffer {
  return secrets.encrypt(plain);
}

function decryptToken(buf: Buffer): string {
  return secrets.decryptCompat(buf);
}

// ---------------------------------------------------------------------------
// Open browser helper (usado pelo handler de device flow)
// ---------------------------------------------------------------------------

export function openInBrowser(url: string): void {
  void openExternalSafe(url);
}

export function openOAuthAccessSettings(): void {
  openInBrowser(oauthApplicationSettingsUrl());
}
