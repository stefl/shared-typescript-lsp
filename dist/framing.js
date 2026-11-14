// Generated from src/framing.ts by scripts/build.ts. Edit the source, then rebuild.
// LSP base protocol framing: "Content-Length: N\r\n\r\n<json>".

                       
                 
                              
                  
                   
                   
                  
  

export function encode(msg         )             {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([head, body]);
}

/** Feed bytes in, get whole messages out. */
export class Decoder {
          buf         = Buffer.alloc(0);

  push(chunk            )            {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out            = [];
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
