import { createFileRoute } from '@tanstack/react-router';
import { RunnersTab } from '@/features/settings';

export const Route = createFileRoute('/settings/runners')({
  component: RunnersTab,
});
