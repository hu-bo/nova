import { Chip as HeroUIChip, type ChipProps as HeroUIChipProps } from "@heroui/react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type LegacyVariant = "default" | "success" | "warning" | "danger" | "primary";

const colorMap: Record<LegacyVariant, HeroUIChipProps["color"]> = {
  default: "default",
  success: "success",
  warning: "warning",
  danger: "danger",
  primary: "accent",
};

export interface BadgeProps extends Omit<HeroUIChipProps, "color" | "variant" | "children"> {
  variant?: LegacyVariant;
  children?: ReactNode;
}

export function Badge({ className, variant = "default", children, ...props }: BadgeProps) {
  return (
    <HeroUIChip
      data-slot="badge"
      color={colorMap[variant]}
      variant="soft"
      size="sm"
      className={cn("gap-1.5 px-2.5 py-1 text-xs font-semibold", className)}
      {...props}
    >
      {children}
    </HeroUIChip>
  );
}