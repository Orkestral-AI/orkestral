/**
 * Código do AudioWorkletProcessor (roda na render-thread de áudio). Posta cada
 * bloco de samples mono (Float32) pro main thread via port. Carregado via Blob
 * URL em useDictation. Mantido como string porque worklets precisam de um módulo
 * próprio carregado por URL.
 */
export const PCM_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // copia o canal 0 (mono) e posta pro main thread
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;
