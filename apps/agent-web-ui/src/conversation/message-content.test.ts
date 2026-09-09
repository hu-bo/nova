import { describe, expect, it } from "vitest";
import { SendMessageSchema } from "@nova/protocol";
import { messageContent } from "./message-content.js";

const image = {
  key: "uploads/alice/image.png",
  name: "截图.png",
  mimeType: "image/png",
  size: 100,
  url: "https://storage.example/image.png",
};

describe("image message content", () => {
  it("keeps images structured and ordinary attachments as links", () => {
    const result = messageContent(
      "分析这张图",
      [image, { ...image, key: "note", name: "note.txt", mimeType: "text/plain" }],
      true,
    );
    expect(result.images).toEqual([{ key: image.key, name: image.name }]);
    expect(result.text).toContain("[附件：note.txt]");
    expect(result.text).not.toContain("截图.png");
    expect(result.blocks[1]).toMatchObject({ type: "image", key: image.key, url: image.url });
  });
  it("accepts image-only input and retries without uploading again or depending on an old URL", () => {
    const first = messageContent("", [image], true);
    const retry = messageContent(
      "",
      first.blocks.filter((block) => block.type === "image").map(({ url: _url, ...block }) => block),
      true,
    );
    expect(SendMessageSchema.parse({ text: retry.text, images: retry.images })).toEqual({
      text: "",
      images: first.images,
    });
    expect(SendMessageSchema.safeParse({ text: "", images: [] }).success).toBe(false);
    expect(SendMessageSchema.safeParse({ text: "hi", images: Array(5).fill(first.images![0]) }).success).toBe(false);
  });
  it("recognizes images with missing browser MIME and refuses unsupported models, types and sizes", () => {
    expect(messageContent("", [{ ...image, mimeType: "application/octet-stream" }], true).images).toHaveLength(1);
    expect(() => messageContent("", [image], false)).toThrow("当前模型不支持图片");
    expect(() => messageContent("", [{ ...image, size: 5 * 1024 * 1024 + 1 }], true)).toThrow("5 MiB");
    expect(() => messageContent("", [{ ...image, name: "a.svg", mimeType: "image/svg+xml" }], true)).toThrow(
      "图片格式不支持",
    );
    expect(() => messageContent("", Array(5).fill(image), true)).toThrow("4 张");
  });
});
