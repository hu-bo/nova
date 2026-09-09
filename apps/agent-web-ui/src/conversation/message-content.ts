import type { Block, SendMessage } from "@nova/protocol";

interface Attachment {
  key: string;
  name: string;
  mimeType: string;
  size?: number;
  url?: string | undefined;
}

export function isImageAttachment(file: { name: string; mimeType: string }): boolean {
  return file.mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)$/i.test(file.name);
}

export function validateImageAttachments(
  files: { name: string; mimeType: string; size?: number }[],
  supportsImages: boolean,
): void {
  const images = files.filter(isImageAttachment);
  if (images.length > 4) throw new Error("每条消息最多发送 4 张图片");
  if (images.length && !supportsImages) throw new Error("当前模型不支持图片，请选择支持图片的模型");
  for (const file of images) {
    const supported =
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mimeType) ||
      ((!file.mimeType || file.mimeType === "application/octet-stream") && /\.(png|jpe?g|gif|webp)$/i.test(file.name));
    if (!supported) throw new Error("图片格式不支持，请使用 PNG、JPEG、GIF 或 WebP");
    if ((file.size ?? 0) > 5 * 1024 * 1024) throw new Error("每张图片不能超过 5 MiB");
  }
}

export function messageContent(
  text: string,
  files: Attachment[],
  supportsImages: boolean,
): Pick<SendMessage, "text" | "images"> & { blocks: Block[] } {
  validateImageAttachments(files, supportsImages);
  const images = files.filter(isImageAttachment);
  const links = files
    .filter((file) => !isImageAttachment(file))
    .map((file) => `[附件：${file.name.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${file.url})`)
    .join("\n");
  const content = [text, links].filter(Boolean).join("\n\n");
  return {
    text: content,
    ...(images.length ? { images: images.map(({ key, name }) => ({ key, name })) } : {}),
    blocks: [
      ...(content ? [{ type: "text" as const, text: content }] : []),
      ...images.map(({ key, name, mimeType, url }): Block => ({
        type: "image",
        key,
        name,
        mimeType,
        ...(url ? { url } : {}),
      })),
    ],
  };
}
