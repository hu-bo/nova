import { Button as HeroUIButton, type ButtonProps as HeroUIButtonProps } from '@heroui/react';
import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';
import { sizeMap, variantMap, type LegacySize, type LegacyVariant } from './button-variants';

export interface ButtonProps extends Omit<
  HeroUIButtonProps,
  'variant' | 'size' | 'isIconOnly' | 'onPress' | 'onClick' | 'children' | 'isDisabled'
> {
  variant?: LegacyVariant;
  size?: LegacySize;
  isIconOnly?: boolean;
  /** Legacy alias — mapped to HeroUI's `isDisabled`. */
  disabled?: boolean;
  isDisabled?: boolean;
  /** Legacy alias for icon-only buttons — inferred when no children is passed. */
  icon?: ReactNode;
  /** Title attribute — passed through to the underlying <button>. */
  title?: string;
  onPress?: HeroUIButtonProps['onPress'];
  onClick?: HeroUIButtonProps['onPress'];
  children?: ReactNode;
}

/** 只导出组件的模块：React Fast Refresh 要求边界模块只导出组件，
 *  变体映射与 `buttonVariants` 放在 `button-variants.ts`。 */
export function Button({
  variant = 'default',
  size = 'default',
  icon,
  isIconOnly,
  disabled,
  isDisabled,
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
  const effectiveDisabled = isDisabled ?? disabled;
  return (
    <HeroUIButton
      data-slot="button"
      variant={v.variant}
      size={s.size}
      isIconOnly={isIconOnly ?? s.isIconOnly ?? onlyIcon}
      {...(effectiveDisabled !== undefined ? { isDisabled: effectiveDisabled } : {})}
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
