#!/usr/bin/env node
/**
 * setup-embeddings.mjs - prepara o modelo local de embeddings do Orkestral.
 *
 * Diferente do Forge executor, embeddings sao infraestrutura obrigatoria para
 * RAG de qualidade. O app procura o GGUF em:
 *   resources/embeddings/models/embedding.gguf
 *
 * Env:
 *   EMBEDDINGS_MODEL_URL / EMBEDDINGS_MODEL_SHA256 / EMBEDDINGS_MODEL_SIZE
 *   EMBEDDINGS_DIR                    destino (default: resources/embeddings)
 *   ORKESTRAL_SKIP_EMBEDDINGS=1       escape hatch dev/CI, nunca para release
 */
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const EMBEDDINGS_DIR = process.env.EMBEDDINGS_DIR
  ? resolve(process.env.EMBEDDINGS_DIR)
  : join(APP_DIR, 'resources', 'embeddings');
const MODELS_DIR = join(EMBEDDINGS_DIR, 'models');
const MODEL_DEST = join(MODELS_DIR, 'embedding.gguf');

const log = (...a) => console.log('[embeddings]', ...a);
const warn = (...a) => console.warn('[embeddings]', ...a);
const fail = (message) => {
  console.error('[embeddings]', message);
  process.exit(1);
};

function readManifest() {
  try {
    return JSON.parse(readFileSync(join(__dirname, 'embeddings-manifest.json'), 'utf8'));
  } catch {
    return {};
  }
}

function resolveModelSource() {
  const manifest = readManifest();
  const sizeRaw = process.env.EMBEDDINGS_MODEL_SIZE || manifest.model?.sizeBytes || 0;
  return {
    url: process.env.EMBEDDINGS_MODEL_URL || manifest.model?.url || '',
    sha256: process.env.EMBEDDINGS_MODEL_SHA256 || manifest.model?.sha256 || '',
    etag: process.env.EMBEDDINGS_MODEL_ETAG || manifest.model?.etag || '',
    sizeBytes: Number(sizeRaw) || 0,
  };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function assertIntegrity(file, src) {
  const size = statSync(file).size;
  if (src.sizeBytes && size !== src.sizeBytes) {
    throw new Error(`tamanho divergente: esperado ${src.sizeBytes}, obtido ${size}`);
  }
  if (src.sha256) {
    const got = sha256(file);
    if (got !== src.sha256) {
      throw new Error(`sha256 nao confere: esperado ${src.sha256}, obtido ${got}`);
    }
  } else if (!src.etag) {
    warn('manifesto sem sha256/etag; validando apenas tamanho.');
  }
}

async function download(url, dest) {
  log(`baixando modelo: ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} em ${url}`);
  const tmp = `${dest}.part`;
  rmSync(tmp, { force: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, dest);
}

async function main() {
  if (process.env.ORKESTRAL_SKIP_EMBEDDINGS === '1') {
    warn('ORKESTRAL_SKIP_EMBEDDINGS=1 - pulando preparo do embedder local.');
    return process.exit(0);
  }

  mkdirSync(MODELS_DIR, { recursive: true });
  const src = resolveModelSource();
  if (!src.url) {
    fail(
      'sem EMBEDDINGS_MODEL_URL nem model.url no manifesto; embeddings locais sao obrigatorios.',
    );
  }

  if (existsSync(MODEL_DEST) && statSync(MODEL_DEST).size > 0) {
    try {
      assertIntegrity(MODEL_DEST, src);
      log(`modelo ja presente: ${MODEL_DEST}`);
      return process.exit(0);
    } catch (err) {
      warn(`modelo existente invalido - rebaixando (${err.message}).`);
      rmSync(MODEL_DEST, { force: true });
    }
  }

  try {
    await download(src.url, MODEL_DEST);
    assertIntegrity(MODEL_DEST, src);
    log(`Embeddings prontos em ${MODEL_DEST}`);
  } catch (err) {
    rmSync(MODEL_DEST, { force: true });
    fail(`falha ao preparar embeddings locais: ${err.message}`);
  }
}

main().catch((err) => {
  fail(`erro inesperado: ${err.stack || err}`);
});
