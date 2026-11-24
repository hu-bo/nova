import { Sparkles } from "lucide-react";
import type { SkillApplicability, SkillSource } from "@nova/agent-ui-contracts";
import type { ComposerAgentEntry, ComposerProductSkill, ComposerSkill } from "./composer-types.js";

/** 来源展示名表：会话技能菜单与 /skills 页面共用同一来源标识（§3.1）。 */
export const SKILL_SOURCE_LABELS = {
  builtin: "内置",
  platform: "平台",
  "runner-global": "本机全局",
  "runner-project": "项目",
} satisfies Record<SkillSource, string>;

/** 适用性三态标签（机器状态名，不是原因文案）；不适用原因只展示服务端 message。 */
export const SKILL_APPLICABILITY_LABELS = {
  available: "可用",
  unavailable: "暂不可用",
  unverified: "待验证",
} satisfies Record<SkillApplicability["status"], string>;

/** 技能条目是否可选与说明行：unavailable 不可选；unverified 保持可选并等待服务端复核。 */
export function describeProductSkill(skill: ComposerProductSkill): {
  selectable: boolean;
  statusLabel: string;
  notes: string[];
} {
  const status = skill.applicability?.status ?? "available";
  const notes = (skill.applicability?.reasons ?? []).map((reason) => reason.message);
  return {
    selectable: status !== "unavailable" && !skill.disabled,
    statusLabel: SKILL_APPLICABILITY_LABELS[status],
    notes,
  };
}

/** Agent 条目：不兼容项非空则不可选择（§4.3），原因文案由服务端给出。 */
export function describeAgentEntry(agent: ComposerAgentEntry): { selectable: boolean; notes: string[] } {
  const notes = (agent.incompatibilities ?? []).map((item) => item.message);
  return { selectable: notes.length === 0, notes };
}

export function findSkillMention(text: string, cursor: number) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
  if (!match) return null;
  const suffix = /^[^\s@]*/.exec(text.slice(cursor))![0];
  return { start: cursor - match[1]!.length - 1, end: cursor + suffix.length, query: match[1]!.toLocaleLowerCase() };
}

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
  trigger = "/",
  ariaLabel,
}: {
  listId: string;
  skills: readonly ComposerSkill[];
  selected: ComposerSkill | undefined;
  onSelect?: ((skill: ComposerSkill) => void) | undefined;
  trigger?: "/" | "@";
  ariaLabel?: string | undefined;
}) {
  if (skills.length === 0 && trigger === "/") return null;
  const label = ariaLabel ?? (trigger === "@" ? "选择技能" : "可用命令");
  return (
    <div
      id={listId}
      role="listbox"
      aria-label={label}
      className="nova-scrollbar absolute bottom-[calc(100%+0.5rem)] left-0 z-30 max-h-64 w-80 max-w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-slate-950/10 dark:border-slate-700 dark:bg-slate-900"
    >
      {skills.length === 0 && <p className="px-3 py-4 text-sm text-slate-500">没有匹配的技能</p>}
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
              {trigger === "@" ? (
                <>
                  <span className="block truncate text-sm font-medium">{skill.label}</span>
                  {skill.description && (
                    <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
                      {skill.description}
                    </span>
                  )}
                  {(skill.meta || skill.notes?.length) && (
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4">
                      {skill.meta && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                          {skill.meta}
                        </span>
                      )}
                      {skill.notes?.map((note) => (
                        <span key={note} className="text-amber-600 dark:text-amber-400">
                          {note}
                        </span>
                      ))}
                    </span>
                  )}
                </>
              ) : (
                <code className="text-xs text-slate-400">
                  /{skill.command} {skill.label}
                </code>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
