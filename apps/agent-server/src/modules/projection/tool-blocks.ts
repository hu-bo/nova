import type { Block } from "@nova/protocol";

export function projectToolDetails(toolName: string, details: unknown): Block[] {
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
    case "list_dir": {
      if (Array.isArray(data.entries)) {
        return data.entries.flatMap((entry) => {
          const item = object(entry);
          if (typeof item.name !== "string" || (item.kind !== "file" && item.kind !== "dir")) return [];
          return [{ type: "file", path: item.name, kind: item.kind } satisfies Block];
        });
      }
      break;
    }
    case "grep": {
      if (Array.isArray(data.matches)) {
        return data.matches.flatMap((match) => {
          const item = object(match);
          return typeof item.file === "string" ? [{ type: "file", path: item.file, kind: "file" } satisfies Block] : [];
        });
      }
      break;
    }
    case "todo_write":
      if (Array.isArray(data.items)) return [{ type: "todo", items: data.items as never[] }];
      break;
  }
  return [{ type: "text", text: safeStringify(details) }];
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
