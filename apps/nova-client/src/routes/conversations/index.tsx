import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ConversationPage } from '@/features/conversations';
export const Route = createFileRoute('/conversations/')({
  component: ConversationPage,
  validateSearch: z.object({ projectId: z.uuid().optional(), mode: z.literal('spec').optional() }),
});
