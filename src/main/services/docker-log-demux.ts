/** Converte um buffer do stream de logs do Docker em texto.
 *  - tty=true: stream é texto cru.
 *  - tty=false (default): frames multiplexados [stream(1)][000][size(4 BE)][payload]. */
export function demuxDockerStream(buf: Buffer, opts: { tty?: boolean } = {}): string {
  if (opts.tty) return buf.toString('utf8');
  let out = '';
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buf.length) break; // frame incompleto — para (chunk parcial)
    out += buf.subarray(start, end).toString('utf8');
    offset = end;
  }
  return out;
}
