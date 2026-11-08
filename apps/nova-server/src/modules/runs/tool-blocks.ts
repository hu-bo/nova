import type { Content, JsonValue } from "@nova/agent-ui-contracts";

/** 展示层截断上限；模型侧与操作日志（stdout/stderr）仍保留完整输出。 */
const MAX_TOOL_TEXT = 12_000;

function truncate(value: string): string {
  if (value.length <= MAX_TOOL_TEXT) return value;
  return `${value.slice(0, MAX_TOOL_TEXT)}\n\n… 已省略 ${value.length - MAX_TOOL_TEXT} 个字符`;
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  rs: "rust",
  py: "python",
  json: "json",
  md: "markdown",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  css: "css",
  html: "html",
};

function languageOf(path: string | undefined): string {
  const extension = path?.split(".").pop()?.toLowerCase();
  return LANGUAGES[extension ?? ""] ?? "text";
}

function safeStringify(value: JsonValue): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "Tool completed, but its result could not be displayed";
  }
}

/**
 * 把工具输出投影为可渲染的内容块，不再直接展示 `{"status","content","details"}` 信封 JSON。
 * - packages/tools 的成功信封优先投影为结构化内容块，其余结果展示 content。
 * - 运行时失败结果 `{error:{code,message}}` 投影为错误块。
 * - 其它自定义输出回退为截断后的 JSON 文本。
 */
export function projectToolContent(name: string, value: JsonValue): Content[] {
  const envelope = record(value);
  const failure = record(envelope?.error);
  if (failure && typeof failure.code === "string" && typeof failure.message === "string")
    return [{ id: "content", type: "error", error: { code: failure.code, message: truncate(failure.message) } }];
  // Spec candidates remain complete in checkpoints; chat shows only their product status.
  if (name === "spec_read") return [{ id: "content", type: "text", text: "已读取当前规格，继续讨论需求与方案。" }];
  if (name === "spec_update") return [{ id: "content", type: "text", text: "已提交规格草稿，运行完成后校验并保存。" }];
  const content =
    envelope && (envelope.status === "ok" || envelope.status === "error") ? text(envelope.content) : undefined;
  if (content === undefined)
    return [{ id: "content", type: "text", text: truncate(typeof value === "string" ? value : safeStringify(value)) }];
  const details = record(envelope?.details);
  switch (name) {
    case "edit_file":
    case "write_file": {
      if (envelope?.status !== "ok") break;
      const path = text(details?.path);
      const diff = text(details?.patch);
      if (path && diff && diff.length <= MAX_TOOL_TEXT) return [{ id: "content", type: "diff", path, diff }];
      if (details?.patch === null || (diff && diff.length > MAX_TOOL_TEXT))
        return [{ id: "content", type: "text", text: truncate(`${content}\n\n… 文件改动过大，无法预览`) }];
      break;
    }
    case "read_file": {
      const path = text(details?.path);
      const body = text(details?.text);
      if (body !== undefined)
        return [
          {
            id: "content",
            type: "code",
            language: languageOf(path),
            code: truncate(body),
            ...(path === undefined ? {} : { path }),
          },
        ];
      break;
    }
    case "bash": {
      const stdout = text(details?.stdout);
      const stderr = text(details?.stderr);
      const blocks: Content[] = [];
      if (stdout) blocks.push({ id: "content:stdout", type: "code", language: "text", code: truncate(stdout) });
      if (stderr)
        blocks.push({ id: "content:stderr", type: "error", error: { code: "STDERR", message: truncate(stderr) } });
      if (blocks.length > 0) return blocks;
      break;
    }
    case "git_diff": {
      const path = text(details?.path);
      return [
        {
          id: "content",
          type: "code",
          language: "diff",
          code: truncate(content),
          ...(path === undefined ? {} : { path }),
        },
      ];
    }
  }
  return [{ id: "content", type: "text", text: truncate(content) }];
}
