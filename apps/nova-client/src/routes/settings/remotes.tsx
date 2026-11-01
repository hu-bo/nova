import { createFileRoute } from '@tanstack/react-router';
import { RemoteConnectionsPage } from '@/features/remotes';

export const Route = createFileRoute('/settings/remotes')({ component: RemoteConnectionsPage });
