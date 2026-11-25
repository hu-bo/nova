/** HTTPS 页面请求对象存储时，把服务端签名 URL 中的 HTTP 协议提升为 HTTPS。 */
export function secureAttachmentUrl(value: string): string {
  const url = new URL(value);
  if (globalThis.location?.protocol !== 'https:' || url.protocol !== 'http:') return value;
  url.protocol = 'https:';
  return url.href;
}
