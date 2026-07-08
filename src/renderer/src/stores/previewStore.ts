import { create } from 'zustand';

/**
 * URL do Preview por source. `detected` vem do auto-detect da saída do terminal
 * (dev server); `manual` é o que o usuário digita na barra (tem prioridade).
 */
interface PreviewState {
  detected: Record<string, string>;
  manual: Record<string, string>;
  setDetected: (sourceId: string, url: string) => void;
  setManual: (sourceId: string, url: string) => void;
  // Pedido pra abrir uma URL no Preview (ex.: clicar num link localhost do terminal).
  // nonce muda a cada pedido pra re-disparar mesmo com a mesma URL.
  openRequest: { sourceId: string; url: string; nonce: number } | null;
  requestOpen: (sourceId: string, url: string) => void;
  clearOpenRequest: () => void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  detected: {},
  manual: {},
  setDetected: (sourceId, url) => set((s) => ({ detected: { ...s.detected, [sourceId]: url } })),
  setManual: (sourceId, url) => set((s) => ({ manual: { ...s.manual, [sourceId]: url } })),
  openRequest: null,
  requestOpen: (sourceId, url) =>
    set((s) => ({ openRequest: { sourceId, url, nonce: (s.openRequest?.nonce ?? 0) + 1 } })),
  clearOpenRequest: () => set({ openRequest: null }),
}));

/** URL efetiva: o que o usuário digitou tem prioridade sobre o auto-detectado. */
export function previewUrlFor(
  state: { detected: Record<string, string>; manual: Record<string, string> },
  sourceId: string,
): string {
  const m = state.manual[sourceId];
  if (m !== undefined) return m;
  return state.detected[sourceId] ?? '';
}
