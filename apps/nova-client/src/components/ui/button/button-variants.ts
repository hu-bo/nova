import type { ButtonProps as HeroUIButtonProps } from '@heroui/react';
import { cn } from '@/lib/cn';

export type LegacyVariant =
  'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'danger' | 'link';

export type LegacySize =
  'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';

export const variantMap: Record<
  LegacyVariant,
  { variant: HeroUIButtonProps['variant']; extra?: string }
> = {
  default: { variant: 'primary' },
  outline: { variant: 'outline' },
  secondary: { variant: 'secondary' },
  ghost: { variant: 'ghost' },
  destructive: { variant: 'danger-soft' },
  danger: { variant: 'danger' },
  link: {
    variant: 'tertiary',
    extra: 'underline-offset-4 hover:underline px-0 min-h-0 h-auto',
  },
};

export const sizeMap: Record<
  LegacySize,
  {
    size: HeroUIButtonProps['size'];
    isIconOnly?: boolean;
    extra?: string;
  }
> = {
  default: { size: 'sm' },
  xs: { size: 'sm', extra: 'h-6 rounded-md text-xs px-2 gap-1' },
  sm: { size: 'sm' },
  lg: { size: 'md' },
  icon: { size: 'sm', isIconOnly: true },
  'icon-xs': { size: 'sm', isIconOnly: true, extra: 'size-6 rounded-md' },
  'icon-sm': { size: 'sm', isIconOnly: true, extra: 'size-7' },
  'icon-lg': { size: 'md', isIconOnly: true, extra: 'size-9' },
};

/** Legacy helper kept for callers that previously composed a `className` from CVA.
 *  Returns just the className so `<Link className={buttonVariants(...)}>` keeps building.
 *
 *  与 `button.tsx` 的组件分开存放：该模块只导出非组件值，满足 React Fast Refresh
 *  的「边界模块只导出组件」约定，编辑按钮组件时不会整页重载。 */
export function buttonVariants(
  opts: {
    variant?: LegacyVariant;
    size?: LegacySize;
    className?: string;
  } = {},
) {
  const v = variantMap[opts.variant ?? 'default'];
  const s = sizeMap[opts.size ?? 'default'];
  return cn(
    'group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50',
    v.extra,
    s.extra,
    opts.className,
  );
}
