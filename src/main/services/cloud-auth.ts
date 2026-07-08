import { app, BrowserWindow } from '../platform/electron';
import { broadcast } from '../platform/host';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { openExternalSafe } from '../utils/safe-shell';
import { CloudAccountRepository } from '../db/repositories/cloud-account.repo';
import { UserRepository } from '../db/repositories/user.repo';

/**
 * Ponte de autenticação com o Orkestral Cloud (web).
 *
 * Fluxo (estilo OAuth de app nativo, RFC 8252):
 *   1. Renderer chama `cloud:login-start` → subimos um listener HTTP em
 *      127.0.0.1 (loopback) e abrimos `<cloud>/login?next=desktop` no navegador.
 *   2. O usuário loga/cadastra no web; a página /auth/desktop entrega os tokens
 *      PRIMEIRO no loopback (funciona igual em dev e prod) e, se o listener não
 *      responder, cai pro deep link `orkestral://auth?…` (app empacotado).
 *   3. Aqui decodificamos o JWT pra extrair o usuário, guardamos os tokens
 *      cifrados (host.secrets) e avisamos o renderer via `cloud:auth-changed`.
 *
 * Os tokens NUNCA são enviados pro renderer — só email/nome. A sincronização
 * de dados do plano Team (que usa esses tokens) vive em branch protegida.
 *
 * Por que loopback primeiro? No macOS em DEV o setAsDefaultProtocolClient
 * registraria o Electron.app genérico do node_modules no LaunchServices — o
 * deep link abriria um Electron pelado em vez do app rodando. O loopback não
 * depende de registro nenhum.
 */

const PROTOCOL = 'orkestral';

/** Porta fixa do callback de login (loopback). Compartilhada com o web. */
const CLOUD_AUTH_PORT = Number(process.env.ORKESTRAL_AUTH_PORT ?? 38427);

/** Tempo máximo com o listener de login aberto aguardando o navegador. */
const LOGIN_SERVER_TTL_MS = 5 * 60 * 1000;

// URL do Orkestral Cloud. Em dev aponta pro Next local; em prod o domínio
// definitivo é orkestral.pro (sobrescrevível por env ORKESTRAL_CLOUD_URL).
// Node puro (CLI via npm -g, sem `app`) conta como PROD: instalação de usuário
// final, não checkout de dev — só NODE_ENV/env explícitos apontam pro local.
const CLOUD_URL =
  process.env.ORKESTRAL_CLOUD_URL ??
  (process.env.NODE_ENV === 'development' || (app ? !app.isPackaged : false)
    ? 'http://localhost:3000'
    : 'https://orkestral.pro');

// URL base do projeto Supabase, usada para verificar a ASSINATURA do access
// token (JWKS) e os claims iss/aud. Vem SEMPRE de env, SEM default de projeto
// real: o repo é open-source e não pode embutir infra. O build oficial injeta
// ORKESTRAL_SUPABASE_URL; um fork sem essa env tem o login Cloud desabilitado
// (degrada, não quebra). Mesmo padrão do web (NEXT_PUBLIC_SUPABASE_URL).
const SUPABASE_URL = (process.env.ORKESTRAL_SUPABASE_URL ?? '').replace(/\/+$/, '');

/** True quando o Cloud (Supabase) está configurado neste build. */
export const isCloudConfigured = Boolean(SUPABASE_URL);

/** Issuer e audience que todo access token legítimo do Supabase Auth carrega. */
const SUPABASE_ISSUER = SUPABASE_URL ? `${SUPABASE_URL}/auth/v1` : '';
const SUPABASE_AUDIENCE = 'authenticated';

/** JWKS remoto do Supabase (chaves assimétricas). Lazy: só é criado quando há
 *  URL configurada — `new URL` com base vazia lançaria no load do módulo. */
let supabaseJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getSupabaseJwks(): ReturnType<typeof createRemoteJWKSet> | null {
  if (!SUPABASE_URL) return null;
  if (!supabaseJwks) {
    supabaseJwks = createRemoteJWKSet(new URL(`${SUPABASE_ISSUER}/.well-known/jwks.json`));
  }
  return supabaseJwks;
}

export function getCloudLoginUrl(state?: string): string {
  const url = new URL(`${CLOUD_URL}/login`);
  url.searchParams.set('next', 'desktop');
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/** Registra o app como handler do protocolo orkestral:// (deep link).
 *  No macOS em dev NÃO registra: apontaria o esquema pro Electron.app genérico
 *  do node_modules (LaunchServices abriria um Electron vazio). Em dev o login
 *  chega pelo loopback; o deep link é caminho do app empacotado. */
export function registerCloudProtocol(): void {
  // Deep link é caminho do app desktop; em Node puro o login chega SÓ pelo loopback.
  if (!app) return;
  if (process.platform === 'darwin' && !app.isPackaged) return;
  if (process.defaultApp && process.argv.length >= 2) {
    // Dev no Win/Linux: o binário é o electron + caminho do projeto nos args.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/** Payload mínimo que precisamos do access token (JWT) do Supabase. */
interface SupabaseJwtPayload {
  sub?: string;
  email?: string;
  user_metadata?: { full_name?: string; name?: string };
}

/**
 * Verifica a ASSINATURA do access token contra o JWKS do Supabase e valida
 * iss/aud/exp antes de confiar em qualquer claim. Sem isso um token forjado
 * (base64 puro) seria aceito. Retorna o payload só quando o token é legítimo.
 */
async function verifyAccessToken(token: string): Promise<SupabaseJwtPayload | null> {
  const jwks = getSupabaseJwks();
  if (!jwks) {
    console.warn(
      '[cloud-auth] Cloud não configurado (ORKESTRAL_SUPABASE_URL ausente) — login recusado.',
    );
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: SUPABASE_ISSUER,
      audience: SUPABASE_AUDIENCE,
    });
    return payload as SupabaseJwtPayload;
  } catch (err) {
    console.warn(
      '[cloud-auth] access token rejeitado na verificação de assinatura/claims:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function broadcastAuthChanged(account: { email: string; name: string | null } | null): void {
  broadcast('cloud:auth-changed', { account });
}

/** Avisa o renderer que o callback de login chegou mas não casou com um fluxo
 *  ativo (nonce perdido — app reiniciado no meio, ou link de outra sessão). O
 *  renderer mostra "clique em Entrar de novo" em vez de o login sumir em silêncio. */
function broadcastAuthError(reason: 'no-pending-state'): void {
  broadcast('cloud:auth-error', { reason });
}

function focusMainWindow(): void {
  // Best-effort; em Node puro não há janela pra focar (o feedback fica no navegador).
  const win = BrowserWindow?.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    app?.focus({ steal: true });
  }
}

/** Valida (assinatura + claims) + persiste os tokens do web. true se logou. */
async function completeCloudLogin(accessToken: string, refreshToken: string): Promise<boolean> {
  const payload = await verifyAccessToken(accessToken);
  if (!payload?.sub || !payload.email) {
    console.warn('[cloud-auth] access token inválido (assinatura/claims) — ignorado');
    return false;
  }

  const name = payload.user_metadata?.full_name ?? payload.user_metadata?.name ?? null;
  new CloudAccountRepository().save({
    userId: payload.sub,
    email: payload.email,
    name,
    accessToken,
    refreshToken,
  });
  // Sincroniza o PERFIL LOCAL do app com a conta web logada: traz email (sempre)
  // e nome (quando o web tem). Assim a conta criada/cadastrada no Cloud já reflete
  // no app (Configurações → Geral, saudações, prompts) sem o usuário redigitar.
  // name=null é tolerado pelo upsert (`?? existing.name` preserva o atual).
  new UserRepository().upsert({ email: payload.email, name: name ?? undefined });
  console.log(`[cloud-auth] conta Cloud conectada + perfil local sincronizado: ${payload.email}`);

  focusMainWindow();
  broadcastAuthChanged({ email: payload.email, name });
  return true;
}

// ─── CSRF state (nonce do fluxo de login) ───────────────────────────────────

// Nonce gerado quando o usuário clica em "Entrar". Vai na URL /login e tem que
// voltar idêntico no callback (loopback ou deep link), senão o token é recusado
// — bloqueia injeção de token por uma página/processo que não iniciou o fluxo.
let pendingLoginState: string | null = null;

/** true quando o `state` recebido bate com o nonce do fluxo atual. */
function isValidLoginState(state: string | null): boolean {
  return Boolean(pendingLoginState && state === pendingLoginState);
}

// ─── Loopback (caminho primário, dev + prod) ────────────────────────────────

let loginServer: http.Server | null = null;
let loginServerTimer: NodeJS.Timeout | null = null;

function stopCloudLoginServer(): void {
  if (loginServerTimer) {
    clearTimeout(loginServerTimer);
    loginServerTimer = null;
  }
  if (loginServer) {
    loginServer.close();
    loginServer = null;
  }
  // Flow encerrado/expirado: invalida o nonce pra não aceitar callbacks tardios.
  pendingLoginState = null;
}

/** Origens autorizadas a LER a resposta do loopback (CORS). A proteção real do
 *  fluxo é o nonce `state` (CSRF) — o CORS só restringe quem lê o `{ok}`. Aceita a
 *  CLOUD_URL do build, localhost (dev) e os domínios oficiais do Cloud, pra o login
 *  funcionar mesmo quando o web roda num domínio diferente do CLOUD_URL embutido. */
function isAllowedCloudOrigin(origin: string | undefined): origin is string {
  if (!origin) return false;
  if (origin === CLOUD_URL) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1')) {
      return true;
    }
    return protocol === 'https:' && /(^|\.)orkestral\.(pro|ai)$/.test(hostname);
  } catch {
    return false;
  }
}

/** Trata o GET do navegador no loopback (entrega dos tokens do Cloud). */
async function handleLoopbackRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${CLOUD_AUTH_PORT}`);
  // O fetch vem do web do Cloud (https) pra 127.0.0.1. Reflete a origem quando ela
  // é confiável (sem wildcard) e libera o Private Network Access: SEM o header
  // Access-Control-Allow-Private-Network o Chrome BLOQUEIA o preflight de uma página
  // https chamando o loopback, e o token nunca chegava no app rodando (caía no deep
  // link, que depende de prompt do SO). Este é o caminho primário do login.
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', isAllowedCloudOrigin(origin) ? origin : CLOUD_URL);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  // Preflight (OPTIONS) do PNA/CORS: responde só com os headers, sem tocar nos tokens.
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ?? '*',
    );
    res.setHeader('Access-Control-Max-Age', '600');
    res.statusCode = 204;
    res.end();
    return;
  }

  if (url.pathname !== '/auth') {
    res.statusCode = 404;
    res.end();
    return;
  }

  const accessToken = url.searchParams.get('access_token');
  const refreshToken = url.searchParams.get('refresh_token');
  const state = url.searchParams.get('state');

  // CSRF: o callback tem que apresentar o nonce gerado quando o login começou.
  if (!isValidLoginState(state)) {
    console.warn('[cloud-auth] callback de login com state inválido/ausente — ignorado');
    // Sem fluxo ativo (nonce perdido num restart): não some em silêncio — pede
    // pro usuário clicar em Entrar de novo. Nonce errado (mismatch) é tratado
    // como CSRF de fato e não notifica nada.
    if (!pendingLoginState && state) broadcastAuthError('no-pending-state');
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false }));
    return;
  }

  const ok = Boolean(
    accessToken && refreshToken && (await completeCloudLogin(accessToken, refreshToken)),
  );

  res.statusCode = ok ? 200 : 400;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok }));
  if (ok) stopCloudLoginServer();
}

/** Sobe (idempotente) o listener de login em 127.0.0.1:CLOUD_AUTH_PORT. */
function startCloudLoginServer(): void {
  if (loginServer) {
    // Renova o TTL — usuário clicou em "Entrar" de novo.
    if (loginServerTimer) clearTimeout(loginServerTimer);
    loginServerTimer = setTimeout(stopCloudLoginServer, LOGIN_SERVER_TTL_MS);
    return;
  }

  const server = http.createServer((req, res) => {
    void handleLoopbackRequest(req, res);
  });

  server.on('error', (err) => {
    console.warn('[cloud-auth] listener de login falhou (deep link segue como fallback):', err);
    loginServer = null;
  });

  server.listen(CLOUD_AUTH_PORT, '127.0.0.1', () => {
    console.log(`[cloud-auth] aguardando login em http://127.0.0.1:${CLOUD_AUTH_PORT}/auth`);
  });
  loginServer = server;
  loginServerTimer = setTimeout(stopCloudLoginServer, LOGIN_SERVER_TTL_MS);
}

// ─── Deep link (fallback, app empacotado) ───────────────────────────────────

/** Trata um deep link orkestral://… — resolve true se era um link de auth válido. */
export async function handleCloudDeepLink(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== `${PROTOCOL}:`) return false;
  // orkestral://auth?… → host é "auth"
  if (parsed.host !== 'auth' && parsed.pathname !== '//auth') return false;

  const accessToken = parsed.searchParams.get('access_token');
  const refreshToken = parsed.searchParams.get('refresh_token');
  if (!accessToken || !refreshToken) {
    console.warn('[cloud-auth] deep link de auth sem tokens — ignorado');
    return false;
  }
  // CSRF: o deep link também tem que trazer o nonce do fluxo atual.
  const state = parsed.searchParams.get('state');
  if (!isValidLoginState(state)) {
    console.warn('[cloud-auth] deep link de auth com state inválido/ausente — ignorado');
    // O deep link pode ABRIR o app do zero — aí o nonce (em memória) se perdeu.
    // Em vez de o login sumir, avisa o renderer pra pedir "Entrar de novo".
    if (!pendingLoginState && state) broadcastAuthError('no-pending-state');
    return false;
  }
  const ok = await completeCloudLogin(accessToken, refreshToken);
  if (ok) pendingLoginState = null;
  return ok;
}

/** Procura um deep link orkestral:// numa lista de argv (Win/Linux). */
export function findDeepLinkInArgv(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`)) ?? null;
}

/** Abre o login do Cloud no navegador, com o loopback aguardando o retorno.
 *  Se o build não tem Cloud configurado (sem ORKESTRAL_SUPABASE_URL) o callback
 *  sempre seria recusado na verificação do JWKS — então nem abre o navegador e
 *  retorna `null`, pro renderer mostrar "login indisponível" em vez de travar. */
export function openCloudLogin(): string | null {
  if (!isCloudConfigured) {
    console.warn('[cloud-auth] login solicitado mas Cloud não configurado neste build — ignorado');
    return null;
  }
  // Nonce anti-CSRF deste fluxo: vai na URL /login e tem que voltar no callback.
  pendingLoginState = randomUUID();
  startCloudLoginServer();
  const url = getCloudLoginUrl(pendingLoginState);
  void openExternalSafe(url);
  return url;
}

export function logoutCloud(): void {
  new CloudAccountRepository().clear();
  broadcastAuthChanged(null);
}
