import { createFileRoute } from '@tanstack/react-router';
import { ConversationPage } from '@/features/conversations';

export const Route = createFileRoute('/conversations/$id')({
  component: ConversationPage,
});
