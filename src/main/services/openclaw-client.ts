/**
 * Cliente WebSocket do gateway OpenClaw — execução REAL.
 *
 * Espelha o protocolo de frames do paperclip
 * (packages/adapters/openclaw-gateway/src/server/execute.ts):
 *   - handshake `connect` (PROTOCOL_VERSION 3) com challenge/nonce + device auth ED25519
 *   - frames `{ type: 'req'|'res'|'event', id, method, params, payload }`
 *   - método `agent` (envia o prompt + sessionKey) e `agent.wait` (aguarda o run)
 *   - streaming de eventos `agent` (stream=assistant|error|lifecycle) → onLog
 *   - resolução do texto final a partir dos chunks do stream ou do payload
 *
 * Diferença vs paperclip: usamos o `WebSocket` global embutido do Node 22+
 * (WHATWG/browser-style) em vez do pacote `ws` (que NÃO é dependência deste
 * app). O WebSocket embutido NÃO suporta headers HTTP customizados no
 * construtor, então a autenticação por token é enviada no frame `connect`
 * (auth.token) — que é o mecanismo primário do gateway. Auth puramente por
 * header (x-openclaw-token) não é suportada por esta implementação; nesse caso
 * configure `authToken` no adapterConfig.
 */
import crypto, { randomUUID } from 'node:crypto';

const PROTOCOL_VERSION = 3;
const DEFAULT_SCOPES = ['operator.admin'];
const DEFAULT_CLIENT_ID = 'gateway-client';
const DEFAULT_CLIENT_MODE = 'backend';
const DEFAULT_CLIENT_VERSION = 'orkestral';
const DEFAULT_ROLE = 'operator';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type OpenClawSessionKeyStrategy = 'fixed' | 'issue' | 'run';

export interface OpenClawRunOptions {
  /** ws:// ou wss:// do gateway. */
  url: string;
  /** Token de autenticação (enviado em connect.auth.token). */
  authToken?: string | null;
  password?: string | null;
  clientId?: string | null;
  clientMode?: string | null;
  clientVersion?: string | null;
  role?: string | null;
  /** Lista de scopes (default operator.admin). */
  scopes?: string[] | null;
  sessionKeyStrategy?: OpenClawSessionKeyStrategy;
  /** sessionKey fixa (usada na estratégia 'fixed' / fallback). */
  sessionKey?: string | null;
  /** agentId opcional p/ prefixar a sessionKey e enviar no payload. */
  agentId?: string | null;
  /** runId estável (idempotencyKey). */
  runId: string;
  /** issueId p/ estratégia de sessionKey 'issue'. */
  issueId?: string | null;
  /** Prompt/mensagem enviada ao agente remoto. */
  prompt: string;
  /** Timeout total do run em ms. 0 = sem limite. */
  timeoutMs?: number;
  /** Desabilita device-auth ED25519 (default: habilitado). */
  disableDeviceAuth?: boolean;
  /** PEM da chave privada ED25519 persistida (reuso de pareamento). */
  devicePrivateKeyPem?: string | null;
  /** Callback de log/stream (stdout|stderr). */
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface OpenClawRunResult {
  ok: boolean;
  summary: string | null;
  errorMessage?: string;
  errorCode?: string;
  timedOut?: boolean;
  resultJson?: unknown;
}

type GatewayResponseError = Error & {
  gatewayCode?: string;
  gatewayDetails?: Record<string, unknown>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function normalizeScopes(scopes: string[] | null | undefined): string[] {
  if (Array.isArray(scopes)) {
    const out = scopes.map((s) => s.trim()).filter(Boolean);
    if (out.length > 0) return out;
  }
  return [...DEFAULT_SCOPES];
}

function prefixSessionKeyForAgent(sessionKey: string, agentId: string | null): string {
  if (!agentId || sessionKey.startsWith('agent:')) return sessionKey;
  return `agent:${agentId}:${sessionKey}`;
}

export function resolveSessionKey(input: {
  strategy: OpenClawSessionKeyStrategy;
  configuredSessionKey: string | null;
  agentId: string | null;
  runId: string;
  issueId: string | null;
}): string {
  const fallback = input.configuredSessionKey ?? 'orkestral';
  if (input.strategy === 'run') {
    return prefixSessionKeyForAgent(`orkestral:run:${input.runId}`, input.agentId);
  }
  if (input.strategy === 'issue' && input.issueId) {
    return prefixSessionKeyForAgent(`orkestral:issue:${input.issueId}`, input.agentId);
  }
  return prefixSessionKeyForAgent(fallback, input.agentId);
}

function rawDataToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data ?? '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(sig);
}

type DeviceIdentity = {
  deviceId: string;
  publicKeyRawBase64Url: string;
  privateKeyPem: string;
  source: 'configured' | 'ephemeral';
};

function resolveDeviceIdentity(devicePrivateKeyPem: string | null | undefined): DeviceIdentity {
  if (nonEmpty(devicePrivateKeyPem)) {
    const privateKey = crypto.createPrivateKey(devicePrivateKeyPem as string);
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const raw = derivePublicKeyRaw(publicKeyPem);
    return {
      deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
      publicKeyRawBase64Url: base64UrlEncode(raw),
      privateKeyPem: devicePrivateKeyPem as string,
      source: 'configured',
    };
  }
  const generated = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = generated.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const raw = derivePublicKeyRaw(publicKeyPem);
  return {
    deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
    publicKeyRawBase64Url: base64UrlEncode(raw),
    privateKeyPem,
    source: 'ephemeral',
  };
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
}): string {
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
    params.nonce,
    params.platform?.trim() ?? '',
    '',
  ].join('|');
}

function extractResultText(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((entry) => nonEmpty(asRecord(entry)?.text))
    .filter((entry): entry is string => Boolean(entry));
  if (texts.length > 0) return texts.join('\n\n');
  return nonEmpty(record.text) ?? nonEmpty(record.summary) ?? null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/** Cliente WS de baixo nível (frame-RPC) sobre o WebSocket global do Node. */
class GatewayWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private challengePromise: Promise<string>;
  private resolveChallenge!: (nonce: string) => void;
  private rejectChallenge!: (err: Error) => void;

  constructor(
    private readonly url: string,
    private readonly onEvent: (event: string, payload: unknown) => void,
    private readonly onLog?: OpenClawRunOptions['onLog'],
  ) {
    this.challengePromise = new Promise<string>((resolve, reject) => {
      this.resolveChallenge = resolve;
      this.rejectChallenge = reject;
    });
    this.challengePromise.catch(() => {});
  }

  async connect(
    buildConnectParams: (nonce: string) => Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('message', (ev) => {
      this.handleMessage(rawDataToString((ev as MessageEvent).data));
    });
    ws.addEventListener('close', (ev) => {
      const ce = ev as CloseEvent;
      const err = new Error(`gateway closed (${ce.code}): ${ce.reason ?? ''}`);
      this.failPending(err);
      this.rejectChallenge(err);
    });
    ws.addEventListener('error', () => {
      this.onLog?.('stderr', '[openclaw-gateway] websocket error\n');
    });

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          cleanup();
          resolve();
        };
        const onErr = (): void => {
          cleanup();
          reject(new Error('gateway websocket connection error'));
        };
        const onClose = (ev: Event): void => {
          cleanup();
          const ce = ev as CloseEvent;
          reject(new Error(`gateway closed before open (${ce.code}): ${ce.reason ?? ''}`));
        };
        const cleanup = (): void => {
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('error', onErr);
          ws.removeEventListener('close', onClose);
        };
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onErr);
        ws.addEventListener('close', onClose);
      }),
      timeoutMs,
      'gateway websocket open timeout',
    );

    const nonce = await withTimeout(
      this.challengePromise,
      timeoutMs,
      'gateway connect challenge timeout',
    );
    const params = buildConnectParams(nonce);
    return this.request<Record<string, unknown> | null>('connect', params, timeoutMs);
  }

  async request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('gateway not connected');
    }
    const id = randomUUID();
    const payload = JSON.stringify({ type: 'req', id, method, params });
    const promise = new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`gateway request timeout (${method})`));
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    this.ws.send(payload);
    return promise;
  }

  close(): void {
    if (!this.ws) return;
    try {
      this.ws.close(1000, 'orkestral-complete');
    } catch {
      /* noop */
    }
    this.ws = null;
  }

  private failPending(err: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const record = asRecord(parsed);
    if (!record) return;

    if (record.type === 'event' && typeof record.event === 'string') {
      if (record.event === 'connect.challenge') {
        const nonceVal = nonEmpty(asRecord(record.payload)?.nonce);
        if (nonceVal) {
          this.resolveChallenge(nonceVal);
          return;
        }
      }
      try {
        this.onEvent(record.event, record.payload);
      } catch {
        /* keep stream alive */
      }
      return;
    }

    if (record.type !== 'res' || typeof record.id !== 'string') return;
    const pending = this.pending.get(record.id);
    if (!pending) return;

    const payload = asRecord(record.payload);
    const status = nonEmpty(payload?.status)?.toLowerCase();
    // 'accepted' é um ack intermediário do método 'agent' — não resolve ainda.
    if (status === 'accepted' && record.ok === true) {
      // resolve mesmo assim: o chamador decide via status do payload.
    }

    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(record.id);

    if (record.ok === true) {
      pending.resolve(record.payload ?? null);
      return;
    }
    const errorRecord = asRecord(record.error);
    const message =
      nonEmpty(errorRecord?.message) ?? nonEmpty(errorRecord?.code) ?? 'gateway request failed';
    const err = new Error(message) as GatewayResponseError;
    const code = nonEmpty(errorRecord?.code);
    const details = asRecord(errorRecord?.details);
    if (code) err.gatewayCode = code;
    if (details) err.gatewayDetails = details;
    pending.reject(err);
  }
}

/**
 * Executa um run no gateway OpenClaw e retorna o texto final do assistente.
 * Lança erros claros e acionáveis quando a config está incompleta ou o
 * pareamento de device é exigido.
 */
export async function runOpenClawGateway(opts: OpenClawRunOptions): Promise<OpenClawRunResult> {
  const urlValue = nonEmpty(opts.url);
  if (!urlValue) {
    return {
      ok: false,
      summary: null,
      errorMessage: 'OpenClaw Gateway: configure adapterConfig.url (ws:// ou wss://).',
      errorCode: 'openclaw_gateway_url_missing',
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlValue);
  } catch {
    return {
      ok: false,
      summary: null,
      errorMessage: `OpenClaw Gateway: URL inválida: ${urlValue}`,
      errorCode: 'openclaw_gateway_url_invalid',
    };
  }
  if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
    return {
      ok: false,
      summary: null,
      errorMessage: `OpenClaw Gateway: protocolo não suportado: ${parsedUrl.protocol} (use ws:// ou wss://).`,
      errorCode: 'openclaw_gateway_url_protocol',
    };
  }

  const onLog = opts.onLog;
  const timeoutMs = Math.max(0, Math.floor(opts.timeoutMs ?? 120_000));
  const connectTimeoutMs = timeoutMs > 0 ? Math.min(timeoutMs, 15_000) : 10_000;
  const waitTimeoutMs = timeoutMs > 0 ? timeoutMs : 30_000;

  const authToken = nonEmpty(opts.authToken);
  const password = nonEmpty(opts.password);
  const clientId = nonEmpty(opts.clientId) ?? DEFAULT_CLIENT_ID;
  const clientMode = nonEmpty(opts.clientMode) ?? DEFAULT_CLIENT_MODE;
  const clientVersion = nonEmpty(opts.clientVersion) ?? DEFAULT_CLIENT_VERSION;
  const role = nonEmpty(opts.role) ?? DEFAULT_ROLE;
  const scopes = normalizeScopes(opts.scopes);
  const disableDeviceAuth = opts.disableDeviceAuth === true;

  const sessionKey = resolveSessionKey({
    strategy: opts.sessionKeyStrategy ?? 'issue',
    configuredSessionKey: nonEmpty(opts.sessionKey),
    agentId: nonEmpty(opts.agentId),
    runId: opts.runId,
    issueId: nonEmpty(opts.issueId),
  });

  const agentParams: Record<string, unknown> = {
    message: opts.prompt,
    sessionKey,
    idempotencyKey: opts.runId,
    timeout: waitTimeoutMs,
  };
  const configuredAgentId = nonEmpty(opts.agentId);
  if (configuredAgentId) agentParams.agentId = configuredAgentId;

  if (parsedUrl.protocol === 'ws:' && !isLoopbackHost(parsedUrl.hostname)) {
    onLog?.(
      'stdout',
      '[openclaw-gateway] aviso: usando ws:// em host não-loopback; prefira wss:// para gateways remotos\n',
    );
  }

  const trackedRunIds = new Set<string>([opts.runId]);
  const assistantChunks: string[] = [];
  let lifecycleError: string | null = null;
  let latestResultPayload: unknown = null;

  const onEvent = (event: string, payloadRaw: unknown): void => {
    if (event === 'shutdown') {
      onLog?.('stdout', `[openclaw-gateway] shutdown: ${JSON.stringify(payloadRaw ?? {})}\n`);
      return;
    }
    if (event !== 'agent') return;
    const payload = asRecord(payloadRaw);
    if (!payload) return;
    const runId = nonEmpty(payload.runId);
    if (!runId || !trackedRunIds.has(runId)) return;
    const stream = nonEmpty(payload.stream) ?? 'unknown';
    const data = asRecord(payload.data) ?? {};
    if (stream === 'assistant') {
      const delta = nonEmpty(data.delta);
      const text = nonEmpty(data.text);
      if (delta) {
        assistantChunks.push(delta);
        onLog?.('stdout', delta);
      } else if (text) {
        assistantChunks.push(text);
        onLog?.('stdout', text);
      }
      return;
    }
    if (stream === 'error') {
      lifecycleError = nonEmpty(data.error) ?? nonEmpty(data.message) ?? lifecycleError;
      onLog?.('stderr', `[openclaw-gateway] ${lifecycleError ?? 'erro'}\n`);
      return;
    }
    if (stream === 'lifecycle') {
      const phase = nonEmpty(data.phase)?.toLowerCase();
      if (phase === 'error' || phase === 'failed' || phase === 'cancelled') {
        lifecycleError = nonEmpty(data.error) ?? nonEmpty(data.message) ?? lifecycleError;
      }
    }
  };

  const client = new GatewayWsClient(parsedUrl.toString(), onEvent, onLog);

  try {
    const deviceIdentity = disableDeviceAuth
      ? null
      : resolveDeviceIdentity(opts.devicePrivateKeyPem);

    onLog?.('stdout', `[openclaw-gateway] conectando a ${parsedUrl.toString()}\n`);

    const hello = await client.connect((nonce) => {
      const signedAtMs = Date.now();
      const connectParams: Record<string, unknown> = {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: clientId,
          version: clientVersion,
          platform: process.platform,
          mode: clientMode,
        },
        role,
        scopes,
        auth:
          authToken || password
            ? {
                ...(authToken ? { token: authToken } : {}),
                ...(password ? { password } : {}),
              }
            : undefined,
      };
      if (deviceIdentity) {
        const devPayload = buildDeviceAuthPayloadV3({
          deviceId: deviceIdentity.deviceId,
          clientId,
          clientMode,
          role,
          scopes,
          signedAtMs,
          token: authToken,
          nonce,
          platform: process.platform,
        });
        connectParams.device = {
          id: deviceIdentity.deviceId,
          publicKey: deviceIdentity.publicKeyRawBase64Url,
          signature: signDevicePayload(deviceIdentity.privateKeyPem, devPayload),
          signedAt: signedAtMs,
          nonce,
        };
      }
      return connectParams;
    }, connectTimeoutMs);

    onLog?.(
      'stdout',
      `[openclaw-gateway] conectado protocol=${asNumber(asRecord(hello)?.protocol, PROTOCOL_VERSION)}\n`,
    );

    const acceptedPayload = await client.request<Record<string, unknown>>(
      'agent',
      agentParams,
      connectTimeoutMs,
    );
    latestResultPayload = acceptedPayload;
    const acceptedStatus = nonEmpty(acceptedPayload?.status)?.toLowerCase() ?? '';
    const acceptedRunId = nonEmpty(acceptedPayload?.runId) ?? opts.runId;
    trackedRunIds.add(acceptedRunId);
    onLog?.(
      'stdout',
      `[openclaw-gateway] agent aceito runId=${acceptedRunId} status=${acceptedStatus || 'unknown'}\n`,
    );

    if (acceptedStatus === 'error') {
      return {
        ok: false,
        summary: null,
        errorMessage:
          nonEmpty(acceptedPayload?.summary) ?? lifecycleError ?? 'OpenClaw gateway agent falhou',
        errorCode: 'openclaw_gateway_agent_error',
        resultJson: acceptedPayload,
      };
    }

    if (acceptedStatus !== 'ok') {
      const waitPayload = await client.request<Record<string, unknown>>(
        'agent.wait',
        { runId: acceptedRunId, timeoutMs: waitTimeoutMs },
        waitTimeoutMs + connectTimeoutMs,
      );
      latestResultPayload = waitPayload;
      const waitStatus = nonEmpty(waitPayload?.status)?.toLowerCase() ?? '';
      if (waitStatus === 'timeout') {
        return {
          ok: false,
          summary: null,
          timedOut: true,
          errorMessage: `OpenClaw gateway: run expirou após ${waitTimeoutMs}ms`,
          errorCode: 'openclaw_gateway_wait_timeout',
          resultJson: waitPayload,
        };
      }
      if (waitStatus === 'error') {
        return {
          ok: false,
          summary: null,
          errorMessage:
            nonEmpty(waitPayload?.error) ?? lifecycleError ?? 'OpenClaw gateway: run falhou',
          errorCode: 'openclaw_gateway_wait_error',
          resultJson: waitPayload,
        };
      }
      if (waitStatus && waitStatus !== 'ok') {
        return {
          ok: false,
          summary: null,
          errorMessage: `OpenClaw gateway: status inesperado de agent.wait: ${waitStatus}`,
          errorCode: 'openclaw_gateway_wait_status_unexpected',
          resultJson: waitPayload,
        };
      }
    }

    const summaryFromEvents = assistantChunks.join('').trim();
    const summaryFromPayload =
      extractResultText(asRecord(acceptedPayload?.result)) ??
      extractResultText(acceptedPayload) ??
      extractResultText(asRecord(latestResultPayload)) ??
      null;
    const summary = summaryFromEvents || summaryFromPayload || null;

    onLog?.(
      'stdout',
      `[openclaw-gateway] run concluído runId=${Array.from(trackedRunIds).join(',')} status=ok\n`,
    );

    return {
      ok: true,
      summary,
      resultJson: asRecord(latestResultPayload),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    const timedOut = lower.includes('timeout');
    const pairingRequired = lower.includes('pairing required') || lower.includes('pairing');
    const detailed = pairingRequired
      ? `${message}. Aprove o device pendente no OpenClaw (ex: openclaw devices approve --latest) e tente de novo. Persista adapterConfig.devicePrivateKeyPem para reutilizar a aprovação.`
      : message;
    onLog?.('stderr', `[openclaw-gateway] falhou: ${detailed}\n`);
    return {
      ok: false,
      summary: null,
      timedOut,
      errorMessage: detailed,
      errorCode: timedOut
        ? 'openclaw_gateway_timeout'
        : pairingRequired
          ? 'openclaw_gateway_pairing_required'
          : 'openclaw_gateway_request_failed',
      resultJson: asRecord(latestResultPayload),
    };
  } finally {
    client.close();
  }
}
