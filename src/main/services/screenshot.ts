import { BrowserWindow } from '../platform/electron';
import { writeFileSync } from 'node:fs';

/**
 * Captura uma URL (ex.: o dev server rodando) num PNG, abrindo uma janela OCULTA
 * que pinta mesmo sem ser exibida (`paintWhenInitiallyHidden`). Não depende do
 * painel de preview do app estar montado — é self-contained no main. Usado pela
 * tool MCP `capture_preview` pro agente "mandar um print da tela".
 */
export async function captureUrlToPng(url: string, outPath: string, waitMs = 1500): Promise<void> {
  // Renderizar página exige o Chromium do Electron — sem ele não há captura.
  if (!BrowserWindow) throw new Error('Captura de tela disponível apenas no app desktop.');
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: 1280,
    height: 820,
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });
  try {
    await win.loadURL(url);
    // Dá um tempo pro app hidratar/renderizar antes do snapshot.
    await new Promise((r) => setTimeout(r, Math.max(0, waitMs)));
    const image = await win.webContents.capturePage();
    writeFileSync(outPath, image.toPNG());
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
