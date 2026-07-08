import { BrowserWindow, dialog } from '../../platform/electron';
import type { OpenDialogOptions } from 'electron';
import { registerHandler } from '../register';

export function registerDialogHandlers(): void {
  registerHandler('dialog:open-directory', async (req) => {
    if (!dialog) throw new Error('Seletor de pastas disponível apenas no app desktop.');
    const focusedWindow = BrowserWindow?.getFocusedWindow();
    const opts: OpenDialogOptions = {
      title: req?.title ?? 'Selecionar pasta',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return { path: result.filePaths[0] };
  });

  registerHandler('dialog:open-file', async (req) => {
    if (!dialog) throw new Error('Seletor de arquivos disponível apenas no app desktop.');
    const focusedWindow = BrowserWindow?.getFocusedWindow();
    const opts: OpenDialogOptions = {
      title: req?.title ?? 'Selecionar arquivo',
      properties: ['openFile'],
      ...(req?.filters ? { filters: req.filters } : {}),
    };
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return { path: result.filePaths[0] };
  });
}
