/**
 * Boot-check de atualização via GitHub Releases — SEM Apple Developer / assinatura.
 *
 * Não usa o auto-update do electron-updater (que exige Developer ID no macOS).
 * Só consulta a release mais recente do repo público, compara a versão e, se houver
 * uma nova, devolve a URL do .dmg pro app oferecer "Atualizar" (download manual no
 * navegador; o usuário arrasta pra Applications). Tudo best-effort: offline/erro/
 * rate-limit → devolve "sem update" em silêncio, nunca quebra o boot.
 *
 * Quando virar produto com cert Apple, dá pra trocar isto por electron-updater
 * seamless sem mexer no resto.
 */
import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from '../platform/electron';
import { appInfo } from '../platform/host';
import electronUpdater from 'electron-updater';
import type { UpdateInfo } from '../../shared/ipc-contract';

// NÃO desestruturar `autoUpdater` no top-level: o getter inicializa o updater no
// acesso (cria MacUpdater, chama app.getVersion) e quebra fora do Electron (ex.:
// no vitest). Acessamos lazy DENTRO das funções, que só rodam no app empacotado.

const REPO = 'Orkestral-AI/orkestral';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Quebra "v1.2.3" / "1.2.3-beta" em [major, minor, patch] numéricos. */
function parseSemver(v: string): [number, number, number] {
  const parts = v
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((n) => parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** `latest` é estritamente mais novo que `current`? (compara major.minor.patch) */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

interface GithubRelease {
  tag_name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

/** Escolhe o .dmg da arch atual (arm64/x64); fallback pra qualquer .dmg. */
function pickMacAsset(assets: GithubRelease['assets']): string | null {
  const list = assets ?? [];
  const arch = process.arch; // 'arm64' | 'x64'
  const byArch = list.find(
    (a) => a.name.toLowerCase().endsWith('.dmg') && a.name.toLowerCase().includes(arch),
  );
  const anyDmg = list.find((a) => a.name.toLowerCase().endsWith('.dmg'));
  return byArch?.browser_download_url ?? anyDmg?.browser_download_url ?? null;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = appInfo.version();
  const none: UpdateInfo = {
    hasUpdate: false,
    currentVersion,
    latestVersion: null,
    notes: null,
    url: null,
    htmlUrl: null,
    publishedAt: null,
  };
  try {
    const res = await fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Orkestral-Updater',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(8000),
    });
    // 404 = sem releases ainda; 403 = rate-limit; etc → trata como "sem update".
    if (!res.ok) return none;
    const rel = (await res.json()) as GithubRelease;
    if (!rel?.tag_name || rel.draft || rel.prerelease) return none;

    const latestVersion = rel.tag_name.replace(/^v/i, '');
    const dmgUrl = pickMacAsset(rel.assets);
    return {
      hasUpdate: isNewerVersion(latestVersion, currentVersion),
      currentVersion,
      latestVersion,
      notes: rel.body?.trim() || null,
      url: dmgUrl ?? rel.html_url ?? null,
      htmlUrl: rel.html_url ?? null,
      publishedAt: rel.published_at ?? null,
    };
  } catch {
    // offline / timeout / JSON inválido → silencioso.
    return none;
  }
}

// ─── Auto-update seamless (electron-updater) ────────────────────────────────
// Baixa a nova versão em segundo plano e instala ao reiniciar — o usuário não
// reinstala na mão. SÓ no app empacotado, e NÃO no macOS sem assinatura (lá o
// updater não consegue aplicar o pacote; o checador manual acima cobre o Mac
// até existir um Developer ID). Tudo best-effort: nunca derruba o boot.

let autoUpdaterWired = false;

/** Liga o auto-update. `onDownloaded(version)` avisa o renderer (banner "reiniciar"). */
export function initAutoUpdater(onDownloaded: (version: string) => void): void {
  if (!app?.isPackaged) return; // dev/Node puro não têm app-update.yml
  if (process.platform === 'darwin') return; // macOS sem assinatura → checador manual
  if (autoUpdaterWired) return;
  autoUpdaterWired = true;
  try {
    const { autoUpdater } = electronUpdater; // lazy: só aqui, no app empacotado
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[auto-updater] versão ${info.version} baixada — pronta pra instalar`);
      onDownloaded(info.version);
    });
    autoUpdater.on('error', (err) => {
      console.warn('[auto-updater] erro (ignorado):', err instanceof Error ? err.message : err);
    });
    void autoUpdater.checkForUpdates().catch(() => {});
    // Re-checa a cada 4h enquanto o app fica aberto.
    setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  } catch (err) {
    console.warn('[auto-updater] init falhou (ignorado):', err);
  }
}

/** Reinicia o app aplicando a atualização já baixada (chamado pelo botão do banner). */
export function quitAndInstallUpdate(): void {
  if (!autoUpdaterWired) return;
  try {
    electronUpdater.autoUpdater.quitAndInstall();
  } catch (err) {
    console.warn('[auto-updater] quitAndInstall falhou:', err);
  }
}

/**
 * Baixa o instalador DENTRO do app (pro ~/Downloads), reportando progresso, e
 * retorna o caminho — o handler abre o instalador no fim. Substitui o "abrir no
 * navegador": no macOS sem assinatura ainda é instalação manual (arrastar pra
 * Applications), mas o download acontece no app, com barra de progresso.
 */
export async function downloadUpdateInstaller(
  url: string,
  onProgress: (percent: number) => void,
): Promise<string> {
  const filename = url.split('/').pop()?.split('?')[0] || 'Orkestral-update';
  // Sem Electron não há app.getPath('downloads') — cai no ~/Downloads convencional.
  const dest = join(app ? app.getPath('downloads') : join(homedir(), 'Downloads'), filename);
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const file = createWriteStream(dest);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      file.write(Buffer.from(value));
      received += value.length;
      if (total) onProgress(Math.min(99, Math.round((received / total) * 100)));
    }
  } finally {
    await new Promise<void>((resolve) => file.end(() => resolve()));
  }
  return dest;
}
