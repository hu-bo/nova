import type { GetProjectBinding200 } from '@/api/generated/projectsAPI.schemas';

type ProjectInstructions = NonNullable<GetProjectBinding200>['instructions'];

export type InstructionSource = NonNullable<ProjectInstructions['source']>;

export function instructionSource(instructions: ProjectInstructions): InstructionSource {
  return instructions.source ?? (instructions.customPrompt ? 'custom' : 'none');
}

export function describeInstructions(instructions: ProjectInstructions): string {
  switch (instructionSource(instructions)) {
    case 'custom':
      return instructions.customPrompt || '未填写自定义提示词';
    case 'none':
      return '不使用项目指令';
    case 'agents':
      return '每次运行从工作目录读取 AGENTS.md';
    case 'claude':
      return '每次运行从工作目录读取 CLAUDE.md';
  }
}
