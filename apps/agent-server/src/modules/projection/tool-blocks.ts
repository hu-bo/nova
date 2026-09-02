import type { Block } from "@nova/protocol";

type CodeChange = { path: string; oldText: string; newText: string };

export function projectToolDetails(toolName: string, details: unknown, codeChanges: CodeChange[] = []): Block[] {
  const data = object(details);
  switch (toolName) {
    case "read_file":
      return [
        {
          type: "code",
          language: languageOf(text(data.path)),
          code: text(data.text),
          ...(typeof data.path === "string" ? { path: data.path } : {}),
          ...(positiveInteger(data.offset) ? { startLine: data.offset as number } : {}),
        },
      ];
    case "edit_file":
    case "git_diff":
    case "write_file":
      if (codeChanges.length > 0 && (toolName === "edit_file" || toolName === "write_file")) {
        return codeChanges.map((change) => ({
          type: "diff",
          path: change.path,
          diff: unifiedDiff(change.oldText, change.newText),
          added: lineCount(change.newText),
          removed: lineCount(change.oldText),
        }));
      }
      if (typeof data.diff === "string" && typeof data.path === "string") {
        return [
          {
            type: "diff",
            path: data.path,
            diff: data.diff,
            added: nonnegativeInteger(data.added),
            removed: nonnegativeInteger(data.removed),
          },
        ];
      }
      break;
    case "bash": {
      const blocks: Block[] = [];
      if (typeof data.stdout === "string" && data.stdout)
        blocks.push({ type: "code", language: "text", code: data.stdout });
      if (typeof data.stderr === "string" && data.stderr)
        blocks.push({ type: "error", code: "STDERR", message: data.stderr });
      if (blocks.length > 0) return blocks;
      break;
    }
    case "todo_write":
      if (Array.isArray(data.items)) return [{ type: "todo", items: data.items as never[] }];
      break;
  }
  return [{ type: "text", text: safeStringify(details) }];
}

function unifiedDiff(oldText: string, newText: string): string {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  return [
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function languageOf(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return (
    (
      {
        ts: "typescript",
        tsx: "tsx",
        js: "javascript",
        jsx: "jsx",
        rs: "rust",
        py: "python",
        json: "json",
        md: "markdown",
      } as Record<string, string>
    )[extension ?? ""] ?? "text"
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "Tool completed, but its details could not be displayed";
  }
}
