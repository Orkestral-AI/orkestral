import { registerHandler } from '../register';
import { startPreview, stopPreview, getPreviewStatus } from '../../services/preview-manager';

/** Canais do preview: sobe/para o dev server do projeto gerado e devolve a URL pro painel. */
export function registerPreviewHandlers(): void {
  registerHandler('preview:start', (req) => startPreview(req.workspaceId));
  registerHandler('preview:stop', (req) => {
    stopPreview(req.workspaceId);
    return { ok: true as const };
  });
  registerHandler('preview:status', (req) => getPreviewStatus(req.workspaceId));
}
