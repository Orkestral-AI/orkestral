/**
 * Extrai o URI de device-link (`sgnl://linkdevice?...`) da saída do
 * `signal-cli link`. Esse URI é renderizado como QR pro usuário escanear em
 * Signal > Dispositivos vinculados > Vincular novo dispositivo. Função pura.
 */
export function extractLinkUri(stdout: string): string | null {
  const m = stdout.match(/sgnl:\/\/linkdevice\?\S+/);
  return m ? m[0].trim() : null;
}
