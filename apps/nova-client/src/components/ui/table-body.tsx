import type { ComponentProps } from 'react';

export function TableBody(props: ComponentProps<'tbody'>) {
  return <tbody className="divide-y divide-slate-100" {...props} />;
}
