import { Button as HeroUIButton, type ButtonProps as HeroUIButtonProps } from "@heroui/react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type LegacyVariant =
  | "default"
  | "primary"
  | "outline"
  | "secondary"
  | "ghost"
  | "destructive"
  | "danger"
  | "link";

type LegacySize = "default" | "sm" | "lg" | "icon";

const variantMap: Record<LegacyVariant, { variant: HeroUIButtonProps["variant"]; extra?: string }> = {
  default: { variant: "primary" },
  primary: { variant: "primary" },
  outline: { variant: "outline" },
  secondary: { variant: "secondary" },
  ghost: { variant: "ghost" },
  destructive: { variant: "danger-soft" },
  danger: { variant: "danger" },
  link: { variant: "tertiary", extra: "underline-offset-4 hover:underline px-0 min-h-0" },
};

const sizeMap: Record<LegacySize, { size: HeroUIButtonProps["size"]; isIconOnly?: boolean; extra?: string }> = {
  default: { size: "md" },
  sm: { size: "sm" },
  lg: { size: "lg" },
  icon: { size: "md", isIconOnly: true },
};

export interface ButtonProps
  extends Omit<HeroUIButtonProps, "variant" | "size" | "isIconOnly" | "onPress" | "onClick" | "children"> {
  variant?: LegacyVariant;
  size?: LegacySize;
  /** Explicit icon-only flag (legacy compat). When children is missing, also inferred. */
  isIconOnly?: boolean;
  /** Legacy icon slot — when no children, the button is treated as icon-only. */
  icon?: ReactNode;
  /** Preferred HeroUI v3 handler. */
  onPress?: HeroUIButtonProps["onPress"];
  /** Legacy alias — accepted for back-compat; forwarded to `onPress`. */
  onClick?: HeroUIButtonProps["onPress"];
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "default",
  icon,
  isIconOnly,
  className,
  onClick,
  onPress,
  children,
  ...props
}: ButtonProps) {
  const v = variantMap[variant];
  const s = sizeMap[size];
  const onlyIcon = !children && icon != null;
  const press = onPress ?? onClick;
  return (
    <HeroUIButton
      data-slot="button"
      variant={v.variant}
      size={s.size}
      isIconOnly={isIconOnly ?? s.isIconOnly ?? onlyIcon}
      {...(press ? { onPress: press } : {})}
      className={cn(v.extra, s.extra, className)}
      {...props}
    >
      {icon}
      {children}
    </HeroUIButton>
  );
}

export { Button as default };