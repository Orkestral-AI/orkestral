import type { VoicePack, VoicePackComponent } from '../../../shared/types';

/**
 * Manifesto do Voice Pack — APENAS assets de STT (transcrição local).
 * sha256/sizeBytes PINADOS contra os arquivos reais do Hugging Face.
 * getPackStatus/installPack validam o sha256 de cada arquivo baixado.
 * (TTS/LiveKit removidos: são do modo conversa, fora deste escopo.)
 */
export const VOICE_PACK: VoicePack = {
  id: 'local-voice',
  version: '0.1.0',
  components: [
    {
      id: 'whisper-model',
      label: 'whisperModel',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
      sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
      sizeBytes: 574041195,
      dest: 'models/stt/ggml-large-v3-turbo-q5_0.bin',
    },
    {
      id: 'whisper-vad',
      label: 'whisperVad',
      url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
      sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
      sizeBytes: 885098,
      dest: 'models/stt/ggml-silero-v5.1.2.bin',
    },
  ],
};

/** `${process.platform}-${process.arch}` (ex: 'darwin-arm64'). */
export function currentPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** Componentes do pack válidos pra plataforma atual (sem platform = todas). */
export function componentsForPlatform(pack: VoicePack = VOICE_PACK): VoicePackComponent[] {
  const key = currentPlatformKey();
  return pack.components.filter((c) => !c.platform || c.platform === key);
}
