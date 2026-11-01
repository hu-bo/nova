import { createFileRoute } from '@tanstack/react-router';
import { CallbackPage } from '@/features/auth';
export const Route = createFileRoute('/callback')({ component: CallbackPage });
