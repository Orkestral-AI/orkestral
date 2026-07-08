import qrcode from 'qrcode-terminal';

/**
 * Renderiza o QR (string crua do canal) como STRING, pra desenhar DENTRO da
 * árvore do Ink (`<Text>{qr}</Text>`). O callback do qrcode-terminal é síncrono,
 * então o retorno é imediato. Imprimir via console dentro do Ink é proibido —
 * os redraws do Ink duplicam/atropelam o QR.
 */
export function qrToString(data: string): string {
  let out = '';
  qrcode.generate(data, { small: true }, (code) => {
    out = code;
  });
  return out;
}

/** Imprime o QR direto no terminal — SÓ pra contextos fora do Ink. */
export function printQr(data: string): void {
  qrcode.generate(data, { small: true });
}
