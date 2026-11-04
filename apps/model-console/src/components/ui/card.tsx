import { Card as HeroUICard } from "@heroui/react";
import { cn } from "@/lib/utils";

export const Card = HeroUICard;

export function CardHeader({ className, ...props }: React.ComponentProps<typeof HeroUICard.Header>) {
  return <HeroUICard.Header data-slot="card-header" className={cn("grid gap-1.5 px-6 pt-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<typeof HeroUICard.Title>) {
  return (
    <HeroUICard.Title
      data-slot="card-title"
      className={cn("font-semibold leading-none text-foreground", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.ComponentProps<typeof HeroUICard.Description>) {
  return (
    <HeroUICard.Description
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.ComponentProps<typeof HeroUICard.Content>) {
  return <HeroUICard.Content data-slot="card-content" className={cn("px-6 pb-6", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<typeof HeroUICard.Footer>) {
  return (
    <HeroUICard.Footer data-slot="card-footer" className={cn("flex items-center px-6 pb-6", className)} {...props} />
  );
}
