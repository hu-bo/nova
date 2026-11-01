import { createFileRoute } from '@tanstack/react-router';
import { ModelsTab } from '@/features/settings';

export const Route = createFileRoute('/settings/models')({
  component: ModelsTab,
});
