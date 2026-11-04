import { BarChart3, Boxes, ServerCog } from "lucide-react";
import type { LinkProps } from "@tanstack/react-router";

export const navigation = [
  { to: "/providers", label: "Providers", description: "连接与凭据", icon: ServerCog },
  { to: "/models", label: "模型目录", description: "能力与价格", icon: Boxes },
  { to: "/usage", label: "用量报表", description: "Harness Run 统计", icon: BarChart3 },
] as const satisfies ReadonlyArray<{ to: LinkProps["to"]; label: string; description: string; icon: typeof Boxes }>;
