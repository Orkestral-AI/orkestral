import { spawn, type ChildProcess, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { appInfo } from '../../platform/host';

/**
 * Túnel embutido via Cloudflare (`cloudflared`). O Teams precisa alcançar o bot
 * por uma URL pública HTTPS, mas o servidor roda em localhost. Em vez de pedir
 * pro usuário montar um túnel à mão, baixamos o `cloudflared` sob demanda (igual
 * aos packs de voz/modelos) e subimos um *quick tunnel* (`*.trycloudflare.com`,
 * grátis, sem conta) que encaminha a URL pública pro localhost:porta. A URL é
 * efêmera (muda a cada execução) — quem reaponta o endpoint no Azure é o
 * channel-manager via `teams app update`. Um túnel por porta.
 */

/** Binário cloudflared no userData (baixado sob demanda). */
function cloudflaredPath(): string {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  return join(appInfo.path('userData'), 'bin', name);
}

/** Asset oficial do cloudflared pra esta plataforma/arch (release `latest`). */
function downloadAsset(): { url: string; tgz: boolean } {
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'darwin') {
    return { url: `${base}/cloudflared-darwin-${arch}.tgz`, tgz: true };
  }
  if (process.platform === 'win32') {
    return { url: `${base}/cloudflared-windows-${arch}.exe`, tgz: false };
  }
  return { url: `${base}/cloudflared-linux-${arch}`, tgz: false };
}

export function isCloudflaredInstalled(): boolean {
  return existsSync(cloudflaredPath());
}

/** Garante o binário cloudflared no disco (baixa se faltar). */
export async function ensureCloudflared(): Promise<string> {
  const dest = cloudflaredPath();
  if (existsSync(dest)) return dest;
  const binDir = join(appInfo.path('userData'), 'bin');
  mkdirSync(binDir, { recursive: true });
  const { url, tgz } = downloadAsset();
  console.log('[tunnel] baixando cloudflared de', url);
  const res = await fetch(url); // fetch segue os redirects do GitHub releases
  if (!res.ok) throw new Error(`Falha ao baixar o cloudflared (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (tgz) {
    // O asset do macOS é um .tgz com o binário dentro — extrai com o tar do sistema.
    const tgzPath = join(binDir, 'cloudflared.tgz');
    writeFileSync(tgzPath, buf);
    const out = spawnSync('tar', ['-xzf', tgzPath, '-C', binDir]);
    if (out.status !== 0) {
      throw new Error(`Falha ao extrair o cloudflared: ${out.stderr?.toString() ?? ''}`);
    }
  } else {
    writeFileSync(dest, buf);
  }
  if (process.platform !== 'win32') chmodSync(dest, 0o755);
  if (!existsSync(dest)) throw new Error('cloudflared não encontrado após o download.');
  return dest;
}

interface ActiveTunnel {
  url: string;
  child: ChildProcess;
}
/** Túneis ativos por porta. */
const tunnels = new Map<number, ActiveTunnel>();

/** Quanto esperar a URL aparecer no output do cloudflared. */
const URL_TIMEOUT_MS = 30_000;
const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Sobe (ou reusa) um quick tunnel pra `http://localhost:port` e devolve a URL
 * pública. O processo do cloudflared fica vivo enquanto o túnel existir.
 */
export async function startTunnel(port: number): Promise<string> {
  const existing = tunnels.get(port);
  if (existing) return existing.url;

  const bin = await ensureCloudflared();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const onData = (chunk: Buffer): void => {
      const m = TRYCLOUDFLARE_RE.exec(String(chunk));
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        const url = m[0];
        tunnels.set(port, { url, child });
        console.log('[tunnel] quick tunnel ativo:', url, '→ localhost:' + port);
        resolve(url);
      }
    };
    // O cloudflared imprime a URL no stderr (mas escutamos os dois por segurança).
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      tunnels.delete(port);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared encerrou (código ${code}) antes de abrir o túnel.`));
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* já morto */
      }
      reject(new Error('Tempo esgotado esperando a URL do túnel.'));
    }, URL_TIMEOUT_MS);
  });
}

/** URL pública atual do túnel de uma porta (null se não há túnel). */
export function tunnelUrlForPort(port: number): string | null {
  return tunnels.get(port)?.url ?? null;
}

/** Derruba o túnel de uma porta. */
export function stopTunnel(port: number): void {
  const t = tunnels.get(port);
  if (!t) return;
  tunnels.delete(port);
  try {
    t.child.kill('SIGTERM');
  } catch {
    /* já morto */
  }
}

/** Derruba todos os túneis (chamado no quit pra não deixar cloudflared órfão). */
export function stopAllTunnels(): void {
  for (const port of [...tunnels.keys()]) stopTunnel(port);
}
