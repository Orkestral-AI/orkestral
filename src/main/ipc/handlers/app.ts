import { app, BrowserWindow, webContents } from '../../platform/electron';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHandler } from '../register';
import { appInfo, broadcast } from '../../platform/host';
import { openExternalSafe } from '../../utils/safe-shell';
import {
  ensureEmbeddingsDownloaded,
  isEmbeddingsPresent,
  ensureFastApplyDownloaded,
  isFastApplyPresent,
  isDownloadingFastApply,
  isDownloadingModels,
  isDownloadingEmbeddings,
} from '../../services/model-download-service';
import { getLoadedEmbeddingModel } from '../../services/local-embedding-runtime';
import { getLoadedLocalModels } from '../../services/smart-exec/llama-runtime';
import { getWorkspaceDiagnostics } from '../../services/run-diagnostics';
import { totalmem, freemem } from 'node:os';

// ESM: não há __dirname nativo. Derivamos igual ao src/main/index.ts.
const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerAppHandlers(): void {
  registerHandler('app:get-version', () => ({
    // appInfo.version: app.getVersion() no Electron; APP_VERSION/fallback em Node puro.
    version: appInfo.version(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));

  // RAM total da máquina (MB) — o onboarding usa pra RECOMENDAR o preset de
  // desempenho (slider). totalmem() vem em bytes.
  registerHandler('system:hardware', () => ({
    totalMemMb: Math.round(totalmem() / (1024 * 1024)),
  }));

  // Consumo de memória AO VIVO pro monitor nos Logs. process.memoryUsage().rss inclui as
  // alocações nativas do llama.cpp (não dá pra atribuir bytes por modelo), então o RSS é
  // "app + modelos locais" e a lista de modelos vira on/off (residente ou não).
  registerHandler('system:memory-stats', () => {
    const mem = process.memoryUsage();
    const local = getLoadedLocalModels();
    const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));
    return {
      rssMb: mb(mem.rss),
      heapUsedMb: mb(mem.heapUsed),
      totalMemMb: mb(totalmem()),
      freeMemMb: mb(freemem()),
      models: [
        { kind: 'fast-apply' as const, loaded: local.some((m) => m.isFastApply) },
        { kind: 'embeddings' as const, loaded: getLoadedEmbeddingModel() !== null },
      ],
    };
  });

  // Diagnóstico de saúde + métricas agregadas (tokens/custo) do workspace, pra
  // página de Logs. (Estava no handler exec-stats, removido junto com o Forge.)
  registerHandler('diagnostics:get', ({ workspaceId }) => getWorkspaceDiagnostics(workspaceId));

  // Embeddings (~640MB): status + download/retry manual. O download
  // robusto (retry/backoff/resume/fallback) vive no model-download-service.
  registerHandler('models:embeddings-status', () => ({
    present: isEmbeddingsPresent(),
    // Só "baixando" quando é o EMBEDDINGS de fato (não quando o Forge baixa).
    downloading: isDownloadingEmbeddings(),
  }));
  registerHandler('models:download-embeddings', () => {
    if (isEmbeddingsPresent() || isDownloadingModels()) return { started: false };
    // broadcast (host): janelas quando existem + pushBus (gateway/CLI headless).
    void ensureEmbeddingsDownloaded((p) => broadcast('models:download-progress', p));
    return { started: true };
  });

  // Fast-Apply (~986MB): o "morph" próprio (kortix-ai/fast-apply, Apache-2.0). Mesmo
  // padrão dos embeddings — auto-install LAZY (na 1ª falha de âncora) + retry manual aqui.
  registerHandler('models:fast-apply-status', () => ({
    present: isFastApplyPresent(),
    downloading: isDownloadingFastApply(),
  }));
  registerHandler('models:download-fast-apply', () => {
    // No v3 a UI já mostra "Incluído no Forge" e esconde o botão (o Forge faz o merge), então
    // este download manual só é alcançável pras genéricas (v1/v2), que de fato precisam dele.
    if (isFastApplyPresent() || isDownloadingModels()) return { started: false };
    void ensureFastApplyDownloaded((p) => broadcast('models:download-progress', p));
    return { started: true };
  });

  // Abre os ajustes de data/hora do SO (deep-link nativo por plataforma).
  registerHandler('system:open-datetime-settings', async () => {
    if (process.platform === 'darwin') {
      await openExternalSafe('x-apple.systempreferences:com.apple.Date-Time-Settings.extension');
    } else if (process.platform === 'win32') {
      await openExternalSafe('ms-settings:dateandtime');
    } else {
      await openExternalSafe('settings://');
    }
    return { ok: true as const };
  });

  // Controles de janela CUSTOM (traffic lights nativos escondidos no macOS). Janela
  // única → opera na primeira BrowserWindow. Sem Electron (CLI standalone) não
  // existe janela — o guard vira o erro que o gateway devolve pro web.
  registerHandler('window:minimize', () => {
    if (!BrowserWindow) throw new Error('Controles de janela disponíveis apenas no app desktop.');
    BrowserWindow.getAllWindows()[0]?.minimize();
    return { ok: true as const };
  });
  registerHandler('window:toggle-maximize', () => {
    if (!BrowserWindow) throw new Error('Controles de janela disponíveis apenas no app desktop.');
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return { maximized: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { maximized: win.isMaximized() };
  });
  registerHandler('window:close', () => {
    if (!BrowserWindow) throw new Error('Controles de janela disponíveis apenas no app desktop.');
    BrowserWindow.getAllWindows()[0]?.close();
    return { ok: true as const };
  });

  // DevTools embutido do Preview: renderiza o DevTools do webview-alvo DENTRO de um
  // segundo webview (host), dockado ao lado — igual o Chrome. open=false fecha.
  registerHandler('webview:set-devtools', ({ targetId, devtoolsId, open }) => {
    if (!webContents) throw new Error('DevTools do preview disponível apenas no app desktop.');
    const target = webContents.fromId(targetId);
    if (!target) return { ok: true as const };
    if (open) {
      if (devtoolsId != null) {
        const dt = webContents.fromId(devtoolsId);
        if (dt) target.setDevToolsWebContents(dt);
      }
      // mode:'detach' é OBRIGATÓRIO junto com setDevToolsWebContents — sem ele o
      // openDevTools dock no dono e ignora o webContents host (frontend fica vazio).
      target.openDevTools({ mode: 'detach' });
    } else {
      target.closeDevTools();
    }
    return { ok: true as const };
  });

  // Encerra o aplicativo. No CLI standalone quem encerra o daemon é o próprio
  // processo (Ctrl+C/systemd) — este canal é da GUI.
  registerHandler('app:quit', () => {
    if (!app) throw new Error('Encerrar por este comando está disponível apenas no app desktop.');
    app.quit();
    return { ok: true as const };
  });

  registerHandler('app:logout', () => {
    return { ok: true as const };
  });

  // URL (file://) do preload que será injetado nos <webview> do painel de Preview.
  // O preload do webview fica no mesmo diretório que o preload principal
  // (out/preload/), só com nome diferente. Usamos pathToFileURL para garantir
  // encoding correto em caminhos com espaços/caracteres especiais.
  registerHandler('app:webview-preload-path', () => {
    return {
      url: pathToFileURL(join(__dirname, '../preload/webview.mjs')).href,
    };
  });
}
