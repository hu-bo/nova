import { cn } from '@/lib/cn';
import type { InputHTMLAttributes } from 'react';
import { fieldClass } from './form.shared';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClass, className)} {...props} />;
}
