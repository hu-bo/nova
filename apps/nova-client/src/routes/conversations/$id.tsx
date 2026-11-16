import { createFileRoute } from '@tanstack/react-router';
import { ConversationPage } from '@/features/conversations';
import { z } from 'zod';
import { skillSelectionSchema } from '@nova/agent-ui-contracts';

export const Route = createFileRoute('/conversations/$id')({
  component: ConversationPage,
  validateSearch: z.object({ skill: skillSelectionSchema.optional() }),
});
