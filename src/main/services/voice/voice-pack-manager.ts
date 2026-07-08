import { chmodSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { broadcast } from '../../platform/host';
import type { VoiceInstallEvent, VoicePackComponent, VoicePackStatus } from '../../../shared/types';
import { voicePath } from '../../db/connection';
import { VOICE_PACK, componentsForPlatform } from './pack-manifest';
import { downloadWithProgress, extractTarball, sha256File } from './download-manager';

let installing = false;

/**
 * Caminho-sentinela que prova a presença do componente: pra componentes que
 * extraem (`extract`), é `sentinel` dentro de `dest`; senão é o próprio `dest`.
 */
function sentinelPath(c: VoicePackComponent): string {
  if (c.extract && c.sentinel) return join(voicePath(c.dest), c.sentinel);
  return voicePath(c.dest);
}

function emit(event: VoiceInstallEvent): void {
  broadcast('voice:install-progress', event);
}

/**
 * Checagem BARATA pra status polls: presença + tamanho confere (sem hashear).
 * Hashear 574MB a cada poll seria I/O à toa — a integridade real é validada no
 * install (pós-download) via sha256.
 *
 * Pra componentes que extraem (`extract`), o `dest` é um diretório e o sha/size
 * são do tar.gz baixado — não dá pra comparar tamanho no disco. A presença é
 * então o arquivo-sentinela (.onnx) existir.
 */
function isComponentPresent(c: VoicePackComponent): boolean {
  const path = sentinelPath(c);
  if (!existsSync(path)) return false;
  if (c.extract) return true; // sentinela existe = presente (tar.gz já extraído)
  try {
    return !c.sizeBytes || statSync(path).size === c.sizeBytes;
  } catch {
    return false;
  }
}

/** Checagem CARA (sha256): usada no install pra pular re-download de arquivo íntegro. */
async function isComponentValid(dest: string, sha256: string): Promise<boolean> {
  if (!existsSync(dest)) return false;
  try {
    return (await sha256File(dest)) === sha256;
  } catch {
    return false;
  }
}

export async function getPackStatus(): Promise<VoicePackStatus> {
  const comps = componentsForPlatform();
  const missing: string[] = [];
  for (const c of comps) {
    if (!isComponentPresent(c)) missing.push(c.id);
  }
  return {
    packId: VOICE_PACK.id,
    installed: missing.length === 0,
    installing,
    version: missing.length === 0 ? VOICE_PACK.version : null,
    missingComponents: missing,
  };
}

export async function installPack(): Promise<{ ok: true }> {
  if (installing) throw new Error('Instalação de voz já em andamento.');
  installing = true;
  const comps = componentsForPlatform();
  const totalBytes = comps.reduce((s, c) => s + c.sizeBytes, 0);

  try {
    emit({ type: 'start', packId: VOICE_PACK.id, totalBytes });
    let baseReceived = 0;

    const onProgress = (received: number): void => {
      const cumulative = baseReceived + received;
      emit({
        type: 'progress',
        packId: VOICE_PACK.id,
        receivedBytes: cumulative,
        totalBytes,
        percent: totalBytes ? Math.round((cumulative / totalBytes) * 100) : 0,
      });
    };
    const skipComponent = (c: VoicePackComponent): void => {
      baseReceived += c.sizeBytes;
      emit({
        type: 'progress',
        packId: VOICE_PACK.id,
        receivedBytes: baseReceived,
        totalBytes,
        percent: totalBytes ? Math.round((baseReceived / totalBytes) * 100) : 100,
      });
      emit({ type: 'component-done', packId: VOICE_PACK.id, componentId: c.id });
    };

    for (const c of comps) {
      emit({ type: 'component-start', packId: VOICE_PACK.id, componentId: c.id, label: c.label });

      if (c.extract) {
        // Componente extraído (tar.gz): se a sentinela já existe (ex: faber
        // pré-colocado no dev), considera presente e pula. Caso contrário,
        // baixa o tar.gz num temp, valida o sha do PACOTE, extrai e limpa.
        if (existsSync(sentinelPath(c))) {
          skipComponent(c);
          continue;
        }
        const archive = `${voicePath(c.dest)}/${c.id}.${c.extract === 'tar.bz2' ? 'tar.bz2' : 'tar.gz'}`;
        await downloadWithProgress(c.url, archive, c.sizeBytes, onProgress);
        const archiveSha = await sha256File(archive);
        if (archiveSha !== c.sha256) {
          rmSync(archive, { force: true });
          throw new Error(
            `sha256 não confere em ${c.id}: esperado ${c.sha256}, obtido ${archiveSha}`,
          );
        }
        await extractTarball(archive, voicePath(c.dest));
        rmSync(archive, { force: true });
        baseReceived += c.sizeBytes;
        emit({ type: 'component-done', packId: VOICE_PACK.id, componentId: c.id });
        continue;
      }

      const dest = voicePath(c.dest);
      if (await isComponentValid(dest, c.sha256)) {
        skipComponent(c);
        continue;
      }

      await downloadWithProgress(c.url, dest, c.sizeBytes, onProgress);

      const got = await sha256File(dest);
      if (got !== c.sha256) {
        rmSync(dest, { force: true });
        throw new Error(`sha256 não confere em ${c.id}: esperado ${c.sha256}, obtido ${got}`);
      }
      if (c.executable) chmodSync(dest, 0o755);

      baseReceived += c.sizeBytes;
      emit({ type: 'component-done', packId: VOICE_PACK.id, componentId: c.id });
    }

    emit({ type: 'done', packId: VOICE_PACK.id });
    return { ok: true as const };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', packId: VOICE_PACK.id, error });
    throw new Error(error);
  } finally {
    installing = false;
  }
}

export async function uninstallPack(): Promise<{ ok: true }> {
  for (const c of componentsForPlatform()) {
    if (c.extract && c.sentinel) {
      // `dest` é um diretório compartilhado (ex: models/tts); apaga só a pasta
      // extraída do componente (1º segmento da sentinela), não o dir inteiro.
      const top = c.sentinel.split('/')[0];
      rmSync(join(voicePath(c.dest), top), { force: true, recursive: true });
    } else {
      rmSync(voicePath(c.dest), { force: true });
    }
    rmSync(`${voicePath(c.dest)}.part`, { force: true });
  }
  return { ok: true as const };
}
