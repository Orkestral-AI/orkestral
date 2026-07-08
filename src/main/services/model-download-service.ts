/**
 * Download dos modelos locais (embeddings + fast-apply).
 *
 * Os GGUFs não vêm embutidos no instalador (pra ele ficar leve): baixam SOB
 * DEMANDA das fontes públicas pro diretório de dados gravável
 * (`~/.orkestral/models`). Best-effort: falha de rede não quebra nada — os
 * consumidores caem em fallback até o modelo existir.
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Base dos modelos baixados — diretório de dados do usuário (gravável). */
export const MODELS_BASE = join(homedir(), '.orkestral', 'models');
export const EMBEDDINGS_MODELS_DIR = join(MODELS_BASE, 'embeddings');
export const FAST_APPLY_MODELS_DIR = join(MODELS_BASE, 'fast-apply');

interface ModelSpec {
  key: 'embeddings' | 'fast-apply';
  label: string;
  /** Fontes EM ORDEM de preferência (CDN próprio → HuggingFace → mirror). O
   *  download tenta a próxima quando uma falha — resiliência a 429/queda/região. */
  urls: string[];
  sizeBytes: number;
  /** sha256 hex esperado (do manifesto do R2). Quando presente, é VERIFICADO após o
   *  download — auto-hospedando o modelo, garante que o byte que chegou é o byte
   *  publicado (anti-corrupção/anti-troca). Ausente = só valida tamanho. */
  sha256?: string;
  dest: string;
}

const EMBED_HF =
  'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf';
/** Fast-Apply (kortix-ai/fast-apply, Apache-2.0) — modelo Qwen2.5-Coder-1.5B fine-tunado
 *  SÓ pra MESCLAR um edit no arquivo (o "morph" próprio). GGUF Q4_K_M (~986 MB) do bartowski. */
const FAST_APPLY_HF =
  'https://huggingface.co/bartowski/FastApply-1.5B-v1.0-GGUF/resolve/main/FastApply-1.5B-v1.0-Q4_K_M.gguf';
/** hf-mirror.com espelha o HuggingFace — fallback quando o HF cai/rate-limita (429). */
function hfMirror(u: string): string {
  return u.replace('https://huggingface.co/', 'https://hf-mirror.com/');
}

/** URL pública (Public Dev URL) do bucket R2 da Orkestral — hospeda o fast-apply. */
const R2_PUB = 'https://pub-049fc618193a4c5a9cafa976442c23c9.r2.dev';

// Baixa das fontes públicas (anônimo, sem token), tentando uma após a outra. Modelos
// são independentes de plataforma (rodam em mac/win/linux via node-llama-cpp).
const MODELS: ModelSpec[] = [
  {
    key: 'embeddings',
    label: 'Embeddings',
    urls: [process.env.EMBEDDINGS_MODEL_URL, EMBED_HF, hfMirror(EMBED_HF)].filter(
      Boolean,
    ) as string[],
    sizeBytes: 639150592,
    dest: join(EMBEDDINGS_MODELS_DIR, 'embedding.gguf'),
  },
  {
    key: 'fast-apply',
    label: 'Fast-Apply',
    // R2 próprio (a publicar) → HuggingFace (bartowski, Apache-2.0) → mirror. Só
    // tamanho é verificado (sha256 ausente — adicionar após publicar no R2).
    urls: [
      process.env.FAST_APPLY_MODEL_URL,
      `${R2_PUB}/fast-apply/fast-apply.gguf`,
      FAST_APPLY_HF,
      hfMirror(FAST_APPLY_HF),
    ].filter(Boolean) as string[],
    sizeBytes: 986047072,
    // Publicado no R2 (fast-apply/fast-apply.gguf) — hash do conteúdo verificado.
    sha256: '95ef997588b0a71f2e3d0dd9e86d180948bb62457cb852e76aa88f0ce3a57156',
    dest: join(FAST_APPLY_MODELS_DIR, 'fast-apply.gguf'),
  },
];

/** Presente e íntegro? Usa o TAMANHO como prova (detecta download parcial). */
function isPresent(m: ModelSpec): boolean {
  if (!existsSync(m.dest)) return false;
  const size = statSync(m.dest).size;
  return size > 0 && (!m.sizeBytes || size === m.sizeBytes);
}

/** O modelo de EMBEDDINGS está presente e íntegro? (pro card de status na UI). */
export function isEmbeddingsPresent(): boolean {
  const m = MODELS.find((x) => x.key === 'embeddings')!;
  return isPresent(m);
}

/** Baixa os EMBEDDINGS sob demanda (retry manual via Integrações). Robusto. */
export async function ensureEmbeddingsDownloaded(
  onProgress: (p: ModelDownloadProgress) => void,
): Promise<void> {
  await ensureModelsDownloaded(onProgress, { only: ['embeddings'] });
}

/** O modelo FAST-APPLY (morph próprio) está presente e íntegro? */
export function isFastApplyPresent(): boolean {
  const m = MODELS.find((x) => x.key === 'fast-apply')!;
  return isPresent(m);
}

/** Caminho do GGUF do fast-apply SE estiver instalado (senão null) — o tier de merge
 *  carrega esse modelo dedicado; ausente → cai no Forge geral + dispara o download lazy. */
export function getFastApplyModelPath(): string | null {
  const m = MODELS.find((x) => x.key === 'fast-apply')!;
  return isPresent(m) ? m.dest : null;
}

/** Baixa o FAST-APPLY (auto/lazy, igual embeddings). Robusto (retry/resume/fallback). */
export async function ensureFastApplyDownloaded(
  onProgress: (p: ModelDownloadProgress) => void,
): Promise<void> {
  await ensureModelsDownloaded(onProgress, { only: ['fast-apply'] });
}

/** O fast-apply está baixando agora? */
export function isDownloadingFastApply(): boolean {
  return downloadingTarget === 'fast-apply';
}

// Broadcaster do progresso do AUTO-INSTALL (pós-onboarding). No-op pra o módulo
// seguir test-safe (sem electron); o download lazy com progresso visível passa
// pelos ensure*Downloaded chamados via IPC com o callback do renderer.
const autoInstallProgress: (p: ModelDownloadProgress) => void = () => {};

let fastApplyAutoScheduled = false;
/**
 * Auto-instala o fast-apply em BACKGROUND (progresso via toast global `autoInstallProgress` —
 * antes era silencioso e o usuário não via feedback nenhum). Disparado ao FIM do onboarding pra
 * o modelo já estar pronto na 1ª issue. Robusto contra o lock global de download (só 1 modelo
 * baixa por vez): se outro modelo — ex.: embeddings, mais crítico pra KB — estiver baixando,
 * `ensureFastApplyDownloaded` retorna cedo e a gente tenta de novo depois, até instalar ou
 * esgotar as tentativas. Idempotente.
 */
export function scheduleFastApplyAutoInstall(): void {
  if (fastApplyAutoScheduled || isFastApplyPresent()) return;
  fastApplyAutoScheduled = true;
  let attempts = 0;
  const tick = (): void => {
    if (isFastApplyPresent() || attempts++ > 20) return;
    void ensureFastApplyDownloaded(autoInstallProgress).finally(() => {
      if (!isFastApplyPresent()) setTimeout(tick, 60_000);
    });
  };
  // Respiro inicial: deixa os embeddings (necessários pra KB) pegarem o lock primeiro.
  setTimeout(tick, 45_000);
}

let embeddingsAutoScheduled = false;
/**
 * Auto-instala os EMBEDDINGS em BACKGROUND e SILÊNCIO (callback no-op → sem toast).
 * PRIMEIRO da fila do lock global: a análise de KB logo após o onboarding precisa deles.
 * Mesmo padrão do fast-apply (retry no lock contention, 20 tentativas, idempotente).
 */
export function scheduleEmbeddingsAutoInstall(): void {
  if (embeddingsAutoScheduled || isEmbeddingsPresent()) return;
  embeddingsAutoScheduled = true;
  let attempts = 0;
  const tick = (): void => {
    if (isEmbeddingsPresent() || attempts++ > 20) return;
    void ensureEmbeddingsDownloaded(autoInstallProgress).finally(() => {
      if (!isEmbeddingsPresent()) setTimeout(tick, 60_000);
    });
  };
  setTimeout(tick, 5_000);
}

export interface ModelDownloadProgress {
  label: string;
  index: number; // 1-based, dentro dos que faltam nesta rodada
  total: number;
  receivedBytes: number;
  totalBytes: number;
  percent: number; // 0..100 do modelo atual
  done: boolean; // todos concluídos
  failed?: boolean;
}

let downloading = false;
// QUAL alvo está baixando agora — pra UI não acender "baixando" em TODOS os cards.
let downloadingTarget: 'embeddings' | 'fast-apply' | null = null;

/** Há um download de modelo em andamento? (pro IPC de status não disparar 2x) */
export function isDownloadingModels(): boolean {
  return downloading;
}

/** Os embeddings estão baixando agora? */
export function isDownloadingEmbeddings(): boolean {
  return downloadingTarget === 'embeddings';
}

/**
 * Garante os modelos no diretório de dados. Idempotente (pula os íntegros) e
 * best-effort (erro não propaga — só loga e marca failed no progresso final).
 *
 * `opts.only` restringe a quais modelos baixar (`['embeddings']` no boot,
 * `['fast-apply']` no lazy do merge). Sem `only` = todos.
 */
export async function ensureModelsDownloaded(
  onProgress: (p: ModelDownloadProgress) => void,
  opts?: { only?: Array<ModelSpec['key']> },
): Promise<void> {
  if (downloading) return;
  downloading = true;
  downloadingTarget =
    opts?.only?.length === 1 && (opts.only[0] === 'embeddings' || opts.only[0] === 'fast-apply')
      ? opts.only[0]
      : null;
  try {
    const pool = opts?.only ? MODELS.filter((m) => opts.only!.includes(m.key)) : MODELS;
    const missing = pool.filter((m) => !isPresent(m));
    if (missing.length === 0) return;
    for (let i = 0; i < missing.length; i++) {
      await downloadWithProgress(missing[i], i + 1, missing.length, onProgress);
    }
    onProgress({
      label: '',
      index: missing.length,
      total: missing.length,
      receivedBytes: 0,
      totalBytes: 0,
      percent: 100,
      done: true,
    });
  } catch (err) {
    console.warn('[models] download falhou:', err instanceof Error ? err.message : err);
    onProgress({
      label: '',
      index: 0,
      total: 0,
      receivedBytes: 0,
      totalBytes: 0,
      percent: 0,
      done: true,
      failed: true,
    });
  } finally {
    downloading = false;
    downloadingTarget = null;
  }
}

const MAX_DOWNLOAD_ATTEMPTS = 6;
// Watchdog de stall: se nenhum chunk chega nesse tempo, aborta a conexão pra cair no retry
// (com resume via Range) em vez de "baixar eternamente" numa conexão travada (a queixa do
// usuário). Resetado a cada chunk recebido.
const STALL_TIMEOUT_MS = 45_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** sha256 hex de um arquivo, em streaming (não carrega o GGUF de ~2 GB na memória). */
function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Baixa um modelo de forma ROBUSTA: tenta cada fonte (CDN próprio → HF → mirror),
 * com RETRY (backoff exponencial) e RESUME (HTTP Range) do arquivo `.part` — um
 * blip de rede num download de 1 GB não recomeça do zero. Só falha de vez depois de
 * esgotar TODAS as fontes × tentativas. Valida pelo tamanho no fim (não grava modelo
 * parcial/corrompido).
 */
async function downloadWithProgress(
  m: ModelSpec,
  index: number,
  total: number,
  onProgress: (p: ModelDownloadProgress) => void,
): Promise<void> {
  mkdirSync(dirname(m.dest), { recursive: true });
  const tmp = `${m.dest}.part`;
  let lastErr: unknown = new Error(`sem fonte para ${m.label}`);
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    for (const url of m.urls) {
      try {
        await downloadFromUrl(url, m, tmp, index, total, onProgress);
        if (m.sizeBytes && statSync(tmp).size !== m.sizeBytes) {
          throw new Error(`tamanho divergente (${statSync(tmp).size} ≠ ${m.sizeBytes})`);
        }
        if (m.sha256) {
          const got = await sha256File(tmp);
          if (got.toLowerCase() !== m.sha256.toLowerCase()) {
            throw new Error(`sha256 divergente (${got.slice(0, 12)}… ≠ ${m.sha256.slice(0, 12)}…)`);
          }
        }
        renameSync(tmp, m.dest);
        return;
      } catch (err) {
        lastErr = err;
        console.warn(
          `[models] ${m.label} via ${hostOf(url)} falhou ` +
            `(tentativa ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Backoff exponencial entre rodadas (cap 30s) — resume guarda o progresso.
    if (attempt < MAX_DOWNLOAD_ATTEMPTS) await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
  }
  rmSync(tmp, { force: true });
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Uma tentativa de UMA fonte, RESUMINDO o `.part` via Range quando o servidor aceita. */
async function downloadFromUrl(
  url: string,
  m: ModelSpec,
  tmp: string,
  index: number,
  total: number,
  onProgress: (p: ModelDownloadProgress) => void,
): Promise<void> {
  let startByte = existsSync(tmp) ? statSync(tmp).size : 0;
  // Já temos o arquivo inteiro no .part? Não rebaixa.
  if (m.sizeBytes && startByte >= m.sizeBytes) return;
  const headers: Record<string, string> = startByte > 0 ? { Range: `bytes=${startByte}-` } : {};
  // Watchdog: aborta a conexão se ficar STALL_TIMEOUT_MS sem receber dados (rearmado a cada
  // chunk). A falha cai no retry de downloadWithProgress, que resume via Range.
  const ctrl = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => ctrl.abort(new Error(`download travado (sem dados há ${STALL_TIMEOUT_MS / 1000}s)`)),
      STALL_TIMEOUT_MS,
    );
  };
  try {
    armStall();
    const res = await fetch(url, { redirect: 'follow', headers, signal: ctrl.signal });
    // 206 = resume aceito. 200 mesmo tendo pedido Range = servidor ignorou → recomeça do 0.
    if (startByte > 0 && res.status === 200) {
      rmSync(tmp, { force: true });
      startByte = 0;
    } else if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('resposta sem corpo');
    const remaining = Number(res.headers.get('content-length')) || 0;
    const totalBytes = m.sizeBytes || (remaining ? startByte + remaining : 0);
    let received = startByte;
    const reader = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    reader.on('data', (chunk: Buffer) => {
      received += chunk.length;
      armStall();
      onProgress({
        label: m.label,
        index,
        total,
        receivedBytes: received,
        totalBytes,
        percent: totalBytes ? Math.min(99, Math.round((received / totalBytes) * 100)) : 0,
        done: false,
      });
    });
    // append quando resumindo; write (trunca) quando do zero. O signal aborta o pipeline junto.
    await pipeline(reader, createWriteStream(tmp, { flags: startByte > 0 ? 'a' : 'w' }), {
      signal: ctrl.signal,
    });
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
}
