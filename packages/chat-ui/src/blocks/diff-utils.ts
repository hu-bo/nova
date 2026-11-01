import { structuredPatch } from "diff";
import type { CodeChange } from "../types.js";

/**
 * 相邻变更块之间保留的上下文行数。未变更的区域不会进入 patch，因此也不会被渲染，
 * 大文件里审批者只能看到真正改动的那几块。
 */
const contextLines = 3;

/** 把一次文本替换折算成 unified patch 与真实的增删行数。 */
export function unifiedPatchOf(change: CodeChange): { diff: string; added: number; removed: number } {
  const { hunks } = structuredPatch(change.path, change.path, change.oldText, change.newText, "", "", {
    context: contextLines,
  });
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  const diff = hunks
    .map((hunk) =>
      [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join("\n"),
    )
    .join("\n");
  return { diff, added, removed };
}
