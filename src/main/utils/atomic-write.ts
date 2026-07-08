import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Escrita atômica de arquivo do usuário: grava num temporário no MESMO diretório
 * do alvo e renomeia por cima. Um crash no meio da gravação deixa o arquivo
 * original intacto (o `rename` é atômico no mesmo filesystem), em vez de truncar
 * o arquivo do usuário como faria um `writeFileSync` direto.
 *
 * Em EXDEV (alvo num filesystem diferente, onde o rename atômico não vale) cai
 * pra escrita direta — o melhor possível nesse caso.
 */
export function atomicWriteFileSync(
  filePath: string,
  data: string | Buffer,
  encoding: BufferEncoding = 'utf-8',
): void {
  const tmpPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmpPath, data, encoding);
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Cross-device (alvo em outro filesystem): rename atômico não é possível.
    if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
      writeFileSync(filePath, data, encoding);
    }
    // Limpa o temporário órfão (best-effort) antes de propagar/retornar.
    try {
      unlinkSync(tmpPath);
    } catch {
      // temporário já removido (caminho feliz) ou inacessível — ignora.
    }
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
    return;
  }
}
