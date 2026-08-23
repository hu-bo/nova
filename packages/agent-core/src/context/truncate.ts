// §8 输出截断 —— 策略在 agent-core，不在 tools：单个 tool content 上限（缺省 30_000 字符），
// 超出保头尾、中间省略并标注省略行数。details 不截断。
import type { ContentPart } from "../types.js";

export const DEFAULT_CONTENT_LIMIT = 30_000;

export function truncateContent(content: ContentPart[], limit: number = DEFAULT_CONTENT_LIMIT): ContentPart[] {
  const total = content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
  if (total <= limit) return content;

  const half = Math.floor(limit / 2);

  // 头部：顺序吃到 half 为止
  const head: ContentPart[] = [];
  let headChars = 0;
  let headEnd = { index: 0, offset: 0 };
  for (let i = 0; i < content.length; i += 1) {
    const part = content[i]!;
    if (part.type !== "text") { head.push(part); continue; }
    if (headChars + part.text.length <= half) {
      head.push(part);
      headChars += part.text.length;
      headEnd = { index: i + 1, offset: 0 };
      continue;
    }
    const take = half - headChars;
    if (take > 0) head.push({ type: "text", text: part.text.slice(0, take) });
    headEnd = { index: i, offset: take };
    break;
  }

  // 尾部：逆序吃到 half 为止
  const tail: ContentPart[] = [];
  let tailChars = 0;
  let tailStart = { index: content.length - 1, offset: 0 };
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const part = content[i]!;
    if (part.type !== "text") { tail.unshift(part); continue; }
    if (tailChars + part.text.length <= half) {
      tail.unshift(part);
      tailChars += part.text.length;
      tailStart = { index: i - 1, offset: 0 };
      continue;
    }
    const take = half - tailChars;
    if (take > 0) tail.unshift({ type: "text", text: part.text.slice(part.text.length - take) });
    tailStart = { index: i, offset: part.text.length - take };
    break;
  }

  // 中间被省略区域的行数
  let omittedLines = 0;
  for (let i = headEnd.index; i <= tailStart.index && i < content.length; i += 1) {
    const part = content[i]!;
    if (part.type !== "text") continue;
    let text = part.text;
    if (i === headEnd.index) text = text.slice(headEnd.offset);
    if (i === tailStart.index) text = i === headEnd.index ? text.slice(0, tailStart.offset - headEnd.offset) : text.slice(0, tailStart.offset);
    for (const char of text) if (char === "\n") omittedLines += 1;
  }

  return [...head, { type: "text", text: `\n… [中间省略 ${omittedLines} 行] …\n` }, ...tail];
}
