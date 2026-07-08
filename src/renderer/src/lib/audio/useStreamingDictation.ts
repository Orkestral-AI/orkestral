import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import { PCM_WORKLET_SOURCE } from './pcm-worklet';

const TARGET_SAMPLE_RATE = 16000;
const TICK_MS = 1000; // cadência do parcial ao vivo

export type DictationState = 'idle' | 'recording' | 'transcribing' | 'error';

interface DictationApi {
  state: DictationState;
  /** committed + tail concatenados, prontos pra exibir ao vivo. */
  liveText: string;
  error: string | null;
  start: () => Promise<void>;
  /** Para, faz passada final, devolve o texto (ou null se vazio/cancelado). */
  stopAndFinalize: () => Promise<string | null>;
  cancel: () => void;
}

export function useStreamingDictation(): DictationApi {
  const [state, setState] = useState<DictationState>('idle');
  const [liveText, setLiveText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputDeviceId = useSettingsStore((s) => s.settings?.audio?.inputDeviceId ?? null);

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const workletUrlRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingRef = useRef<Float32Array[]>([]); // blocos ainda não enviados
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef(false);

  const teardown = useCallback((): void => {
    recordingRef.current = false;
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (ctxRef.current) {
      void ctxRef.current.close();
      ctxRef.current = null;
    }
    if (workletUrlRef.current) {
      URL.revokeObjectURL(workletUrlRef.current);
      workletUrlRef.current = null;
    }
  }, []);

  // Cleanup no unmount: sem isto, sair do chat gravando deixa o mic LIGADO.
  useEffect(() => () => teardown(), [teardown]);

  /** Junta os blocos pendentes num Float32Array e zera a fila. */
  function drainPending(): Float32Array {
    const chunks = pendingRef.current;
    pendingRef.current = [];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  const start = useCallback(async (): Promise<void> => {
    setError(null);
    setLiveText('');
    pendingRef.current = [];
    try {
      const { sessionId } = await window.orkestral['voice:dictation-start']();
      sessionIdRef.current = sessionId;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      ctxRef.current = ctx;
      if (ctx.sampleRate !== TARGET_SAMPLE_RATE) {
        throw new Error(`AudioContext sample rate ${ctx.sampleRate} != ${TARGET_SAMPLE_RATE}`);
      }
      const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      workletUrlRef.current = url;
      await ctx.audioWorklet.addModule(url);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-capture');
      node.port.onmessage = (e: MessageEvent<Float32Array>): void => {
        pendingRef.current.push(e.data);
      };
      source.connect(node);
      nodeRef.current = node;
      recordingRef.current = true;
      setState('recording');

      // Tick: a cada ~1s manda o delta e atualiza o texto ao vivo.
      tickTimerRef.current = setInterval(() => {
        void (async () => {
          const id = sessionIdRef.current;
          if (!id || !recordingRef.current) return;
          const delta = drainPending();
          try {
            const { committedText, tailText } = await window.orkestral['voice:dictation-tick']({
              sessionId: id,
              pcm: delta.buffer as ArrayBuffer,
              sampleRate: TARGET_SAMPLE_RATE,
            });
            // committed (congelado) + cauda ao vivo (borda que está sendo falada).
            setLiveText([committedText, tailText].filter(Boolean).join(' '));
          } catch {
            // tick best-effort: um tick que falha não derruba a gravação.
          }
        })();
      }, TICK_MS);
    } catch (e) {
      teardown();
      setState('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [teardown, inputDeviceId]);

  const stopAndFinalize = useCallback(async (): Promise<string | null> => {
    if (!recordingRef.current) return null;
    const id = sessionIdRef.current;
    const delta = drainPending();
    // Para timers/mic ANTES da passada final (libera o mic na hora).
    recordingRef.current = false;
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    setState('transcribing');
    try {
      const { finalText } = await window.orkestral['voice:dictation-stop']({
        sessionId: id!,
        pcm: delta.buffer as ArrayBuffer,
        sampleRate: TARGET_SAMPLE_RATE,
      });
      teardown();
      sessionIdRef.current = null;
      setLiveText('');
      setState('idle');
      return finalText.trim() || null;
    } catch (e) {
      teardown();
      sessionIdRef.current = null;
      setState('error');
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [teardown]);

  const cancel = useCallback((): void => {
    const id = sessionIdRef.current;
    if (id) void window.orkestral['voice:dictation-cancel']({ sessionId: id });
    teardown();
    sessionIdRef.current = null;
    pendingRef.current = [];
    setLiveText('');
    setState('idle');
  }, [teardown]);

  return { state, liveText, error, start, stopAndFinalize, cancel };
}
