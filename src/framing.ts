// LSP base protocol framing: "Content-Length: N\r\n\r\n<json>".

export type Message = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export function encode(msg: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([head, body]);
}

/** Feed bytes in, get whole messages out. */
export class Decoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Message[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: Message[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Unparseable header: drop it and resync.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) break;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      try {
        out.push(JSON.parse(body));
      } catch {
        // skip malformed body
      }
    }
    return out;
  }
}

/**
 * Bun socket writes can be partial: write() returns how many bytes went out
 * and drops the rest. This queues the remainder and flushes it on drain.
 */
export class SocketWriter {
  private queue: Uint8Array[] = [];
  constructor(private readonly sock: { write(b: Uint8Array): number }) {}
  write(bytes: Uint8Array) {
    if (this.queue.length) {
      this.queue.push(bytes);
      return;
    }
    const n = this.sock.write(bytes);
    if (n < bytes.length) this.queue.push(bytes.subarray(Math.max(n, 0)));
  }
  /** Call from the socket's drain handler. */
  drain() {
    while (this.queue.length) {
      const head = this.queue[0];
      const n = this.sock.write(head);
      if (n < head.length) {
        this.queue[0] = head.subarray(Math.max(n, 0));
        return;
      }
      this.queue.shift();
    }
  }
}
