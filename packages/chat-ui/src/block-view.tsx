import type { Block } from "@nova/protocol";
import { CodeBlock } from "./blocks/code.js";
import { DiffBlock } from "./blocks/diff.js";
import { ErrorBlock } from "./blocks/error.js";
import { FileBlock } from "./blocks/file.js";
import { TextBlock } from "./blocks/text.js";
import { ThinkingBlock } from "./blocks/thinking.js";
import { TodoList } from "./blocks/todo.js";
import { ToolBlock } from "./blocks/tool.js";
import type { BlockRenderers } from "./types.js";

export interface BlockViewProps {
  block: Block;
  renderers?: BlockRenderers | undefined;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
}

export function BlockView({ block, renderers, onOpenPath }: BlockViewProps) {
  const CustomRenderer = renderers?.[block.type];
  if (CustomRenderer) return <CustomRenderer block={block} {...(onOpenPath ? { onOpenPath } : {})} />;

  switch (block.type) {
    case "text": return <TextBlock text={block.text} />;
    case "thinking": return <ThinkingBlock text={block.text} />;
    case "code": return <CodeBlock {...block} {...(onOpenPath ? { onOpenPath } : {})} />;
    case "diff": return <DiffBlock {...block} {...(onOpenPath ? { onOpenPath } : {})} />;
    case "file": return <FileBlock {...block} {...(onOpenPath ? { onOpenPath } : {})} />;
    case "todo": return <TodoList items={block.items} />;
    case "error": return <ErrorBlock code={block.code} message={block.message} />;
    case "tool_call": return block.name === "todo_write" ? null : <ToolBlock call={block} />;
    case "tool_result": return <div data-tool-result={block.callId}>{block.blocks.map((child, index) => <BlockView block={child} renderers={renderers} {...(onOpenPath ? { onOpenPath } : {})} key={index} />)}</div>;
  }
}
