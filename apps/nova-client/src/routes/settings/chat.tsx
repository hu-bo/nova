import { createFileRoute } from '@tanstack/react-router';
import { ChatTab } from '@/features/settings';

export const Route = createFileRoute('/settings/chat')({
  component: ChatTab,
});
