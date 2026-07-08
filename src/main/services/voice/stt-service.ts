import { existsSync } from 'node:fs';
import type { TranscribeResult, Whisper as WhisperType } from 'smart-whisper';
import { voicePath } from '../../db/connection';

const MODEL_REL = 'models/stt/ggml-large-v3-turbo-q5_0.bin';
const IDLE_UNLOAD_MS = 60_000;
/** Whisper.cpp descarta áudio < 1s ("input is too short"). Padamos com silêncio
 * pra 1.1s — essencial pro wake-word, cujos turnos costumam ser curtinhos. */
const SAMPLE_RATE = 16000;
const MIN_SAMPLES = Math.round(SAMPLE_RATE * 1.1);

function padToMin(pcm: Float32Array): Float32Array {
  if (pcm.length >= MIN_SAMPLES) return pcm;
  const padded = new Float32Array(MIN_SAMPLES);
  padded.set(pcm, 0); // resto = zeros (silêncio) no fim
  return padded;
}

let whisper: WhisperType | null = null;
let loadingPromise: Promise<WhisperType> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Caminho do modelo baixado pela Fase 0; erro claro se o pack não foi instalado. */
function resolveModelPath(): string {
  const p = voicePath(MODEL_REL);
  if (!existsSync(p)) {
    throw new Error('VOICE_PACK_NOT_INSTALLED');
  }
  return p;
}

async function getWhisper(): Promise<WhisperType> {
  if (whisper) return whisper;
  if (loadingPromise) return loadingPromise;
  const modelPath = resolveModelPath();
  loadingPromise = (async () => {
    const { Whisper } = await import('smart-whisper');
    // offload alto de propósito: este serviço é o dono do ciclo de vida (via
    // IDLE_UNLOAD_MS=60s). O offload interno do smart-whisper (default 300s) faria
    // free() por baixo dos panos, deixando `whisper` apontando pra handle morta.
    // (offload=0 NÃO desliga — vira free imediato; por isso usamos 3600.)
    const w = new Whisper(modelPath, { gpu: true, offload: 3600 });
    whisper = w;
    loadingPromise = null;
    return w;
  })();
  return loadingPromise;
}

function armIdleUnload(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void unloadStt();
  }, IDLE_UNLOAD_MS);
}

export async function unloadStt(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const w = whisper;
  whisper = null;
  if (w) {
    try {
      await w.free();
    } catch {
      // best-effort
    }
  }
}

// Serializa transcrições: smart-whisper NÃO enfileira chamadas concorrentes no
// mesmo contexto nativo (corromperia/crasharia). Encadeamos pra garantir uma de
// cada vez mesmo com múltiplas janelas / segmentos de VAD (Fase 2).
let chain: Promise<unknown> = Promise.resolve();

/**
 * Transcreve PCM Float32 mono 16kHz em texto. `language` default 'pt'.
 * Concatena os segmentos retornados por smart-whisper. Serializado.
 */
export async function transcribePcm(pcm: Float32Array, language = 'pt'): Promise<string> {
  const run = chain.then(async () => {
    // Cancela o idle-unload enquanto transcreve, pra não dar free() no meio.
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const w = await getWhisper();
    const task = await w.transcribe(padToMin(pcm), { language });
    const segments = await task.result;
    armIdleUnload();
    return segments
      .map((s: TranscribeResult) => s.text)
      .join('')
      .trim();
  });
  // Não deixa uma falha envenenar a fila das próximas chamadas.
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Transcreve PCM Float32 mono 16kHz e devolve os segmentos COM timestamps.
 * Mesma cadeia serializada que transcribePcm — nunca roda concorrente.
 * `from`/`to` em milissegundos (conforme smart-whisper TranscribeResult).
 */
export async function transcribeSegments(
  pcm: Float32Array,
  language = 'pt',
): Promise<{ from: number; to: number; text: string }[]> {
  const run = chain.then(async () => {
    // Cancela o idle-unload enquanto transcreve, pra não dar free() no meio.
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const w = await getWhisper();
    const task = await w.transcribe(padToMin(pcm), { language });
    const segments = await task.result;
    armIdleUnload();
    return segments.map((s: TranscribeResult) => ({ from: s.from, to: s.to, text: s.text }));
  });
  // Não deixa uma falha envenenar a fila das próximas chamadas.
  chain = run.catch(() => undefined);
  return run;
}
