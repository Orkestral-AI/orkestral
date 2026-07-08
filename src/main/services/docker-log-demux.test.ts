import { describe, it, expect } from 'vitest';
import { demuxDockerStream } from './docker-log-demux';

function frame(stream: number, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream; // 1=stdout, 2=stderr
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('demuxDockerStream', () => {
  it('extrai texto de frames multiplexados', () => {
    const buf = Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n')]);
    expect(demuxDockerStream(buf)).toBe('hello\noops\n');
  });

  it('trata stream com TTY (sem header) como texto cru', () => {
    const buf = Buffer.from('plain tty line\n', 'utf8');
    expect(demuxDockerStream(buf, { tty: true })).toBe('plain tty line\n');
  });
});
