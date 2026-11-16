import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { careerCoachSkill } from "@nova/tools/harness";
import { productSkillSchema, type ProductSkill, type SkillSelection } from "@nova/agent-ui-contracts";
import { requirePrincipal } from "../../shared/authorization.js";
import { DomainError } from "../../shared/domain-error.js";
import { okEnvelope, success } from "../../shared/response.schema.js";

// Accepted inputs store the full resource, so later releases cannot change queued or resumed work.
const builtinSkills = [{ ...careerCoachSkill, name: "求职教练", source: "builtin" as const }];
export type AcceptedSkill = (typeof builtinSkills)[number];
export function resolveSkill(selection: SkillSelection): AcceptedSkill {
  const skill = builtinSkills.find((item) => item.id === selection.id && item.version === selection.version);
  if (!skill) throw new DomainError("VALIDATION_ERROR", "Skill version is unavailable");
  return skill;
}
export function skillView(skill: AcceptedSkill): ProductSkill {
  return productSkillSchema.parse({
    id: skill.id,
    version: skill.version,
    name: skill.name,
    description: skill.description,
    source: skill.source,
  });
}
export async function skillsModule(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/skills",
    {
      schema: {
        operationId: "listSkills",
        tags: ["skills"],
        response: { 200: okEnvelope(z.object({ items: z.array(productSkillSchema) })) },
      },
    },
    async (request) => {
      requirePrincipal(request);
      return success({ items: builtinSkills.map(skillView) });
    },
  );
}
