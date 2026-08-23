// 增量 UTF-8 解码（docs/runner-sdk.md §5）：跨 chunk 保留多字节序列。
import { describe, expect, it } from "vitest";
import { Utf8Decoder } from "../src/decode.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("Utf8Decoder", () => {
  it("decodes plain ASCII", () => {
    const decoder = new Utf8Decoder();
    expect(decoder.decode(bytes("hello"))).toBe("hello");
    expect(decoder.flush()).toBe("");
  });

  it("holds a 3-byte sequence split across chunks", () => {
    const decoder = new Utf8Decoder();
    const [b0, b1, b2] = bytes("你"); // E4 BD A0
    expect(decoder.decode(new Uint8Array([b0!]))).toBe("");
    expect(decoder.decode(new Uint8Array([b1!, b2!]))).toBe("你");
    expect(decoder.flush()).toBe("");
  });

  it("holds a 4-byte sequence split 2+2", () => {
    const decoder = new Utf8Decoder();
    const emoji = bytes("😀"); // F0 9F 98 80
    expect(decoder.decode(emoji.slice(0, 2))).toBe("");
    expect(decoder.decode(emoji.slice(2))).toBe("😀");
  });

  it("reassembles text interleaved with multibyte boundaries", () => {
    const decoder = new Utf8Decoder();
    const full = bytes("a你b😀c");
    let out = "";
    for (let i = 0; i < full.length; i += 1) {
      out += decoder.decode(full.slice(i, i + 1));
    }
    out += decoder.flush();
    expect(out).toBe("a你b😀c");
  });

  it("flush replaces a dangling incomplete sequence", () => {
    const decoder = new Utf8Decoder();
    const [b0] = bytes("你");
    expect(decoder.decode(new Uint8Array([b0!]))).toBe("");
    expect(decoder.flush()).toBe("�");
  });
});
