import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { transcribePcm } from '../voice/stt-service';

// Em produção o binário fica fora do asar (asarUnpack) — o path precisa apontar
// pro `.unpacked`, senão o spawn falha (não dá pra executar de dentro do asar).
// Em dev o caminho não tem `app.asar`, então fica inalterado.
const ffmpegPath = ffmpegStatic
  ? ffmpegStatic.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  : null;

/**
 * Decodifica um áudio (OGG/opus do WhatsApp, mp3, etc.) pra PCM 16 kHz mono
 * Float32 — o formato que o Whisper (smart-whisper) consome. Usa o ffmpeg
 * estático bundlado, lendo do stdin e escrevendo f32le no stdout.
 */
function decodeToPcm16k(input: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg indisponível'));
      return;
    }
    const ff = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-f',
      'f32le',
      '-ac',
      '1',
      '-ar',
      '16000',
      'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    let err = '';
    ff.stdout.on('data', (d: Buffer) => chunks.push(d));
    ff.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg falhou (${code}): ${err.slice(0, 300)}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const samples = Math.floor(buf.byteLength / 4);
      // Cópia pra um Float32Array próprio (o buffer do Node é reusado).
      const f32 = new Float32Array(samples);
      for (let i = 0; i < samples; i++) f32[i] = buf.readFloatLE(i * 4);
      resolve(f32);
    });
    ff.stdin.on('error', () => {
      /* EPIPE se o ffmpeg fechar cedo — o close handler já reporta */
    });
    ff.stdin.write(input);
    ff.stdin.end();
  });
}

/** Transcreve um áudio (bytes) localmente via Whisper. Retorna o texto (pode ser vazio). */
export async function transcribeAudio(input: Buffer, language = 'pt'): Promise<string> {
  const pcm = await decodeToPcm16k(input);
  const text = await transcribePcm(pcm, language);
  return text.trim();
}
