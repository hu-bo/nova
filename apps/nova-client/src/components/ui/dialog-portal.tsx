import type { ReactNode } from 'react';

/** Legacy portals / trigger / overlay aliases — preserved as no-op passes for callers
 * that imported them from the old shadcn-style wrapper. */
export function DialogPortal({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
