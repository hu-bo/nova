import { Sparkles } from "lucide-react";
import type { ComposerSkill } from "./composer-types.js";

export function matchComposerSkills(text: string, skills: readonly ComposerSkill[]): ComposerSkill[] {
  if (!text.startsWith("/")) return [];
  const query = text.slice(1);
  if (/\s/.test(query)) return [];
  const normalized = query.toLocaleLowerCase();
  return skills.filter((skill) => {
    const command = skill.command.replace(/^\/+/, "").toLocaleLowerCase();
    return command.includes(normalized) || skill.label.toLocaleLowerCase().includes(normalized);
  });
}

export function ComposerSkillMenu({
  listId,
  skills,
  selected,
  onSelect,
}: {
  listId: string;
  skills: readonly ComposerSkill[];
  selected: ComposerSkill | undefined;
  onSelect?: ((skill: ComposerSkill) => void) | undefined;
}) {
  if (skills.length === 0) return null;
  return (
    <div
      id={listId}
      role="listbox"
      aria-label="可用技能"
      className="nova-scrollbar absolute bottom-[calc(100%+0.5rem)] left-0 right-0 z-30 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white/95 p-1.5 shadow-xl shadow-slate-950/10 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95"
    >
      {skills.map((skill) => {
        const isSelected = skill === selected;
        return (
          <button
            key={skill.id}
            id={`${listId}-${skill.id}`}
            type="button"
            role="option"
            aria-selected={isSelected}
            disabled={skill.disabled || !onSelect}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect?.(skill)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition disabled:opacity-45 ${
              isSelected
                ? "bg-indigo-50 text-indigo-950 dark:bg-indigo-950/50 dark:text-indigo-100"
                : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
            }`}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
              {skill.icon ?? <Sparkles className="size-4" aria-hidden="true" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <code className="text-xs text-slate-400">/{skill.command} {skill.label}</code>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
