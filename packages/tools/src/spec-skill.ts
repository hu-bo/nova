import { readFileSync } from 'node:fs';
import { defineTool, type JsonValue, type ToolDefinition } from '@nnova/harness';
import type { SkillResource } from '@nnova/harness/plugins/skills';
import { z } from 'zod';

export const specSkill: SkillResource = {
  id: 'nova.spec',
  version: '1.0.0',
  description: 'Maintain a versioned Feature Spec in the Nova Spec Workbench.',
  content: readFileSync(new URL('../skills/spec/SKILL.md', import.meta.url), 'utf8'),
};

export const specDraftCandidateSchema = z.object({
  baseRevision: z.number().int().positive(),
  stage: z.enum(['requirements', 'design', 'tasks']),
  content: z.string().max(131072),
}).strict();

/** Candidate tools have no workspace effects. The host commits the durable result after the Run succeeds. */
export function createSpecTools(options: {
  revision: number;
  snapshot: JsonValue;
  canUpdate: boolean;
  stage?: 'requirements' | 'design' | 'tasks';
}): ToolDefinition[] {
  const tools: ToolDefinition[] = [defineTool({
    name: 'spec_read',
    description: 'Read the exact saved specification revision bound to this Run.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.json(),
    effects: 'read',
    execute: async (_input, context) => {
      context.signal.throwIfAborted();
      return options.snapshot;
    },
  })];
  if (options.canUpdate) tools.push(defineTool({
    name: 'spec_update',
    description: 'Submit a complete draft candidate. The host validates and saves it only when this Run succeeds and the base revision is still current. User confirmations and acceptance are never changed by this tool.',
    inputSchema: z.object({
      expectedRevision: z.literal(options.revision),
      stage: options.stage ? z.literal(options.stage) : z.enum(['requirements', 'design', 'tasks']),
      content: z.string().max(131072),
    }).strict(),
    outputSchema: specDraftCandidateSchema,
    effects: 'read',
    execute: async (input, context) => {
      context.signal.throwIfAborted();
      return { baseRevision: input.expectedRevision, stage: input.stage, content: input.content };
    },
  }));
  return tools;
}
