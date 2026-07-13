import { is } from '@electron-toolkit/utils';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { app, BrowserWindow, screen } from '../platform/electron';
import { SettingsRepository } from '../db/repositories/settings.repo';
import type { SettingsRecord } from '../../shared/types';

/**
 * Paths do preload e do pet.html de PROD, injetados pelo index.ts no boot.
 *
 * NÃO usar __dirname aqui: o main tem duas entries (index + cli) e este módulo
 * é importado pelas duas — o rollup o move pra um chunk compartilhado
 * (out/main/chunks/), onde import.meta.url aponta pro CHUNK e `../preload`
 * resolveria pra out/main/preload (não existe). Foi exatamente esse bug que
 * deixava a janela do pet em branco: preload não carregava, window.orkestral
 * não existia e o renderer morria mudo. O index.ts (entry raiz, posição
 * estável em out/main/) é quem sabe os paths reais.
 */
interface PetWindowPaths {
  preload: string;
  prodHtml: string;
}
let petPaths: PetWindowPaths | null = null;

export function configurePetWindow(paths: PetWindowPaths): void {
  petPaths = paths;
}

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
 *  canto inferior direito da área de trabalho do display primário.
 *
 *  `pet.bounds` guarda o CANTO INFERIOR DIREITO (âncora): a janela muda de
 *  tamanho conforme o conteúdo (pet:resize), então o top-left não é estável
 *  entre sessões — a âncora é. */
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
    const inside = saved.x >= x && saved.x <= x + width && saved.y >= y && saved.y <= y + height;
    if (!inside) return fallback();
    return { x: saved.x - PET_WINDOW_WIDTH, y: saved.y - PET_WINDOW_HEIGHT };
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
      // Âncora = canto inferior direito (ver resolveInitialPosition).
      const anchorX = bounds.x + bounds.width;
      const anchorY = bounds.y + bounds.height;
      // Partial<SettingsRecord> só torna as chaves de topo opcionais — o
      // sub-objeto vai inteiro, já mesclado (mesma convenção do settingsStore).
      const repo = new SettingsRepository();
      const pet = repo.get().pet;
      repo.update({ pet: { ...pet, bounds: { x: anchorX, y: anchorY, displayId } } });
    } catch {
      // best-effort: perder a posição não pode quebrar o pet
    }
  }, SAVE_BOUNDS_DEBOUNCE_MS);
}

export function createPetWindow(): void {
  if (!BrowserWindow || !screen || !petPaths) return; // Node puro (CLI) — no-op
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
      preload: petPaths.preload,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // O pet precisa reagir a eventos com o usuário em outro app.
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  petWindowRef = win;

  // Nível 'floating': acima das janelas normais MAS visível em screenshot —
  // 'screen-saver' era tratado como overlay de sistema e ficava fora dos
  // prints do usuário. Preço: app em tela cheia pode cobrir o pet.
  // skipTransformProcessType é OBRIGATÓRIO: sem ele o setVisibleOnAllWorkspaces
  // troca a activation policy do app (Regular↔Accessory), e o app principal
  // também alterna o Dock (hydrate/close) — cada flip faz o macOS ESCONDER a
  // janela do pet segundos depois de criada ("aparece e some").
  win.setAlwaysOnTop(true, 'floating');
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
    void win.loadFile(petPaths.prodHtml);
  }
}

export function destroyPetWindow(): void {
  endPetDrag();
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = null;
  }
  if (isPetWindowOpen()) petWindowRef!.destroy();
  petWindowRef = null;
}

/**
 * Drag manual: gruda a janela no cursor (offset travado no início) num polling
 * de ~80fps até o drag-end. Como a janela segue o cursor, o mouseup sempre cai
 * dentro dela — é o padrão robusto pra drag de frameless SEM app-region (que
 * engoliria o clique que abre o menu).
 */
let dragTimer: NodeJS.Timeout | null = null;

export function startPetDrag(): void {
  if (!isPetWindowOpen() || !screen || dragTimer) return;
  const win = petWindowRef!;
  const cursor = screen.getCursorScreenPoint();
  const [winX, winY] = win.getPosition();
  const offsetX = cursor.x - winX;
  const offsetY = cursor.y - winY;
  dragTimer = setInterval(() => {
    if (win.isDestroyed()) {
      endPetDrag();
      return;
    }
    const c = screen!.getCursorScreenPoint();
    win.setPosition(c.x - offsetX, c.y - offsetY, false);
  }, 12);
}

export function endPetDrag(): void {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (isPetWindowOpen()) scheduleSaveBounds(petWindowRef!);
}

/** Janela abraça o conteúdo: o renderer mede o que está na tela (boneco, cards,
 *  menu) e pede o tamanho; o main redimensiona MANTENDO o canto inferior
 *  direito parado. Sem isso a janela fixa 360x480 vira uma área invisível
 *  gigante que engole cliques ("quadrado oculto" à esquerda do pet). */
export function resizePetWindow(width: number, height: number): void {
  if (!isPetWindowOpen() || dragTimer) return; // durante o drag quem manda é o cursor
  const win = petWindowRef!;
  const b = win.getBounds();
  const w = Math.min(Math.max(Math.round(width), 132), 400);
  const h = Math.min(Math.max(Math.round(height), 148), 560);
  if (w === b.width && h === b.height) return;
  win.setBounds({ x: b.x + b.width - w, y: b.y + b.height - h, width: w, height: h });
}

/**
 * Clicar no pet ATIVA o app no macOS, e o handler de `app.on('activate')`
 * (feito pro clique no Dock) puxaria a janela principal pra frente — exatamente
 * o que o usuário NÃO quer ao mexer só no pet. Checagem determinística: se o
 * cursor está dentro dos bounds do pet no momento do activate, a ativação veio
 * do pet (clique que atravessa a área vazia nem ativa o app — vai pro app de
 * baixo). Clique no Dock acontece com o cursor no Dock → nunca suprimido.
 */
export function isCursorOverPet(): boolean {
  if (!isPetWindowOpen() || !screen) return false;
  try {
    const c = screen.getCursorScreenPoint();
    const b = petWindowRef!.getBounds();
    return c.x >= b.x && c.x <= b.x + b.width && c.y >= b.y && c.y <= b.y + b.height;
  } catch {
    return false;
  }
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
