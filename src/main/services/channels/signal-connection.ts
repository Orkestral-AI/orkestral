import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelConnection, ChannelHandlers, InboundChannelMessage } from './channel-types';
import { signalCliBin, javaHome } from './signal-cli-pack';
import { encodeRequest, parseLines, type SignalRpcMessage } from './signal-jsonrpc';
import { extractLinkUri } from './signal-link-uri';

/**
 * Conexão Signal via `signal-cli` local (sem Bot API oficial / sem webhook). Linka a
 * conta do usuário por QR (`signal-cli link` → `sgnl://linkdevice` → onQr), depois sobe
 * o daemon `jsonRpc` (stdio): recebe por notificações `receive`, envia/edita por `send`.
 *
 * Só DM no MVP (mensagens de grupo/sync são ignoradas), espelhando os outros canais.
 */
export class SignalConnection implements ChannelConnection {
  private daemon: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = '';
  private rpcId = 0;
  private stopped = false;
  /** Requests aguardando resposta: id → resolve(timestamp da msg | null). */
  private readonly pending = new Map<number, (timestamp: number | null) => void>();

  constructor(
    private readonly configDir: string,
    private account: string | null, // número (E.164) se já linkado; null = precisa linkar
    private readonly handlers: ChannelHandlers,
  ) {}

  /** Env com a JAVA_HOME embutida (macOS); no Linux native, javaHome() é null. */
  private spawnEnv(): NodeJS.ProcessEnv {
    const home = javaHome();
    return home ? { ...process.env, JAVA_HOME: home } : { ...process.env };
  }

  async start(): Promise<void> {
    this.stopped = false;
    mkdirSync(this.configDir, { recursive: true });
    if (!this.account) await this.linkFlow();
    if (this.stopped || !this.account) return;
    this.spawnDaemon();
    this.handlers.onConnected(this.account);
  }

  /** Roda `signal-cli link`, emite o URI pro QR e descobre o número ao concluir. */
  private linkFlow(): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn(signalCliBin(), ['--config', this.configDir, 'link', '-n', 'Orkestral'], {
        env: this.spawnEnv(),
      });
      let out = '';
      let emitted = false;
      const onData = (chunk: Buffer): void => {
        out += chunk.toString();
        if (!emitted) {
          const uri = extractLinkUri(out);
          if (uri) {
            emitted = true;
            this.handlers.onQr?.(uri);
          }
        }
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0) {
          this.account = this.discoverAccount();
          resolve();
        } else {
          reject(new Error(`signal-cli link falhou (code ${code})`));
        }
      });
    });
  }

  /** `signal-cli listAccounts` → primeiro número linkado (E.164). */
  private discoverAccount(): string | null {
    try {
      const out = execFileSync(signalCliBin(), ['--config', this.configDir, 'listAccounts'], {
        env: this.spawnEnv(),
      }).toString();
      return out.match(/\+\d{6,}/)?.[0] ?? null;
    } catch {
      return null;
    }
  }

  private spawnDaemon(): void {
    const d = spawn(signalCliBin(), ['--config', this.configDir, '-a', this.account!, 'jsonRpc'], {
      env: this.spawnEnv(),
    });
    this.daemon = d;
    d.stdout.on('data', (chunk: Buffer) => {
      const { messages, rest } = parseLines(this.stdoutBuf + chunk.toString());
      this.stdoutBuf = rest;
      for (const m of messages) this.handleRpc(m);
    });
    d.on('close', () => {
      if (!this.stopped) this.handlers.onDisconnected(false, 'signal-cli daemon encerrou');
    });
    d.on('error', (err) => {
      if (!this.stopped) this.handlers.onDisconnected(false, err.message);
    });
  }

  private handleRpc(m: SignalRpcMessage): void {
    // Resposta a uma request nossa (ex.: timestamp do `send` pra editar depois).
    if (typeof m.id === 'number' && this.pending.has(m.id)) {
      const resolve = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      const ts = (m.result as { timestamp?: number })?.timestamp ?? null;
      resolve(ts);
      return;
    }
    if (m.method !== 'receive') return;
    const env = (m.params as { envelope?: Record<string, unknown> })?.envelope;
    if (!env) return;
    const data = env.dataMessage as { message?: string; groupInfo?: unknown } | undefined;
    // Só DM com texto (ignora grupo e syncMessage).
    if (!data?.message || data.groupInfo) return;
    const from = String(env.sourceNumber ?? env.sourceUuid ?? '');
    if (!from) return;
    const msg: InboundChannelMessage = {
      from,
      senderId: String(env.sourceNumber ?? env.sourceUuid ?? from).replace(/[^\d+]/g, ''),
      senderAliases: env.sourceUuid ? [`uuid:${String(env.sourceUuid)}`] : undefined,
      displayName: (env.sourceName as string) || null,
      text: data.message,
      attachments: [],
    };
    this.handlers.onMessage(msg);
  }

  /** Envia uma request e (opcional) resolve quando a resposta chega. */
  private rpc(method: string, params: unknown, onResult?: (ts: number | null) => void): void {
    const id = ++this.rpcId;
    if (onResult) this.pending.set(id, onResult);
    this.daemon?.stdin.write(encodeRequest(id, method, params));
  }

  /** Envia texto; devolve o timestamp da mensagem (chave pra editar no streaming). */
  sendText(to: string, text: string): Promise<number | null> {
    if (!this.daemon) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (ts: number | null): void => {
        if (!settled) {
          settled = true;
          resolve(ts);
        }
      };
      this.rpc('send', { recipient: [to], message: text }, done);
      // Não trava o streaming se o signal-cli demorar a responder.
      setTimeout(() => done(null), 8000);
    });
  }

  /** Edita uma mensagem já enviada (streaming por edição) via `send` + editTimestamp. */
  async editText(to: string, ref: unknown, text: string): Promise<void> {
    if (!this.daemon || typeof ref !== 'number') return;
    this.rpc('send', { recipient: [to], message: text, editTimestamp: ref });
  }

  async sendTyping(to: string): Promise<void> {
    if (!this.daemon) return;
    this.rpc('sendTyping', { recipient: [to] });
  }

  async sendMedia(
    to: string,
    buffer: Buffer,
    _mime: string,
    caption?: string,
    fileName = 'file',
  ): Promise<void> {
    if (!this.daemon) return;
    const path = join(tmpdir(), `ork-signal-${this.rpcId + 1}-${fileName}`);
    writeFileSync(path, buffer);
    this.rpc('send', { recipient: [to], message: caption ?? '', attachment: [path] });
    // O signal-cli lê o anexo de forma assíncrona; limpa best-effort depois de uma folga.
    setTimeout(() => {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best-effort */
      }
    }, 30_000);
  }

  /** Signal não expõe foto de perfil simples por contato — no-op (mantém a interface). */
  async fetchProfilePhoto(): Promise<string | null> {
    return null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.daemon?.kill();
    this.daemon = null;
  }

  async logout(): Promise<void> {
    // Desvincular = remover este dispositivo da conta. Sem comando self-unlink limpo no
    // signal-cli; o channel-manager apaga o dir de config (efetivamente desvincula).
    this.stopped = true;
    this.daemon?.kill();
    this.daemon = null;
  }
}
