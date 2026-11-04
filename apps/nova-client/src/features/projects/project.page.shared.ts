import type { GetProjectBinding200 } from '@/api/generated/projectsAPI.schemas';

type ProjectInstructions = NonNullable<GetProjectBinding200>['instructions'];

export type InstructionSource = NonNullable<ProjectInstructions['source']>;

export function instructionSource(instructions: ProjectInstructions): InstructionSource {
  return instructions.source ?? (instructions.customPrompt ? 'custom' : 'none');
}
