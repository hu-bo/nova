import { createFileRoute, redirect } from '@tanstack/react-router';
import { SettingsLayout } from '@/features/settings';

export const Route = createFileRoute('/settings')({
  beforeLoad: ({ location }) => {
    if (location.pathname === '/settings' || location.pathname === '/settings/') {
      throw redirect({ to: '/settings/models' });
    }
  },
  component: SettingsLayout,
});
