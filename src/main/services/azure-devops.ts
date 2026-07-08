import { secrets } from '../platform/host';
import { azureDevopsAccountRepo } from '../db/repositories/azure-devops.repo';
import { openExternalSafe } from '../utils/safe-shell';
import type {
  AzureDevopsAccount,
  AzureDevopsDeviceCode,
  AzureDevopsDeviceFlowStatus,
  AzureDevopsRepoSummary,
} from '../../shared/types';

const TENANT = process.env.ORKESTRAL_AZURE_TENANT_ID || 'common';
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const SCOPES = `${AZURE_DEVOPS_RESOURCE}/user_impersonation offline_access`;
const USER_AGENT = 'Orkestral/0.1 (Electron Desktop)';
const DEFAULT_CLIENT_ID = 'ad5bfc00-c17c-4f09-a296-dce587eae0a7';

function getClientId(): string {
  return process.env.ORKESTRAL_AZURE_DEVOPS_CLIENT_ID || DEFAULT_CLIENT_ID;
}

const MAX_RATE_LIMIT_RETRIES = 2;

function nowPlusSeconds(seconds: number): string {
  return new Date(Date.now() + Math.max(30, seconds - 60) * 1000).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch que respeita o throttle do Azure DevOps (429 com Retry-After). Sem isso,
 * a listagem de repos silenciava o throttle no `continue` e devolvia lista
 * parcial sem aviso. Teto de 30s por espera pra não pendurar a UI.
 */
async function fetchAzure(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 1000,
    );
  }
  return fetch(url, init); // inalcançável: o loop sempre retorna na última tentativa
}

function encodeBody(params: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) body.set(key, value);
  return body;
}

// Cifra via host.secrets: safeStorage quando disponível, senão fallback crypto
// (VPS sem keychain). decryptCompat cobre blobs safeStorage legados.
function encryptToken(plain: string): Buffer {
  return secrets.encrypt(plain);
}

function decryptToken(buf: Buffer): string {
  return secrets.decryptCompat(buf);
}

function toPublicAccount(row: ReturnType<typeof azureDevopsAccountRepo.get>): AzureDevopsAccount {
  if (!row) throw new Error('Conta Azure DevOps não encontrada');
  return {
    displayName: row.displayName,
    email: row.email,
    tenantId: row.tenantId,
    scope: row.scope,
    connectedAt: row.createdAt,
    expiresAt: row.expiresAt,
    organizations: row.organizations ?? [],
  };
}

interface RawDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  message?: string;
  expires_in: number;
  interval: number;
}

export async function startAzureDevopsDeviceFlow(): Promise<AzureDevopsDeviceCode> {
  const res = await fetch(`${AUTH_BASE}/devicecode`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: encodeBody({
      client_id: getClientId(),
      scope: SCOPES,
    }),
  });
  const data = (await res.json().catch(() => null)) as
    | (RawDeviceCode & {
        error?: string;
        error_description?: string;
      })
    | null;
  if (!res.ok || !data || data.error) {
    throw new Error(
      data?.error_description || data?.error || `Azure device code falhou (HTTP ${res.status})`,
    );
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri_complete || data.verification_uri,
    message: data.message ?? '',
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  const [, payload] = token.split('.');
  if (!payload) return {};
  try {
    return JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function pollAzureDevopsDeviceFlow(
  deviceCode: string,
): Promise<AzureDevopsDeviceFlowStatus> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: encodeBody({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: getClientId(),
      device_code: deviceCode,
    }),
  });
  const data = (await res.json().catch(() => null)) as RawTokenResponse | null;
  if (!data) throw new Error(`Azure token poll falhou (HTTP ${res.status})`);
  if (data.error) {
    if (data.error === 'authorization_pending') return { status: 'pending' };
    if (data.error === 'slow_down') return { status: 'slow_down', interval: data.interval ?? 5 };
    if (data.error === 'expired_token') return { status: 'expired' };
    if (data.error === 'authorization_declined' || data.error === 'access_denied')
      return { status: 'denied' };
    throw new Error(data.error_description || data.error);
  }
  if (!data.access_token) return { status: 'pending' };

  const claims = decodeJwtPayload(data.id_token);
  const organizations = await listAzureDevopsOrganizations(data.access_token).catch(() => []);
  const row = azureDevopsAccountRepo.upsert({
    displayName: (claims.name as string | undefined) ?? null,
    email:
      (claims.preferred_username as string | undefined) ??
      (claims.email as string | undefined) ??
      null,
    tenantId: (claims.tid as string | undefined) ?? null,
    accessTokenEncrypted: encryptToken(data.access_token),
    refreshTokenEncrypted: data.refresh_token ? encryptToken(data.refresh_token) : null,
    scope: data.scope ?? SCOPES,
    expiresAt: nowPlusSeconds(data.expires_in ?? 3600),
    organizations,
  });
  return { status: 'authorized', account: toPublicAccount(row) };
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: encodeBody({
      grant_type: 'refresh_token',
      client_id: getClientId(),
      refresh_token: refreshToken,
      scope: SCOPES,
    }),
  });
  const data = (await res.json().catch(() => null)) as RawTokenResponse | null;
  if (!res.ok || !data?.access_token) {
    throw new Error(
      data?.error_description || data?.error || `Azure refresh falhou (HTTP ${res.status})`,
    );
  }
  const row = azureDevopsAccountRepo.get();
  azureDevopsAccountRepo.upsert({
    displayName: row?.displayName ?? null,
    email: row?.email ?? null,
    tenantId: row?.tenantId ?? null,
    accessTokenEncrypted: encryptToken(data.access_token),
    refreshTokenEncrypted: data.refresh_token ? encryptToken(data.refresh_token) : null,
    scope: data.scope ?? row?.scope ?? SCOPES,
    expiresAt: nowPlusSeconds(data.expires_in ?? 3600),
    organizations: row?.organizations ?? [],
  });
  return data.access_token;
}

export function getAzureDevopsAccount(): AzureDevopsAccount | null {
  const row = azureDevopsAccountRepo.get();
  return row ? toPublicAccount(row) : null;
}

export function disconnectAzureDevops(): void {
  azureDevopsAccountRepo.delete();
}

export async function getAzureDevopsAccessToken(): Promise<string> {
  const row = azureDevopsAccountRepo.get();
  if (!row) throw new Error('Nenhuma conta Azure DevOps conectada');
  if (Date.parse(row.expiresAt) > Date.now() + 90_000) {
    return decryptToken(row.accessTokenEncrypted as Buffer);
  }
  if (!row.refreshTokenEncrypted) {
    throw new Error('Sessão Azure DevOps expirada. Conecte novamente.');
  }
  return refreshAccessToken(decryptToken(row.refreshTokenEncrypted as Buffer));
}

interface RawProfile {
  id?: string;
  displayName?: string;
  emailAddress?: string;
}

async function fetchProfile(accessToken: string): Promise<RawProfile> {
  const res = await fetch(
    'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1',
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    },
  );
  if (!res.ok) throw new Error(`Azure profile falhou (HTTP ${res.status})`);
  return (await res.json()) as RawProfile;
}

async function listAzureDevopsOrganizations(accessToken: string): Promise<string[]> {
  const profile = await fetchProfile(accessToken);
  if (!profile.id) return [];
  const res = await fetch(
    `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${encodeURIComponent(profile.id)}&api-version=7.1`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { value?: Array<{ accountName?: string }> };
  return (data.value ?? []).map((a) => a.accountName).filter((x): x is string => !!x);
}

interface RawProject {
  id: string;
  name: string;
}

interface RawRepo {
  id: string;
  name: string;
  defaultBranch?: string;
  remoteUrl?: string;
  webUrl?: string;
  sshUrl?: string;
  size?: number;
  project?: { id?: string; name?: string };
}

export async function listAzureDevopsRepos(
  organization?: string,
): Promise<AzureDevopsRepoSummary[]> {
  const token = await getAzureDevopsAccessToken();
  const organizations = organization
    ? [organization]
    : (azureDevopsAccountRepo.get()?.organizations ?? []);
  const orgs = organizations.length > 0 ? organizations : await listAzureDevopsOrganizations(token);
  if (orgs.length > 0) azureDevopsAccountRepo.updateOrganizations(orgs);
  const repos: AzureDevopsRepoSummary[] = [];

  for (const org of orgs) {
    const projectsRes = await fetchAzure(
      `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects?api-version=7.1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
      },
    );
    // 401 = token expirado/revogado: erro real, não "org sem repos". Avisa em vez
    // de devolver lista parcial silenciosa.
    if (projectsRes.status === 401) {
      throw new Error('Sessão Azure DevOps expirada ou sem permissão. Conecte novamente.');
    }
    if (!projectsRes.ok) continue;
    const projects = ((await projectsRes.json()) as { value?: RawProject[] }).value ?? [];
    for (const project of projects) {
      const reposRes = await fetchAzure(
        `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project.name)}/_apis/git/repositories?api-version=7.1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
        },
      );
      if (!reposRes.ok) continue;
      const rawRepos = ((await reposRes.json()) as { value?: RawRepo[] }).value ?? [];
      for (const repo of rawRepos) {
        const remoteUrl = repo.remoteUrl ?? '';
        if (!remoteUrl) continue;
        repos.push({
          id: repo.id,
          organization: org,
          projectId: repo.project?.id ?? project.id,
          projectName: repo.project?.name ?? project.name,
          name: repo.name,
          fullName: `${org}/${project.name}/${repo.name}`,
          defaultBranch: repo.defaultBranch ?? null,
          remoteUrl,
          webUrl: repo.webUrl ?? null,
          sshUrl: repo.sshUrl ?? null,
          size: repo.size ?? null,
        });
      }
    }
  }
  return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export function openAzureDevopsVerification(url: string): void {
  void openExternalSafe(url);
}
