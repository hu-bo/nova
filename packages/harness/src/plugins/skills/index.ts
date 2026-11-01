import type { PluginDefinition } from "../../contracts/plugin.js";
import type { ContextContribution } from "../../contracts/context.js";
import { contextContributions } from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { positive } from "../../shared/json.js";

export interface SkillResource {
  readonly id: string;
  readonly version: string;
  readonly content: string;
  readonly description?: string;
}

export interface SkillsPluginConfig {
  readonly skills: readonly SkillResource[];
  readonly selected?: readonly string[];
  readonly maxSkillCharacters?: number;
}

/** Adds explicitly selected, bounded Markdown resources to model context. */
export function skillsPlugin(config: SkillsPluginConfig): PluginDefinition<SkillsPluginConfig> {
  if (!config || typeof config !== "object" || !(config.skills instanceof Array))
    throw new FrameworkError("INVALID_CONFIG", "Skills configuration must contain a resource list.");
  const maxSkillCharacters = positive(config.maxSkillCharacters ?? 40_000, "maxSkillCharacters");
  const skills = config.skills.map((skill) => structuredClone<SkillResource>(skill));
  const byId = new Map<string, SkillResource>();
  for (const skill of skills) {
    if (
      !skill ||
      typeof skill !== "object" ||
      typeof skill.id !== "string" ||
      typeof skill.version !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(skill.id) ||
      !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(skill.version)
    )
      throw new FrameworkError("INVALID_CONFIG", "Invalid Skill metadata.");
    if (byId.has(skill.id)) throw new FrameworkError("DUPLICATE_SKILL", "Duplicate Skill: " + skill.id);
    if (typeof skill.content !== "string") throw new FrameworkError("INVALID_CONFIG", "Skill content must be text.");
    byId.set(skill.id, skill);
  }
  const selected = config.selected ?? [];
  if (!(selected instanceof Array) || selected.some((id) => typeof id !== "string"))
    throw new FrameworkError("INVALID_CONFIG", "Selected Skills must be an array of IDs.");
  const selectedSkills = selected.map((id) => {
    const skill = byId.get(id);
    if (!skill) throw new FrameworkError("UNKNOWN_SKILL", "Unknown Skill: " + id);
    return skill;
  });
  if (new Set(selected).size !== selected.length)
    throw new FrameworkError("DUPLICATE_SKILL", "A Skill may be selected once.");
  const totalCharacters = selectedSkills.reduce((total, skill) => total + skill.content.length, 0);
  if (totalCharacters > maxSkillCharacters)
    throw new FrameworkError("CONTEXT_LIMIT", "Selected Skills exceed the context budget.");

  return {
    manifest: {
      id: "nnova.skills",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [],
      provides: [],
      contributes: [contextContributions],
    },
    config: {
      skills,
      selected,
      maxSkillCharacters,
    },
    setup(context) {
      for (const skill of selectedSkills) {
        const contribution: ContextContribution = {
          id: "skill:" + skill.id,
          order: 200,
          async build(input) {
            input.signal.throwIfAborted();
            return [
              {
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: `[Skill ${skill.id}@${skill.version}]\n${skill.content}`,
                  },
                ],
              },
            ];
          },
        };
        context.contribute(contextContributions, contribution);
      }
    },
  };
}
