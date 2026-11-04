import { cn } from '@/lib/cn';
import { ChevronDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';
import { fieldClass } from './form.shared';

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select
        className={cn(fieldClass, 'cursor-pointer appearance-none pr-9', className)}
        {...props}
      />
      <ChevronDown
        size={15}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}
