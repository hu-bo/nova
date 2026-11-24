import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { skillSourceSchema, skillVersionSchema } from '@nova/agent-ui-contracts';
import { SkillsPage } from '@/features/skills';

/** 筛选与详情直达都放 URL：刷新 /skills?runnerId=... / ?projectId=... / ?skillId=&version= 可恢复（§3.1）。 */
const skillsSearchSchema = z.object({
  runnerId: z.string().min(1).max(128).optional(),
  projectId: z.string().min(1).max(128).optional(),
  skillId: z.string().min(1).max(128).optional(),
  version: skillVersionSchema.optional(),
  q: z.string().min(1).max(128).optional(),
  source: skillSourceSchema.optional(),
});

export const Route = createFileRoute('/skills/')({
  component: SkillsPage,
  validateSearch: skillsSearchSchema,
});
