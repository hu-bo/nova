import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ProjectsPage } from '@/features/projects';

const projectsSearchSchema = z.object({
  createProject: z.boolean().optional(),
});

export const Route = createFileRoute('/projects/')({
  component: ProjectsPage,
  validateSearch: projectsSearchSchema,
});
