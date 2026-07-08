export interface FeedLine {
  ts: number;
  text: string;
}

export class FeedBuffer {
  private buf: FeedLine[] = [];

  constructor(private cap: number) {}

  push(line: FeedLine): void {
    this.buf.push(line);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
  }

  lines(): readonly FeedLine[] {
    return this.buf;
  }
}
