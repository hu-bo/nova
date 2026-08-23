import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button inline-flex min-h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-transparent bg-clip-padding px-4 py-2 text-sm font-semibold outline-none transition-all duration-200 select-none motion-safe:hover:scale-[1.02] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        outline: "border-border bg-card text-foreground shadow-xs hover:bg-muted",
        secondary: "border-border bg-card text-slate-700 shadow-xs hover:bg-muted hover:text-foreground",
        ghost: "text-slate-600 hover:bg-muted hover:text-foreground",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
        danger: "bg-destructive text-white shadow-sm hover:bg-destructive/90 focus-visible:ring-destructive/30",
        link: "min-h-0 px-0 text-primary underline-offset-4 hover:scale-100 hover:underline",
      },
      size: {
        default: "min-h-10 px-4 py-2",
        sm: "min-h-8 rounded-lg px-3 py-1.5 text-xs",
        lg: "min-h-11 px-5 py-2.5",
        icon: "size-10 min-h-10 px-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

function Button({ className, variant = "secondary", size = "default", icon, children, ...props }: ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { icon?: ReactNode }) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props}>{icon}{children}</ButtonPrimitive>;
}

export { Button, buttonVariants };
