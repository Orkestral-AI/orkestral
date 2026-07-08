import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { appInfo, broadcast } from '../../platform/host';
import { downloadWithProgress, extractTarball, sha256File } from '../voice/download-manager';

/**
 * Baixa o `signal-cli` (e uma JRE, onde preciso) SOB DEMANDA — mesmo padrão do
 * voice pack (download-manager). Signal não tem Bot API: o `signal-cli` é um
 * cliente/dispositivo Signal que o Orkestral controla por JSON-RPC local.
 *
 * Versões pinadas (com sha256 dos artefatos oficiais):
 *  - signal-cli v0.14.5 (precisa de Java 25 no macOS; Linux usa o build native, sem Java).
 *  - Eclipse Temurin JRE 25.0.3+9 (só macOS — Linux native dispensa).
 */

const SIGNAL_CLI_VERSION = '0.14.5';
// signal-cli 0.14.5 é compilado pra Java 25 (class file 69) → JRE 25, não 21.
const JRE_DIR = 'jdk-25.0.3+9-jre'; // dir de topo do tar.gz da Temurin

interface PackComponent {
  id: 'jre' | 'cli';
  url: string;
  sha256: string;
  sizeBytes: number;
}

interface PlatformPack {
  /** JRE necessária (macOS); ausente quando o binário é native (Linux). */
  jre?: PackComponent;
  cli: PackComponent;
}

const CLI_GENERIC: PackComponent = {
  id: 'cli',
  url: `https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz`,
  sha256: '62d38ebfef3988d78f437e7328183b75ee549d111382e66c1af70d3ebd3cd7a7',
  sizeBytes: 107393744,
};

const PACKS: Record<string, PlatformPack> = {
  'darwin-arm64': {
    jre: {
      id: 'jre',
      url: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.3%2B9/OpenJDK25U-jre_aarch64_mac_hotspot_25.0.3_9.tar.gz',
      sha256: '287cc80077dc2ffd0e5733ba238f92206a84c26bef33e6881a23c213e4c35af4',
      sizeBytes: 56464762,
    },
    cli: CLI_GENERIC,
  },
  'darwin-x64': {
    jre: {
      id: 'jre',
      url: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.3%2B9/OpenJDK25U-jre_x64_mac_hotspot_25.0.3_9.tar.gz',
      sha256: '594bf4e7d15b622157a54915de7e458c208e3363d61a5e488d8abfbda9aff3e5',
      sizeBytes: 42429998,
    },
    cli: CLI_GENERIC,
  },
  // Linux x64: build NATIVE do signal-cli (não precisa de JRE).
  'linux-x64': {
    cli: {
      id: 'cli',
      url: `https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz`,
      sha256: '39dc9e483da0d69151065e87aee8486d7a8bc67e0d3e9994c851269c1bfd80e3',
      sizeBytes: 105553779,
    },
  },
};

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function packForPlatform(): PlatformPack {
  const pack = PACKS[platformKey()];
  if (!pack) throw new Error(`Signal ainda não é suportado nesta plataforma: ${platformKey()}`);
  return pack;
}

function signalRoot(): string {
  // appInfo.path: userData do Electron no app; fallback ~/.orkestral em Node puro.
  return join(appInfo.path('userData'), 'tools', 'signal-cli');
}

/** Caminho do launcher do signal-cli (script no macOS, binário native no Linux). */
export function signalCliBin(): string {
  // Ambos os tars (genérico e native) extraem pra signal-cli-<versão>/bin/signal-cli.
  return join(signalRoot(), `signal-cli-${SIGNAL_CLI_VERSION}`, 'bin', 'signal-cli');
}

/** JAVA_HOME da JRE embutida (macOS); null quando o build é native (sem Java). */
export function javaHome(): string | null {
  if (!packForPlatform().jre) return null;
  return join(signalRoot(), JRE_DIR, 'Contents', 'Home');
}

export function isSignalCliInstalled(): boolean {
  if (!existsSync(signalCliBin())) return false;
  const home = javaHome();
  return home === null || existsSync(join(home, 'bin', 'java'));
}

let installing = false;
export function isSignalCliInstalling(): boolean {
  return installing;
}

function emit(event: {
  type: 'start' | 'progress' | 'done' | 'error';
  percent?: number;
  error?: string;
}): void {
  broadcast('channels:signal-cli-progress', event);
}

/** Baixa+extrai os componentes ausentes. Valida sha256 antes de extrair. */
export async function installSignalCli(): Promise<{ ok: true }> {
  if (installing) throw new Error('Instalação do signal-cli já em andamento.');
  if (isSignalCliInstalled()) return { ok: true };
  installing = true;
  try {
    const pack = packForPlatform();
    const comps: PackComponent[] = pack.jre ? [pack.jre, pack.cli] : [pack.cli];
    const total = comps.reduce((s, c) => s + c.sizeBytes, 0);
    let base = 0;
    emit({ type: 'start', percent: 0 });

    // Componente já presente no disco (ex.: só a JRE mudou de versão) → não rebaixa.
    const presentPath = (c: PackComponent): string =>
      c.id === 'cli'
        ? signalCliBin()
        : join(signalRoot(), JRE_DIR, 'Contents', 'Home', 'bin', 'java');

    for (const c of comps) {
      if (existsSync(presentPath(c))) {
        base += c.sizeBytes;
        emit({ type: 'progress', percent: Math.round((base / total) * 100) });
        continue;
      }
      const tmp = join(signalRoot(), `${c.id}.tar.gz`);
      await downloadWithProgress(c.url, tmp, c.sizeBytes, (received) => {
        emit({ type: 'progress', percent: Math.round(((base + received) / total) * 100) });
      });
      if ((await sha256File(tmp)) !== c.sha256) {
        throw new Error(`sha256 do componente ${c.id} não confere (download corrompido).`);
      }
      await extractTarball(tmp, signalRoot());
      base += c.sizeBytes;
    }

    // Garante executável + tira a quarentena do Gatekeeper no macOS (binário baixado).
    chmodSync(signalCliBin(), 0o755);
    const home = javaHome();
    if (home) chmodSync(join(home, 'bin', 'java'), 0o755);
    if (process.platform === 'darwin') {
      try {
        // Best-effort: remove quarentena (downloads via fetch normalmente nem têm).
        execFileSync('xattr', ['-dr', 'com.apple.quarantine', signalRoot()], { stdio: 'ignore' });
      } catch {
        /* best-effort — java roda mesmo sem isso quando não há quarentena */
      }
    }
    emit({ type: 'done', percent: 100 });
    return { ok: true };
  } catch (err) {
    emit({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    installing = false;
  }
}
