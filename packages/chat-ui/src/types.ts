import type { Block } from "@nova/protocol";
import type { ReactNode } from "react";

export type ExtractBlock<T extends Block["type"]> = Extract<Block, { type: T }>;

export interface BlockRendererProps {
  block: Block;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
}

export type BlockRenderer = (props: BlockRendererProps) => ReactNode;
export type BlockRenderers = Record<string, BlockRenderer | undefined>;
