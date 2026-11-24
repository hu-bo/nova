import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { skillSelectionSchema } from '@nova/agent-ui-contracts';
import { ConversationPage } from '@/features/conversations';
export const Route = createFileRoute('/conversations/')({
  component: ConversationPage,
  validateSearch: z.object({
    projectId: z.uuid().optional(),
    mode: z.enum(['spec', 'career']).optional(),
    /** /skills「在会话中使用」带入的技能预选；发送时才执行（§3.1）。 */
    skill: skillSelectionSchema.optional(),
  }),
});
