import { app, BrowserWindow, nativeImage, Tray, Menu, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { openExternalSafe } from './utils/safe-shell';
import { fileURLToPath } from 'node:url';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';

// O main é empacotado como ESM (package.json "type":"module"), e em ESM NÃO
// existe `__dirname` — sem isto o boot quebra com "ReferenceError: __dirname is
// not defined" no createWindow (preload/loadFile usam __dirname). Polyfill
// canônico via import.meta.url.
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── App Icon ──────────────────────────────────────────────────
// Em dev o ícone vem de <project>/resources/icon.png; em prod de
// <app>/Contents/Resources/resources/icon.png (via extraResources).
function getAppIcon(): Electron.NativeImage | undefined {
  try {
    const iconPath = is.dev
      ? join(app.getAppPath(), 'resources/icon.png')
      : join(process.resourcesPath, 'resources/icon.png');
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      console.warn('[icon] não consegui carregar de:', iconPath);
      return undefined;
    }
    return image;
  } catch (error) {
    console.warn('[icon] erro ao carregar ícone:', error);
    return undefined;
  }
}
import { registerAllIpcHandlers } from './ipc';
import { bootstrapServices } from './bootstrap';
import { resumeInterruptedWork } from './services/issue-execution-service';
import { stopAllPreviews } from './services/preview-manager';
import { killAllTerminals } from './services/terminal-service';
import { killAllDockerStreams } from './services/docker-service';
import { closeDatabase } from './db/connection';
import { WorkspaceRepository } from './db/repositories/workspace.repo';
import { stopHeartbeatScheduler } from './services/heartbeat-service';
import { stopRoutineScheduler } from './services/routine-service';
import { initAutoUpdater, checkForUpdate } from './services/update-service';
import {
  scheduleEmbeddingsAutoInstall,
  scheduleFastApplyAutoInstall,
  type ModelDownloadProgress,
} from './services/model-download-service';
import { setEmbeddingDownloadProgress } from './services/local-embedding-runtime';
import { stopMonitorScheduler } from './services/monitor-scheduler';
import {
  registerCloudProtocol,
  handleCloudDeepLink,
  findDeepLinkInArgv,
} from './services/cloud-auth';
import { buildApplicationMenu } from './menu';
import { fixPath } from './utils/fix-path';
import {
  configurePetWindow,
  initPetWindowFromSettings,
  setPetEnabled,
  onPetEnabledChanged,
  wasPetRecentlyInteracted,
} from './pet/pet-window';
import { SettingsRepository } from './db/repositories/settings.repo';

// App empacotado aberto pelo Finder herda um PATH mínimo e não acha
// `claude`/`codex`/`node` → `spawn ENOENT`. Corrige o PATH antes de qualquer
// spawn. Em dev o PATH já vem do terminal, então pulamos pra não custar boot.
if (!is.dev) fixPath();

// macOS imprime no stderr — uma linha por item de menu — o warning nativo
// "representedObject is not a WeakPtrToElectronMenuModelAsNSObject" ao montar o
// menu da aplicação. É inofensivo (bug conhecido do Electron no Cocoa) mas
// polui ~30 linhas o console no boot. Filtramos só essa linha conhecida; todo
// o resto do stderr passa intacto.
if (process.platform === 'darwin') {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const filtered = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const text =
      typeof chunk === 'string'
        ? chunk
        : ((chunk as { toString?: () => string })?.toString?.() ?? '');
    if (text.includes('is not a WeakPtrToElectronMenuModelAsNSObject')) {
      // Node chama write(chunk, cb) OU write(chunk, encoding, cb) — o callback
      // pode estar em qualquer das duas posições. Invocamos quem for função.
      if (typeof encoding === 'function') (encoding as () => void)();
      else if (typeof callback === 'function') (callback as () => void)();
      return true;
    }
    return (originalStderrWrite as (...a: unknown[]) => boolean)(chunk, encoding, callback);
  };
  process.stderr.write = filtered as typeof process.stderr.write;
}

/** Janela principal (pode estar escondida/no background). */
let mainWindowRef: BrowserWindow | null = null;
/** Ícone na barra de menu (Tray) — ponto de acesso com a janela fechada. */
let tray: Tray | null = null;
/** True quando o usuário pediu pra SAIR de fato (Tray "Sair" / Cmd+Q) — aí o
 *  fechar da janela encerra o app em vez de só esconder. */
let isQuitting = false;

function createWindow(): void {
  const icon = getAppIcon();
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Orkestral',
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0E0F10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Orkestral executa trabalhos longos em background. Com a janela
      // minimizada, o renderer ainda precisa receber IPCs, atualizar stores e
      // disparar notificações de conclusão em tempo real.
      backgroundThrottling: false,
      // Spellcheck dá falso-positivo em tudo que é técnico (src/, tsconfig.json,
      // identificadores camelCase, etc). Como o app inteiro é dev tool, ele atrapalha
      // muito mais do que ajuda — desligado globalmente.
      spellcheck: false,
      // <webview> do painel de Preview (IDE) — processo isolado pra mostrar o dev
      // server rodando sem travar a UI nem esbarrar em X-Frame-Options.
      webviewTag: true,
    },
  });

  // Esconde os traffic lights NATIVOS do macOS (vermelho/amarelo/verde) — o app usa
  // controles custom mais sutis no topo do trilho de navegação (WindowControls no
  // renderer, via IPC window:minimize/toggle-maximize/close). A janela segue
  // arrastável pelas regiões window-drag.
  if (process.platform === 'darwin') {
    try {
      mainWindow.setWindowButtonVisibility(false);
    } catch {
      /* não-macOS ou API indisponível — ignora */
    }
  }

  mainWindowRef = mainWindow;

  // Fechar a janela NÃO encerra o Orkestral — esconde pra background (schedulers,
  // downloads e agentes seguem rodando). Reabre pelo Tray (barra de menu) ou pelo
  // Dock. Só sai de verdade pelo "Sair" do Tray/menu ou Cmd+Q (isQuitting=true).
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      // Sai do Dock também → vira app de barra de menu puro (só o ícone na topbar).
      // O showMainWindow() traz o Dock de volta ao reabrir.
      if (process.platform === 'darwin') app.dock?.hide();
    }
  });
  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void openExternalSafe(details.url);
    return { action: 'deny' };
  });

  // Atalhos de zoom (Cmd/Ctrl + =, -, 0). Electron por default só liga o `+`
  // (que requer shift no QWERTY) — bloqueando o `-` de funcionar. Aqui ligamos
  // todos manualmente via `before-input-event` antes do renderer ver o evento.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    if (!mod) return;
    const wc = mainWindow.webContents;
    if (input.key === '=' || input.key === '+') {
      wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4));
      event.preventDefault();
    } else if (input.key === '-' || input.key === '_') {
      wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
      event.preventDefault();
    } else if (input.key === '0') {
      wc.setZoomLevel(0);
      event.preventDefault();
    }
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/** Mostra/foca a janela principal (recria se foi destruída). Usado pelo Tray,
 *  pelo clique no Dock e pelo "abrir" via notificação. */
function showMainWindow(): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    if (mainWindowRef.isMinimized()) mainWindowRef.restore();
    mainWindowRef.show();
    mainWindowRef.focus();
  } else {
    createWindow();
  }
  if (process.platform === 'darwin') {
    void app.dock?.show().catch(() => {});
    // Reesconde os traffic lights NATIVOS: alternar o Dock (hide/show) muda a
    // política de ativação e o macOS RESETA a visibilidade dos botões — sem isto
    // eles reaparecem "em evidência" (o app usa controles custom no trilho).
    try {
      mainWindowRef?.setWindowButtonVisibility(false);
    } catch {
      /* ignore */
    }
  }
}

/** Verifica atualização (checador manual do GitHub — cobre o macOS, onde o
 *  auto-update não roda sem assinatura) e mostra o resultado num diálogo nativo. */
async function checkForUpdatesFromTray(): Promise<void> {
  const { dialog } = await import('electron');
  try {
    const info = await checkForUpdate();
    const link = info.htmlUrl || info.url || '';
    if (info.hasUpdate && link) {
      const res = await dialog.showMessageBox({
        type: 'info',
        message: `Nova versão disponível: ${info.latestVersion}`,
        detail: `Você está na ${info.currentVersion}. Quer abrir a página de download?`,
        buttons: ['Baixar', 'Depois'],
        defaultId: 0,
        cancelId: 1,
      });
      if (res.response === 0) void openExternalSafe(link);
    } else {
      await dialog.showMessageBox({
        type: 'info',
        message: 'Você está atualizado',
        detail: `Orkestral ${info.currentVersion} é a versão mais recente.`,
        buttons: ['OK'],
      });
    }
  } catch {
    /* offline / sem releases — silencioso */
  }
}

/** Logo "O" do Orkestral pra barra de menu, na variante do tema do SO (dark/light),
 *  já em alta resolução (o `@2x` é pego automático pelo nativeImage no retina). */
function trayIconImage(): Electron.NativeImage {
  const variant = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const dir = is.dev
    ? join(app.getAppPath(), 'resources/tray')
    : join(process.resourcesPath, 'resources/tray');
  const img = nativeImage.createFromPath(join(dir, `orkestral-${variant}.png`));
  if (!img.isEmpty()) return img;
  // Fallback: ícone do app reduzido (caso os PNGs não venham no bundle).
  return getAppIcon()?.resize({ width: 22, height: 22 }) ?? nativeImage.createEmpty();
}

/** Menu do Tray. Reconstruído a cada toggle do pet — o label
 *  "Ocultar/Mostrar pet" reflete o estado persistido nas settings. */
function buildTrayMenu(): Electron.Menu {
  let petEnabled = false;
  try {
    petEnabled = new SettingsRepository().get().pet.enabled;
  } catch {
    // DB ainda não inicializado — trata como desligado
  }
  return Menu.buildFromTemplate([
    { label: 'Abrir Orkestral', click: () => showMainWindow() },
    {
      label: petEnabled ? 'Ocultar pet' : 'Mostrar pet',
      click: () => setPetEnabled(!petEnabled),
    },
    {
      label: 'Preferências…',
      click: () => {
        showMainWindow();
        mainWindowRef?.webContents.send('app:open-settings');
      },
    },
    { label: 'Verificar atualizações…', click: () => void checkForUpdatesFromTray() },
    { type: 'separator' },
    {
      label: 'Sair do Orkestral',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

/** Cria o ícone na barra de menu (Tray) — é o que mantém o Orkestral acessível
 *  "na topbar" mesmo com a janela fechada/escondida. */
function setupTray(): void {
  if (tray) return;
  tray = new Tray(trayIconImage());
  // Troca a logo na hora quando o usuário alterna dark/light no SO.
  nativeTheme.on('updated', () => tray?.setImage(trayIconImage()));
  tray.setToolTip('Orkestral');
  tray.setContextMenu(buildTrayMenu());
  // Toggle do pet (Tray OU Configurações) → label do menu acompanha.
  onPetEnabledChanged(() => tray?.setContextMenu(buildTrayMenu()));
}

// ─── Deep link (orkestral://) — login via Orkestral Cloud ─────────
// Instância única: no Win/Linux o deep link chega como argv de uma SEGUNDA
// instância; sem o lock cada link abriria outro app. No macOS chega via
// open-url na instância viva.
// Quando o deep link é o que ABRE o app, ele chega antes do DB existir —
// guarda pendente e processa no fim do boot.
let appBooted = false;
let pendingDeepLink: string | null = null;
function dispatchDeepLink(url: string): void {
  if (appBooted) handleCloudDeepLink(url);
  else pendingDeepLink = url;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = findDeepLinkInArgv(argv);
    if (link) dispatchDeepLink(link);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// macOS entrega o deep link via open-url (precisa estar registrado ANTES do
// ready — o evento pode disparar no próprio boot quando o link abre o app).
app.on('open-url', (event, url) => {
  event.preventDefault();
  dispatchDeepLink(url);
});

// Nome do app (menu, "About", dock). Sem isso, em dev aparece "Electron".
// Precisa ser ANTES do whenReady pra valer no painel "Sobre" e no dock.
app.setName('Orkestral');
app.setAboutPanelOptions({
  applicationName: 'Orkestral',
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
  copyright: `© ${new Date().getFullYear()} Orkestral`,
  credits: 'Deck operacional de desenvolvimento com IA',
});

app.whenReady().then(async () => {
  try {
    electronApp.setAppUserModelId('com.orkestral.app');

    // Registra orkestral:// como protocolo do app (deep link do login Cloud).
    registerCloudProtocol();

    // Menu próprio com "Orkestral" fixado — substitui o menu padrão que mostra
    // "Electron" em dev (Ocultar/Sair/Sobre). Em prod garante consistência.
    buildApplicationMenu();

    // macOS: BrowserWindow.icon não afeta o dock — precisa app.dock.setIcon.
    const dockIcon = getAppIcon();
    if (dockIcon && process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(dockIcon);
    }

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    // Boot Node-puro (DB, recovery, sync de times, schedulers, canais, fila de
    // embedding, MCP, retomada de execuções) — reusável pelo CLI headless.
    bootstrapServices({ headless: false });

    registerAllIpcHandlers();
    createWindow();
    setupTray();
    // Desktop pet: os paths saem DESTE módulo (entry raiz, __dirname estável) —
    // o pet-window vira chunk compartilhado com o CLI e não pode confiar no
    // próprio import.meta.url. Configurar ANTES de qualquer criação de janela.
    configurePetWindow({
      preload: join(__dirname, '../preload/index.mjs'),
      prodHtml: join(__dirname, '../renderer/pet.html'),
    });
    // Recria se o usuário deixou ligado na última sessão.
    initPetWindowFromSettings();
    // SMOKE do engine-v2 (gated por env): roda uma fatia viva com Forge real e loga. Dev-only.
    if (process.env.ENGINE_V2_SMOKE) {
      setTimeout(() => {
        import('./services/engine-v2/smoke')
          .then((m) => m.runEngineV2Smoke())
          .catch((err) => console.error('[engine-v2 smoke] falhou:', err));
      }, 10_000);
    }
    // RETOMADA NO BOOT: re-dispara o trabalho que ficou parado quando o app fechou
    // (planos ativos + issues `todo`, incluindo as que o recovery devolveu pra fila).
    // Depois do IPC/schedulers/window prontos; a execução roda via setImmediate e o
    // estado persiste no DB, então o renderer reflete ao carregar.
    try {
      resumeInterruptedWork();
    } catch (err) {
      console.warn('[boot] resume do trabalho interrompido falhou:', err);
    }
    // HORIZON Fase 2: objetivos ativos <100% cujo trabalho todo assentou enquanto o
    // app estava fechado — re-dispara o loop de convergência (caps/rate-limit valem).
    setTimeout(() => {
      import('./services/goal-verification-service')
        .then((m) => m.sweepStalledGoals())
        .catch((err) => console.warn('[boot] sweep de objetivos parados falhou:', err));
    }, 15_000);
    // Auto-update (Win/Linux empacotado): baixa a nova versão em background e,
    // quando pronta, avisa o renderer (banner "reiniciar pra atualizar").
    initAutoUpdater((version) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update:downloaded', { version });
      }
    });

    // Broadcast do progresso de download de modelo pro renderer (toast global).
    const broadcastModelProgress = (p: ModelDownloadProgress): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('models:download-progress', p);
      }
    };

    // Nem Forge nem embeddings vêm embutidos no instalador (pra ele ficar leve e
    // baixar rápido). Ambos baixam SOB DEMANDA no 1º uso. Injeta o broadcaster de
    // progresso no runtime de embeddings pra o download preguiçoso aparecer no
    // toast global (sem puxar electron pro grafo de testes do módulo).
    setEmbeddingDownloadProgress(broadcastModelProgress);

    // RETOMADA NO BOOT: se o onboarding já foi concluído (há workspace) mas algum modelo ficou
    // pela metade (app fechou no meio do download), re-arma o auto-install. Os schedulers são
    // idempotentes (pulam o que já está em disco) e re-tentam o que falta com resume via Range.
    try {
      if (new WorkspaceRepository().listAll().length > 0) {
        scheduleEmbeddingsAutoInstall();
        scheduleFastApplyAutoInstall();
      }
    } catch (err) {
      console.warn('[boot] retomada do auto-install de modelos falhou:', err);
    }

    // Deep link pendente (app aberto PELO link) + link no argv (Windows,
    // primeira instância já recebe a URL como argumento).
    appBooted = true;
    const bootLink = pendingDeepLink ?? findDeepLinkInArgv(process.argv);
    pendingDeepLink = null;
    if (bootLink) handleCloudDeepLink(bootLink);

    app.on('activate', () => {
      // Clique no Dock → traz a janela de volta (recria se foi destruída).
      // EXCETO quando a ativação veio de interação com o PET: clicar no pet
      // ativa o app no macOS e puxaria a janela principal junto — o pet tem
      // seus próprios caminhos pra abrir o app (menu e cards).
      if (wasPetRecentlyInteracted()) return;
      showMainWindow();
    });
  } catch (error) {
    console.error('[boot] falha na inicialização:', error);
    const { dialog } = await import('electron');
    dialog.showErrorBox(
      'Orkestral — falha na inicialização',
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason);
});

// Defensivo: um erro de stream órfão (ex.: EPIPE em stdin de child já morto) não
// pode derrubar o app inteiro. Logamos e seguimos.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException (não-fatal):', err);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Garante que o handler de 'close' deixe a janela fechar de verdade (Cmd+Q,
  // menu nativo, auto-update) em vez de só esconder pro background.
  isQuitting = true;
  stopHeartbeatScheduler();
  stopRoutineScheduler();
  stopMonitorScheduler();
  killAllTerminals();
  killAllDockerStreams();
  stopAllPreviews();
  closeDatabase();
});
