// 增量 UTF-8 解码（docs/runner-sdk.md §5）：Runner 传原始 bytes，解码在消费端。
// TextDecoder 的 stream 模式会在内部保留跨 chunk 的不完整多字节序列，
// 下一次 decode 时拼接 —— 这正是"跨 chunk 保留多字节序列"的语义。
export class Utf8Decoder {
  private readonly decoder = new TextDecoder("utf-8");

  decode(chunk: Uint8Array): string {
    return this.decoder.decode(chunk, { stream: true });
  }

  // 流结束时冲刷残留字节（不完整的尾部序列会变成替换字符）
  flush(): string {
    return this.decoder.decode();
  }
}
