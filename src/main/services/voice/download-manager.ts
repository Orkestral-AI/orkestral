import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** sha256 de um arquivo em disco (stream, não carrega tudo na RAM). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const rs = createReadStream(path);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', reject);
  });
}

/** Aborta o download se ficar sem receber dados por este tempo (re-armado a cada chunk). */
const STALL_TIMEOUT_MS = 30_000;
/** Folga sobre o tamanho esperado antes de abortar por excesso (defesa contra body sem fim). */
const SIZE_SLACK = 1.05;

/**
 * Baixa `url` pra `dest` de forma atômica (.part → rename), reportando bytes
 * recebidos via `onBytes`. NÃO valida sha256 (quem chama valida depois).
 * Cria a pasta-pai. Retorna total de bytes escritos.
 *
 * Defesas: timeout de stall (re-armado a cada chunk) e teto de tamanho
 * (`expectedBytes * SIZE_SLACK`) — aborta + limpa o `.part` se estourar, pra
 * um servidor com `content-length` errado/infinito não encher o disco.
 */
export async function downloadWithProgress(
  url: string,
  dest: string,
  expectedBytes: number,
  onBytes: (received: number, total: number) => void,
): Promise<number> {
  const controller = new AbortController();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };
  const clearStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };

  const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} em ${url}`);

  const headerLen = Number(res.headers.get('content-length')) || 0;
  const total = expectedBytes || headerLen || 0;
  const maxBytes = total ? Math.ceil(total * SIZE_SLACK) : 0;

  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  if (existsSync(tmp)) rmSync(tmp, { force: true });
  const out = createWriteStream(tmp);

  let received = 0;
  const reader = res.body.getReader();
  armStall();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      received += buf.byteLength;
      if (maxBytes && received > maxBytes) {
        throw new Error(
          `download excedeu o tamanho esperado (${received} > ${maxBytes} bytes) em ${url}`,
        );
      }
      // backpressure: espera o write drenar quando o buffer enche
      if (!out.write(buf)) {
        await new Promise<void>((r) => out.once('drain', () => r()));
      }
      armStall();
      onBytes(received, total);
    }
  } catch (err) {
    clearStall();
    out.destroy();
    rmSync(tmp, { force: true });
    if (stalled) throw new Error(`download travado: sem dados por ${STALL_TIMEOUT_MS}ms em ${url}`);
    throw err;
  }
  clearStall();

  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on('error', reject);
  });

  renameSync(tmp, dest);
  return received;
}

/**
 * Extrai um tarball (`.tar.gz` ou `.tar.bz2`) em `destDir` usando o `tar` do SO.
 * O flag de compressão é detectado pela extensão (`-xjf` p/ bzip2, `-xzf` p/
 * gzip). Disponível em macOS/Linux nativamente e no Windows 10+ (bsdtar). NÃO
 * valida sha — quem chama valida o pacote ANTES de extrair. Cria `destDir`.
 */
export function extractTarball(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const flag = archivePath.endsWith('.bz2') ? '-xjf' : '-xzf';
  return new Promise<void>((resolve, reject) => {
    const child = spawn('tar', [flag, archivePath, '-C', destDir], {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.once('error', (err) => reject(err));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar saiu com código ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}
