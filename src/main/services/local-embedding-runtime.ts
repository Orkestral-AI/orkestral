import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join } from 'node:path';
import type { Llama, LlamaEmbeddingContext, LlamaModel } from 'node-llama-cpp';
import { kbEmbeddingRepo } from '../db/repositories/kb-embedding.repo';
import {
  EMBEDDINGS_MODELS_DIR,
  ensureModelsDownloaded,
  isDownloadingModels,
  type ModelDownloadProgress,
} from './model-download-service';
import { getPerformancePreset, getPerformanceProfile } from './performance-preset';
import { getSmartExecConfig } from './smart-exec/config';
import { trace } from './log-bus';

// Broadcaster do progresso de download, injetado no boot (DI) pra NÃO puxar
// electron/BrowserWindow pro grafo de testes deste módulo. Sem ele, o download
// sob demanda roda silencioso (sem toast), mas continua funcionando.
let onDownloadProgress: ((p: ModelDownloadProgress) => void) | null = null;
export function setEmbeddingDownloadProgress(fn: (p: ModelDownloadProgress) => void): void {
  onDownloadProgress = fn;
}

export class LocalEmbeddingUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'LocalEmbeddingUnavailableError';
  }
}

interface EmbeddingCfg {
  modelPath: string;
  allowGpu: boolean;
  contextTokens: number;
  idleUnloadSeconds: number;
  timeoutMs: number;
  threads: number;
}

interface LoadedEmbeddingModel {
  llama: Llama;
  model: LlamaModel;
  context: LlamaEmbeddingContext;
  modelPath: string;
  modelHash: string;
  modelId: string;
  dimension: number;
  contextTokens: number;
  allowGpu: boolean;
}

let loaded: LoadedEmbeddingModel | null = null;
let loadingPromise: Promise<LoadedEmbeddingModel> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();
// Embeddings em voo: >0 impede o idle-unload de dispor o contexto/modelo nativo no meio
// de um getEmbeddingFor (use-after-free → crash).
let embedInFlight = 0;
const DEFAULT_CONTEXT_TOKENS = 2048;
const EMBEDDING_CONTEXT_TOKEN_MARGIN = 8;

// Memoiza o sha256 do GGUF (~640MB): após o idle-unload (economic = 20s), uma rajada
// de indexação recarrega o modelo várias vezes e re-hashar o arquivo a cada load é
// puro desperdício de I/O. Chave = path:mtimeMs:size — se o arquivo mudar, a chave
// muda e o hash é recalculado (correção mantida).
const sha256Cache = new Map<string, string>();

function embeddingsDir(): string {
  const candidates: string[] = [];
  if (process.env.ORKESTRAL_EMBEDDINGS_DIR) {
    candidates.push(process.env.ORKESTRAL_EMBEDDINGS_DIR);
  }
  // PRIMÁRIO: modelo baixado no 1º uso (diretório de dados do usuário).
  candidates.push(EMBEDDINGS_MODELS_DIR);
  const rp = process.resourcesPath;
  if (rp) {
    candidates.push(join(rp, 'resources', 'embeddings'), join(rp, 'embeddings'));
  }
  candidates.push(join(process.cwd(), 'resources', 'embeddings'));
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];
}

function resolveEmbeddingModel(dir: string): string {
  for (const sub of [join(dir, 'models'), dir]) {
    try {
      const gguf = readdirSync(sub).find((f) => f.toLowerCase().endsWith('.gguf'));
      if (gguf) return join(sub, gguf);
    } catch {
      /* diretório ausente */
    }
  }
  return '';
}

function getEmbeddingConfig(): EmbeddingCfg {
  const dir = embeddingsDir();
  // Embedding usa SEMPRE o embedder DEDICADO (0.6B). O Forge unificado (Qwen-Coder-7B causal)
  // NÃO produz embeddings no node-llama-cpp 3.x: o GGUF não tem `pooling_type` na metadata e
  // LlamaEmbeddingContextOptions não aceita override de pooling → POOLING_NONE → "Failed to get
  // embeddings for token X" (e um 7B embeddando seria lento). O Forge segue unificando edit +
  // merge (geração, sem pooling). ORKESTRAL_FORGE_EMBEDDING=1 força o Forge só pra experimento
  // (precisa de GGUF com pooling_type=mean pra funcionar). Default = embedder dedicado.
  const useForge = process.env.ORKESTRAL_FORGE_EMBEDDING === '1';
  const forgePath = useForge ? getSmartExecConfig().local.modelPath : '';
  return {
    modelPath: forgePath || resolveEmbeddingModel(dir),
    allowGpu: process.platform === 'darwin',
    contextTokens: DEFAULT_CONTEXT_TOKENS,
    // Descarrega o modelo de embeddings (~640MB) após N segundos ocioso, por PRESET
    // de memória (economic 20s / moderate 60s / high 120s) — máquina apertada libera
    // rápido; máquina forte mantém quente pra indexar em rajada sem recarregar.
    idleUnloadSeconds: getPerformanceProfile().embeddings.idleUnloadSeconds,
    timeoutMs: 60_000,
    // No preset 'economic' (máquina apertada) o teto de threads é menor (3): o
    // embedder não deve disputar CPU com o Forge + UI justamente onde economic
    // deve ser gentil. Demais presets mantêm o teto histórico (6).
    threads: Math.max(
      2,
      Math.min(getPerformancePreset() === 'economic' ? 3 : 6, Math.floor(cpus().length / 2)),
    ),
  };
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 32)));
  });
}

// Wrapper memoizado: pula o re-hash do GGUF (~640MB) quando o arquivo não mudou
// (mtime + size iguais). Recalcula só quando o arquivo muda → correção preservada.
async function sha256FileMemoized(path: string): Promise<string> {
  const st = statSync(path);
  const key = `${path}:${st.mtimeMs}:${st.size}`;
  const cached = sha256Cache.get(key);
  if (cached) return cached;
  const hash = await sha256File(path);
  sha256Cache.set(key, hash);
  return hash;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new LocalEmbeddingUnavailableError(`Timeout ao ${what} (${ms}ms)`)),
        ms,
      ),
    ),
  ]);
}

function resetIdleTimer(cfg: EmbeddingCfg): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => {
      void stopLocalEmbeddingRuntime();
    },
    Math.max(15, cfg.idleUnloadSeconds) * 1000,
  );
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

export function isLocalEmbeddingConfigured(): boolean {
  const cfg = getEmbeddingConfig();
  return !!cfg.modelPath && existsSync(cfg.modelPath);
}

/** O modelo de embeddings está residente na RAM AGORA? (pro monitor de memória nos
 *  Logs). null = não carregado. Read-only do estado privado. */
export function getLoadedEmbeddingModel(): {
  modelPath: string;
  basename: string;
  dimension: number;
} | null {
  if (!loaded) return null;
  const base = loaded.modelPath.split(/[\\/]/).pop() ?? loaded.modelPath;
  return { modelPath: loaded.modelPath, basename: base, dimension: loaded.dimension };
}

export async function stopLocalEmbeddingRuntime(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = loaded;
  loaded = null;
  if (!current) return;
  try {
    await current.context.dispose();
  } catch {
    /* ignore */
  }
  try {
    await current.model.dispose();
  } catch {
    /* ignore */
  }
  trace({
    level: 'debug',
    source: 'embedding',
    scope: 'unload',
    message: 'modelo local de embeddings descarregado (ocioso)',
  });
}

async function loadEmbeddingModel(cfg: EmbeddingCfg): Promise<LoadedEmbeddingModel> {
  // O modelo NÃO vem mais embutido no instalador. Na 1ª vez que a KB/busca
  // semântica precisa dele, baixa sob demanda (com progresso via toast global).
  // O download é grande (~600MB), então fica FORA dos timeouts de load abaixo.
  if (!cfg.modelPath || !existsSync(cfg.modelPath)) {
    // Baixa sob demanda. O embedder (~600MB) pode estar disputando o LOCK global com o Forge
    // (4.68GB no v3): ensureModelsDownloaded retorna cedo sem baixar quando outro download
    // está em curso. Então em vez de falhar de cara, ESPERA o lock liberar e o embedder
    // aparecer (respiro de ~3min) — sem isso o embedding dava "download falhou" no meio do
    // download do Forge. A indexação re-tenta sozinha na próxima rodada se estourar o respiro.
    const deadline = Date.now() + 180_000;
    do {
      if (isDownloadingModels()) {
        await new Promise((r) => setTimeout(r, 2_000));
      } else {
        await ensureModelsDownloaded(onDownloadProgress ?? (() => {}), { only: ['embeddings'] });
      }
      cfg = { ...cfg, modelPath: resolveEmbeddingModel(embeddingsDir()) };
    } while ((!cfg.modelPath || !existsSync(cfg.modelPath)) && Date.now() < deadline);
  }
  if (!cfg.modelPath || !existsSync(cfg.modelPath)) {
    throw new LocalEmbeddingUnavailableError(
      'Modelo local de embeddings ainda baixando — a indexação recomeça quando ele ficar pronto.',
    );
  }
  const { getLlama } = await import('node-llama-cpp');
  const t0 = Date.now();
  const llama = await withTimeout(
    getLlama({ gpu: cfg.allowGpu ? 'auto' : false }),
    60_000,
    'inicializar runtime local de embeddings',
  );
  const model = await withTimeout(
    llama.loadModel({
      modelPath: cfg.modelPath,
      gpuLayers: cfg.allowGpu
        ? { fitContext: { contextSize: cfg.contextTokens, embeddingContext: true } }
        : 0,
    }),
    120_000,
    'carregar modelo local de embeddings',
  );
  const context = await withTimeout(
    model.createEmbeddingContext({
      contextSize: { min: 128, max: cfg.contextTokens },
      threads: cfg.threads,
      createSignal: AbortSignal.timeout(cfg.timeoutMs),
    }),
    cfg.timeoutMs,
    'criar contexto local de embeddings',
  );
  const modelHash = await sha256FileMemoized(cfg.modelPath);
  const dimension = model.embeddingVectorSize;
  const modelId = `local:${modelHash}`;
  kbEmbeddingRepo.upsertModel({
    id: modelId,
    modelPath: cfg.modelPath,
    modelHash,
    dimension,
    contextTokens: cfg.contextTokens,
  });
  trace({
    level: 'success',
    source: 'embedding',
    scope: 'load',
    message: `modelo de embeddings carregado: ${basename(cfg.modelPath)} · dim=${dimension}`,
    durationMs: Date.now() - t0,
  });
  return {
    llama,
    model,
    context,
    modelPath: cfg.modelPath,
    modelHash,
    modelId,
    dimension,
    contextTokens: cfg.contextTokens,
    allowGpu: cfg.allowGpu,
  };
}

async function ensureEmbeddingModel(): Promise<LoadedEmbeddingModel> {
  const cfg = getEmbeddingConfig();
  if (
    loaded &&
    loaded.modelPath === cfg.modelPath &&
    loaded.contextTokens === cfg.contextTokens &&
    loaded.allowGpu === cfg.allowGpu
  ) {
    resetIdleTimer(cfg);
    return loaded;
  }
  if (loaded) await stopLocalEmbeddingRuntime();
  if (loadingPromise) return loadingPromise;
  loadingPromise = loadEmbeddingModel(cfg)
    .then((m) => {
      loaded = m;
      resetIdleTimer(cfg);
      return m;
    })
    .catch((err) => {
      throw err instanceof LocalEmbeddingUnavailableError
        ? err
        : new LocalEmbeddingUnavailableError(
            `Falha ao carregar embedding local: ${err instanceof Error ? err.message : String(err)}`,
          );
    })
    .finally(() => {
      loadingPromise = null;
    });
  return loadingPromise;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

function tokenizeEmbeddingInput(
  lm: LoadedEmbeddingModel,
  text: string,
): ReturnType<LlamaModel['tokenize']> {
  const maxTokens = Math.max(1, lm.contextTokens - EMBEDDING_CONTEXT_TOKEN_MARGIN);
  const tokens = lm.model.tokenize(text, false, 'trimLeadingSpace');
  if (tokens.length <= maxTokens) return tokens;
  trace({
    level: 'debug',
    source: 'embedding',
    scope: 'truncate',
    message: `texto de embedding truncado para caber no contexto · tokens=${tokens.length}/${maxTokens}`,
  });
  return tokens.slice(0, maxTokens);
}

export async function embedTextLocal(text: string): Promise<{
  modelId: string;
  dimension: number;
  vector: readonly number[];
}> {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new LocalEmbeddingUnavailableError('Texto vazio não pode ser embedado');
  }
  return enqueue(async () => {
    const cfg = getEmbeddingConfig();
    // Cancela o idle-unload e marca a inferência em voo ANTES de qualquer await — o timer
    // (armado por um embed anterior) não pode dispor o contexto nativo durante o
    // getEmbeddingFor abaixo (use-after-free). Re-arma no finally quando zera.
    embedInFlight++;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    try {
      const lm = await ensureEmbeddingModel();
      const embeddingInput = tokenizeEmbeddingInput(lm, normalized);
      const embedding = await withTimeout(
        lm.context.getEmbeddingFor(embeddingInput),
        cfg.timeoutMs,
        'gerar embedding local',
      );
      return {
        modelId: lm.modelId,
        dimension: lm.dimension,
        vector: embedding.vector,
      };
    } finally {
      embedInFlight = Math.max(0, embedInFlight - 1);
      if (embedInFlight === 0) resetIdleTimer(cfg);
    }
  });
}
