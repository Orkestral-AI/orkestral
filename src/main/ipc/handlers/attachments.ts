import { BrowserWindow, dialog } from '../../platform/electron';
import type { OpenDialogOptions } from 'electron';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerHandler } from '../register';
import { ORKESTRAL_ATTACHMENTS_DIR } from '../../db/connection';
import { openPathSafe } from '../../utils/safe-shell';
import type { IssueAttachment } from '../../../shared/types';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
};

function mimeOf(file: string): string {
  return MIME_BY_EXT[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function registerAttachmentHandlers(): void {
  // Abre o seletor do SO, copia os arquivos escolhidos pra pasta de anexos e
  // devolve a metadata. Não persiste em DB — o renderer guarda e manda junto
  // com o comentário/decisão.
  registerHandler('attachment:add-files', async () => {
    if (!dialog) throw new Error('Seletor de arquivos disponível apenas no app desktop.');
    const win = BrowserWindow?.getFocusedWindow();
    const opts: OpenDialogOptions = {
      title: 'Anexar arquivos',
      properties: ['openFile', 'multiSelections'],
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return { attachments: [] };

    mkdirSync(ORKESTRAL_ATTACHMENTS_DIR, { recursive: true });
    const attachments: IssueAttachment[] = [];
    for (const src of result.filePaths) {
      const id = randomUUID();
      const name = basename(src);
      const dest = join(ORKESTRAL_ATTACHMENTS_DIR, `${id}__${name}`);
      copyFileSync(src, dest);
      attachments.push({
        id,
        fileName: name,
        mimeType: mimeOf(name),
        sizeBytes: statSync(dest).size,
        path: dest,
      });
    }
    return { attachments };
  });

  // Abre um anexo no app padrão do SO.
  registerHandler('attachment:open', async ({ path }) => {
    // Contém a abertura ao diretório de anexos — sem isto o renderer abriria um path
    // ARBITRÁRIO do SO (agravado por webviewTag:true). openPathSafe rejeita traversal/absoluto.
    const ok = await openPathSafe(path, { withinRoot: ORKESTRAL_ATTACHMENTS_DIR });
    return { ok };
  });
}
