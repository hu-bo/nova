import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SpecPage } from '@/features/specs';
export const Route = createFileRoute('/specs/$id')({
  component: SpecPage,
  validateSearch: z.object({ projectId: z.uuid() }),
});
