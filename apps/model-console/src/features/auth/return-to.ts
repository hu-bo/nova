/** Only restore console routes; auth endpoints would cause redirect loops. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) {
    return "/providers";
  }
  const target = new URL(value, "https://console.invalid");
  const path = target.pathname.replace(/\/+$/, "");
  return path === "/login" || path === "/callback" ? "/providers" : `${target.pathname}${target.search}${target.hash}`;
}
