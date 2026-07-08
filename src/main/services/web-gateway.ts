/**
 * Gateway web do Orkestral — serve a UI (out/renderer) por HTTP e expõe o
 * MESMO contrato IPC do desktop pra um browser puro:
 *
 *   POST /api/ipc/<canal>   body {"request": ...}  → dispatchIpc(canal, request)
 *   GET  /api/events        SSE, cada evento é {channel, payload} (pushBus)
 *   GET  /api/gateway/info  metadados (versão, canais, indisponíveis)
 *
 * Auth: token persistente (userData/gateway-token) via `Authorization: Bearer`
 * ou `?token=` (EventSource não manda header). Os assets estáticos são
 * públicos — são o mesmo código open-source; TODO dado passa pela API autenticada.
 *
 * Nada aqui depende do Electron: é o caminho do CLI standalone (`orkestral
 * serve`) — no app desktop o renderer continua falando ipcRenderer/preload.
 */
import { createServer, type Server } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { registerAllIpcHandlers } from '../ipc';
import { dispatchIpc, listRegisteredChannels } from '../ipc/register';
import { pushBus, appInfo } from '../platform/host';
import {
  GATEWAY_API_IPC_PATH,
  GATEWAY_EVENTS_PATH,
  GATEWAY_INFO_PATH,
  GATEWAY_WEB_UNAVAILABLE_CHANNELS,
  isWebUnavailableChannel,
} from '../../shared/gateway';

export interface WebGatewayOptions {
  host: string;
  port: number;
}

export interface WebGatewayHandle {
  /** URL pronta pra abrir no browser (token no fragment — não vai pro servidor/logs). */
  url: string;
  token: string;
  close: () => Promise<void>;
}

/**
 * Token persistente por instalação. Fica FORA do banco de propósito: o gateway
 * precisa dele antes do bootstrap e o arquivo permite rotacionar (deletar =
 * gerar outro no próximo boot). Exportado pro `onboard` montar a URL da UI
 * antes/sem subir o servidor neste processo (ex.: daemon recém-instalado).
 */
export function loadOrCreateToken(): string {
  const dir = appInfo.path('userData');
  const file = join(dir, 'gateway-token');
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored.length >= 32) return stored;
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** Comparação constant-time sobre digests (não vaza tamanho nem conteúdo). */
function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

/**
 * Acha o out/renderer subindo a partir deste arquivo. O bundle do main pode
 * rodar de out/main/*.js OU de out/main/chunks/*.js (rollup decide), então o
 * caminho relativo fixo quebraria — sobe até achar o dir `out/`.
 */
function resolveRendererDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'renderer', 'index.html');
    if (existsSync(candidate)) return join(dir, 'renderer');
    dir = dirname(dir);
  }
  const fromCwd = join(process.cwd(), 'out', 'renderer');
  return existsSync(join(fromCwd, 'index.html')) ? fromCwd : null;
}

/** URL da UI web pra um gateway em `host:port` — mesmo formato da impressa pelo serve. */
export function gatewayUrl(host: string, port: number): string {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  return `http://${displayHost}:${port}/#token=${loadOrCreateToken()}`;
}

export function startWebGateway(options: WebGatewayOptions): Promise<WebGatewayHandle> {
  // No app desktop o index.ts registra os handlers; no CLI ninguém registrou
  // ainda (o CLI chama services direto). Idempotente: registrar duas vezes é erro.
  if (listRegisteredChannels().length === 0) {
    registerAllIpcHandlers();
  }
  const token = loadOrCreateToken();
  const app = express();
  app.disable('x-powered-by');

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    const query = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (!tokenMatches(token, bearer ?? query)) {
      res.status(401).json({ ok: false, error: 'token do gateway inválido ou ausente' });
      return;
    }
    next();
  };

  // Limite alto por causa de payloads com arquivo embutido (KB/attachments base64).
  app.post(
    `${GATEWAY_API_IPC_PATH}/:channel`,
    requireAuth,
    express.json({ limit: '64mb' }),
    async (req: Request, res: Response) => {
      const channel = req.params.channel;
      if (!listRegisteredChannels().includes(channel)) {
        res.status(404).json({ ok: false, error: `canal IPC desconhecido: ${channel}` });
        return;
      }
      if (isWebUnavailableChannel(channel)) {
        res.status(403).json({
          ok: false,
          error: `"${channel}" é um recurso do app desktop — indisponível na interface web`,
        });
        return;
      }
      // Body {"request": ...}: preserva a distinção undefined/null que o
      // ipcRenderer.invoke transporta e que JSON puro não representa.
      const body = req.body as { request?: unknown } | undefined;
      const request = body && 'request' in body ? body.request : undefined;
      try {
        const response = await dispatchIpc(channel, request);
        res.json({ ok: true, response });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ ok: false, error: message });
      }
    },
  );

  app.get(GATEWAY_EVENTS_PATH, requireAuth, (req: Request, res: Response) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // desliga buffering em proxies reversos (nginx) — SSE precisa fluir na hora
      'x-accel-buffering': 'no',
    });
    res.write(':ok\n\n');

    const onPush = (event: { channel: string; payload: unknown }): void => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // payload não serializável — pula o evento; nunca derruba o stream
      }
    };
    pushBus.on('push', onPush);
    // ping periódico: mantém a conexão viva através de proxies/timeouts
    const ping = setInterval(() => res.write(':ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      pushBus.removeListener('push', onPush);
    });
  });

  app.get(GATEWAY_INFO_PATH, requireAuth, (_req: Request, res: Response) => {
    res.json({
      ok: true,
      response: {
        name: 'orkestral',
        version: appInfo.version(),
        channels: listRegisteredChannels(),
        webUnavailable: GATEWAY_WEB_UNAVAILABLE_CHANNELS,
      },
    });
  });

  const rendererDir = resolveRendererDir();
  if (rendererDir) {
    app.use(express.static(rendererDir));
    // SPA fallback (HashRouter só precisa do index, mas GET desconhecido não-API
    // voltar a UI é o comportamento padrão de gateway)
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(join(rendererDir, 'index.html'));
    });
  } else {
    app.get('/', (_req: Request, res: Response) => {
      res
        .status(503)
        .type('text/plain')
        .send('UI web não encontrada (out/renderer). Rode `npm run build` antes do serve.');
    });
  }

  const server: Server = createServer(app);
  return new Promise<WebGatewayHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      const displayHost = options.host === '0.0.0.0' ? 'localhost' : options.host;
      resolve({
        url: `http://${displayHost}:${options.port}/#token=${token}`,
        token,
        close: () =>
          new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))),
      });
    });
  });
}
