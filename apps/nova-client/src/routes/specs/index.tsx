import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
export const Route = createFileRoute('/specs/')({
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/conversations', search: { ...search, mode: 'spec' } });
  },
  validateSearch: z.object({ projectId: z.uuid().optional() }),
});
