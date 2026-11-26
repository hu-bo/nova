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
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 py-0.5 text-xs font-semibold leading-none align-middle",
        className,
      )}
      {...props}
    >
      {children}
    </HeroUIChip>
  );
}
