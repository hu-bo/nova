import { cn } from '@/lib/cn';
import type { ComponentProps } from 'react';

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="overflow-x-auto">
      <table className={cn('w-full text-left text-sm', className)} {...props} />
    </div>
  );
}
export { TableBody } from './table-body';
export { TableCell } from './table-cell';
export { TableHead } from './table-head';
export { TableHeader } from './table-header';
export { TableRow } from './table-row';
