import { createFileRoute } from '@tanstack/react-router';
import { ProjectPage } from '@/features/projects';
export const Route = createFileRoute('/projects/$id')({ component: ProjectPage });
