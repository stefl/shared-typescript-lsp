import { expect, test } from "bun:test";
import { Decoder, encode } from "../src/framing.ts";

test("decodes messages split across chunks and joined in one", () => {
  const a = encode({ jsonrpc: "2.0", id: 1, method: "x", params: { s: "é" } });
  const b = encode({ jsonrpc: "2.0", method: "y" });
  const all = Buffer.concat([a, b]);
  const d = new Decoder();
  expect(d.push(all.subarray(0, 10))).toEqual([]);
  const out = d.push(all.subarray(10));
  expect(out.map((m) => m.method)).toEqual(["x", "y"]);
  expect((out[0].params as any).s).toBe("é");
});
