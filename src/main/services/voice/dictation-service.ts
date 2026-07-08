import { transcribeSegments } from './stt-service';
import { pickCommitted } from './segment-commit';

const SAMPLE_RATE = 16000;
const SAFETY_MS = 1500; // não commita o que terminou nos últimos 1.5s (ainda pode mudar)
const SESSION_IDLE_MS = 30_000;
const MAX_UNCOMMITTED_SAMPLES = 30 * SAMPLE_RATE; // ~30s teto do buffer não-commitado

interface DictationSession {
  buffer: Float32Array[]; // áudio AINDA NÃO commitado (já trimado)
  committedText: string; // texto estável, append-only
  lastTail: string; // último trecho volátil exibido (cauda ao vivo)
  ticking: boolean;
  tickPromise: Promise<unknown>;
  lastActivity: number;
}

const sessions = new Map<string, DictationSession>();

function concatBuffer(s: DictationSession): Float32Array {
  const total = s.buffer.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of s.buffer) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function getSession(id: string): DictationSession {
  const s = sessions.get(id);
  if (!s) throw new Error('DICTATION_SESSION_NOT_FOUND');
  s.lastActivity = Date.now();
  return s;
}

function joinText(a: string, b: string): string {
  return [a, b].filter(Boolean).join(' ');
}

/** Remove `count` samples da FRENTE do buffer vivo, preservando o que foi
 *  anexado depois (ex.: áudio que chegou durante o await da transcrição). */
function trimFront(s: DictationSession, count: number): void {
  let remaining = count;
  while (remaining > 0 && s.buffer.length > 0) {
    const head = s.buffer[0];
    if (head.length <= remaining) {
      remaining -= head.length;
      s.buffer.shift();
    } else {
      s.buffer[0] = head.subarray(remaining);
      remaining = 0;
    }
  }
}

export function startDictation(id: string): void {
  sessions.set(id, {
    buffer: [],
    committedText: '',
    lastTail: '',
    ticking: false,
    tickPromise: Promise.resolve(),
    lastActivity: Date.now(),
  });
}

export function appendPcm(id: string, pcm: Float32Array): void {
  getSession(id).buffer.push(pcm);
}

export function tickDictation(id: string): Promise<{ committedText: string; tailText: string }> {
  const s = getSession(id);
  // Tick em voo: devolve o que já temos (committed + última cauda) pra não piscar.
  if (s.ticking) return Promise.resolve({ committedText: s.committedText, tailText: s.lastTail });
  const pcm = concatBuffer(s);
  if (pcm.length === 0)
    return Promise.resolve({ committedText: s.committedText, tailText: s.lastTail });
  s.ticking = true;
  const p = (async (): Promise<{ committedText: string; tailText: string }> => {
    try {
      const segments = await transcribeSegments(pcm, 'pt');
      const durationMs = (pcm.length / SAMPLE_RATE) * 1000;
      const { text, trimMs } = pickCommitted(segments, durationMs, SAFETY_MS);
      // Cauda ao vivo = segmentos AINDA não estáveis (a borda que você está falando).
      // É o que faz o texto aparecer enquanto fala; o committed (à esquerda) não muda.
      let tailText = segments
        .filter((seg) => seg.to > durationMs - SAFETY_MS)
        .map((seg) => seg.text.trim())
        .filter(Boolean)
        .join(' ');
      if (text) s.committedText = joinText(s.committedText, text);
      if (trimMs > 0) {
        trimFront(s, Math.min(pcm.length, Math.round((trimMs / 1000) * SAMPLE_RATE)));
      } else {
        // Fix 2: hard cap — fala contínua sem pausa nunca tem segmento "estável";
        // se o buffer passar do teto, força-commita o snapshot transcrito e corta,
        // pra não voltar ao O(n²). Corte pode partir uma palavra (raro, aceitável).
        const liveLen = s.buffer.reduce((n, c) => n + c.length, 0);
        if (liveLen > MAX_UNCOMMITTED_SAMPLES) {
          const allText = segments
            .map((seg) => seg.text.trim())
            .filter(Boolean)
            .join(' ');
          if (allText) s.committedText = joinText(s.committedText, allText);
          trimFront(s, pcm.length); // corta exatamente o snapshot; tail (chegado no await) preservado
          tailText = ''; // commitamos tudo nesse caso
        }
      }
      s.lastTail = tailText;
      return { committedText: s.committedText, tailText };
    } finally {
      s.ticking = false;
    }
  })();
  s.tickPromise = p.catch(() => undefined);
  return p;
}

export async function stopDictation(id: string): Promise<{ finalText: string }> {
  const s = getSession(id);
  try {
    await s.tickPromise; // drena tick em voo ANTES de snapshotar (evita corrida/duplicação)
    const pcm = concatBuffer(s);
    let finalText = s.committedText;
    if (pcm.length > 0) {
      const segments = await transcribeSegments(pcm, 'pt');
      const rest = segments
        .map((seg) => seg.text.trim())
        .filter(Boolean)
        .join(' ');
      finalText = joinText(s.committedText, rest);
    }
    return { finalText };
  } finally {
    sessions.delete(id);
  }
}

export function cancelDictation(id: string): void {
  sessions.delete(id);
}

// Varre sessões órfãs (renderer fechou no meio sem stop/cancel).
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_IDLE_MS) sessions.delete(id);
  }
}, SESSION_IDLE_MS).unref();
