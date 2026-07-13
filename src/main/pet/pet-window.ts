import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { is } from '@electron-toolkit/utils';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { app, BrowserWindow, screen } from '../platform/electron';
import { SettingsRepository } from '../db/repositories/settings.repo';
import type { SettingsRecord } from '../../shared/types';

// Mesmo polyfill do index.ts: o main é ESM e não tem __dirname nativo.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Desktop pet — janela flutuante always-on-top com o status dos agentes
 * (docs/DESKTOP_PET.md). Este módulo é o dono do ciclo de vida da janela:
 * criar/destruir, click-through, restaurar/persistir posição.
 *
 * Importa Electron via platform shim (com guards): os handlers IPC deste
 * módulo são registrados também no CLI Node puro — lá tudo vira no-op
 * (o gateway já responde 403 nos canais pet:* antes de chegar aqui).
 */

/** Área útil da janela: sprite ancorado no canto inferior direito, espaço
 *  acima reservado pros cards de notificação (Fase 2). */
const PET_WINDOW_WIDTH = 360;
const PET_WINDOW_HEIGHT = 480;
/** Margem do canto da tela na posição default. */
const DEFAULT_MARGIN = 24;
/** Debounce da persistência de posição no 'moved' (arrasto emite dezenas de eventos). */
const SAVE_BOUNDS_DEBOUNCE_MS = 500;

let petWindowRef: ElectronBrowserWindow | null = null;
let saveBoundsTimer: NodeJS.Timeout | null = null;
/** Notifica o index.ts (Tray) quando o pet liga/desliga, pra reconstruir o menu. */
let enabledListener: ((enabled: boolean) => void) | null = null;

export function onPetEnabledChanged(listener: (enabled: boolean) => void): void {
  enabledListener = listener;
}

export function isPetWindowOpen(): boolean {
  return petWindowRef !== null && !petWindowRef.isDestroyed();
}

/** Posição inicial: a última salva, se o display ainda existir e o ponto ainda
 *  cair dentro dele (monitor pode ter sido desconectado/reorganizado); senão
 *  canto inferior direito da área de trabalho do display primário. */
function resolveInitialPosition(): { x: number; y: number } {
  const fallback = (): { x: number; y: number } => {
    const area = screen!.getPrimaryDisplay().workArea;
    return {
      x: area.x + area.width - PET_WINDOW_WIDTH - DEFAULT_MARGIN,
      y: area.y + area.height - PET_WINDOW_HEIGHT - DEFAULT_MARGIN,
    };
  };
  try {
    const saved = new SettingsRepository().get().pet.bounds;
    if (!saved) return fallback();
    const display = screen!.getAllDisplays().find((d) => d.id === saved.displayId);
    if (!display) return fallback();
    const { x, y, width, height } = display.bounds;
    const inside =
      saved.x >= x - PET_WINDOW_WIDTH &&
      saved.x <= x + width &&
      saved.y >= y &&
      saved.y <= y + height;
    return inside ? { x: saved.x, y: saved.y } : fallback();
  } catch {
    return fallback();
  }
}

function scheduleSaveBounds(win: ElectronBrowserWindow): void {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null;
    try {
      if (win.isDestroyed()) return;
      const bounds = win.getBounds();
      const displayId = screen!.getDisplayMatching(bounds).id;
      // Partial<SettingsRecord> só torna as chaves de topo opcionais — o
      // sub-objeto vai inteiro, já mesclado (mesma convenção do settingsStore).
      const repo = new SettingsRepository();
      const pet = repo.get().pet;
      repo.update({ pet: { ...pet, bounds: { x: bounds.x, y: bounds.y, displayId } } });
    } catch {
      // best-effort: perder a posição não pode quebrar o pet
    }
  }, SAVE_BOUNDS_DEBOUNCE_MS);
}

export function createPetWindow(): void {
  if (!BrowserWindow || !screen) return; // Node puro (CLI) — no-op
  if (isPetWindowOpen()) return;

  const { x, y } = resolveInitialPosition();
  const win = new BrowserWindow({
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
    x,
    y,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Nunca rouba foco do app onde o usuário está — cliques ainda funcionam.
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // O pet precisa reagir a eventos com o usuário em outro app.
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  petWindowRef = win;

  // Acima de apps em tela cheia + presente em todos os Spaces (macOS).
  // skipTransformProcessType é OBRIGATÓRIO: sem ele o setVisibleOnAllWorkspaces
  // troca a activation policy do app (Regular↔Accessory), e o app principal
  // também alterna o Dock (hydrate/close) — cada flip faz o macOS ESCONDER a
  // janela do pet segundos depois de criada ("aparece e some").
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  // Click-through por padrão: o pet não pode bloquear a tela. O renderer liga a
  // interação (pet:set-ignore-mouse false) no mouseenter das áreas clicáveis —
  // forward:true mantém os mousemove chegando pro renderer detectar o hover.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.on('moved', () => scheduleSaveBounds(win));
  win.on('closed', () => {
    if (petWindowRef === win) petWindowRef = null;
  });
  // Diagnóstico: o pet NUNCA deve sumir sozinho — se sumir, o motivo aparece
  // no terminal do dev com o prefixo [pet].
  win.on('hide', () => console.warn('[pet] janela escondida (hide)'));
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[pet] renderer do pet morreu:', details.reason);
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.warn('[pet console]', message);
  });
  win.on('ready-to-show', () => {
    // showInactive: aparecer sem ativar/roubar o foco do app atual.
    win.showInactive();
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pet.html`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/pet.html'));
  }
}

export function destroyPetWindow(): void {
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = null;
  }
  if (isPetWindowOpen()) petWindowRef!.destroy();
  petWindowRef = null;
}

/** Click-through da janela (chamado pelo renderer do pet via IPC). */
export function setPetIgnoreMouse(ignore: boolean): void {
  if (!isPetWindowOpen()) return;
  petWindowRef!.setIgnoreMouseEvents(ignore, { forward: true });
}

/** Liga/desliga o pet: persiste a preferência e cria/destrói a janela.
 *  Fonte única usada pelo Tray, pelas Configurações (via IPC) e pelo boot. */
export function setPetEnabled(enabled: boolean): void {
  try {
    const repo = new SettingsRepository();
    repo.update({ pet: { ...repo.get().pet, enabled } });
  } catch {
    // sem DB (boot muito cedo) — segue só com a janela
  }
  if (enabled) createPetWindow();
  else destroyPetWindow();
  enabledListener?.(enabled);
}

/**
 * Clique num card/menu do pet: traz a janela principal pro foreground e manda
 * o renderer principal navegar (`app:navigate`) e/ou abrir as Configurações
 * (`app:open-settings` — mesmo evento que o Tray usa). Best-effort, nunca lança.
 */
export function openTargetFromPet(hash: string | null, openSettings?: boolean): void {
  if (!BrowserWindow) return;
  try {
    const petId = petWindowRef && !petWindowRef.isDestroyed() ? petWindowRef.id : null;
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.id !== petId);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (process.platform === 'darwin') {
      void app?.dock?.show().catch(() => {});
      app?.focus({ steal: true });
    }
    if (hash) win.webContents.send('app:navigate', { hash });
    if (openSettings) win.webContents.send('app:open-settings');
  } catch {
    // ignore
  }
}

/** Settings mudaram (qualquer settings:update): avisa o renderer do pet pra
 *  aplicar tamanho/som/filtros ao vivo. Send direcionado — só o pet recebe. */
export function notifyPetSettingsChanged(record: SettingsRecord): void {
  if (!isPetWindowOpen()) return;
  petWindowRef!.webContents.send('pet:settings-changed', record.pet);
}

/** Boot: cria o pet se o usuário deixou ligado na última sessão. */
export function initPetWindowFromSettings(): void {
  if (!BrowserWindow) return;
  try {
    if (new SettingsRepository().get().pet.enabled) createPetWindow();
  } catch {
    // settings indisponíveis — pet fica desligado
  }
}
