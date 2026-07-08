import { randomUUID } from 'node:crypto';
import { registerHandler } from '../register';
import { getPackStatus, installPack, uninstallPack } from '../../services/voice/voice-pack-manager';
import {
  startDictation,
  appendPcm,
  tickDictation,
  stopDictation,
  cancelDictation,
} from '../../services/voice/dictation-service';

const EXPECTED_SR = 16000;

function assertSr(sampleRate: number): void {
  if (sampleRate !== EXPECTED_SR) {
    throw new Error(`sampleRate esperado ${EXPECTED_SR}, recebido ${sampleRate}`);
  }
}

export function registerVoiceHandlers(): void {
  registerHandler('voice:get-status', () => getPackStatus());
  registerHandler('voice:install', () => installPack());
  registerHandler('voice:uninstall', () => uninstallPack());

  registerHandler('voice:dictation-start', () => {
    const sessionId = randomUUID();
    startDictation(sessionId);
    return { sessionId };
  });

  registerHandler('voice:dictation-tick', async ({ sessionId, pcm, sampleRate }) => {
    assertSr(sampleRate);
    appendPcm(sessionId, new Float32Array(pcm));
    return tickDictation(sessionId);
  });

  registerHandler('voice:dictation-stop', async ({ sessionId, pcm, sampleRate }) => {
    assertSr(sampleRate);
    if (pcm.byteLength > 0) appendPcm(sessionId, new Float32Array(pcm));
    return stopDictation(sessionId);
  });

  registerHandler('voice:dictation-cancel', ({ sessionId }) => {
    cancelDictation(sessionId);
  });
}
