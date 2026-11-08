import { markdownLanguage } from '@codemirror/lang-markdown';
import type { GetSpec200, GetSpec200TaskPlanItem } from '@/api/generated/projectsAPI.schemas';

export function parseAcceptanceCriteria(markdown: string) {
  const criteria: { id: string; title: string; from: number }[] = [];
  let inSection = false;
  markdownLanguage.parser.parse(markdown).iterate({
    enter(node) {
      if (node.name === 'ATXHeading2') {
        inSection = /^##\s+验收条件\s*#*\s*$/.test(markdown.slice(node.from, node.to));
      }
      if (!inSection || node.name !== 'ATXHeading3') return;
      const match = /^###\s+(AC-\d{2,})(?:\s+(.*?))?\s*#*\s*$/.exec(
        markdown.slice(node.from, node.to),
      );
      if (match?.[1]) criteria.push({ id: match[1], title: match[2] ?? '', from: node.from });
    },
  });
  return criteria;
}

export function taskDependencyError(tasks: GetSpec200TaskPlanItem[]) {
  const graph = new Map(tasks.map((task) => [task.key, task.dependsOn]));
  if (graph.size !== tasks.length) return '任务 ID 不能重复。';
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string): string | null {
    if (visiting.has(key)) return '检测到循环依赖：' + [...visiting, key].join(' → ');
    if (visited.has(key)) return null;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) {
      if (!graph.has(dependency)) return key + ' 依赖不存在的任务 ' + dependency;
      const error = visit(dependency);
      if (error) return error;
    }
    visiting.delete(key);
    visited.add(key);
    return null;
  }
  for (const task of tasks) {
    const error = visit(task.key);
    if (error) return error;
  }
  return null;
}

export function passingEvidence(spec: GetSpec200, taskKey: string, checkKey: string) {
  const attemptId = spec.tasks.find((task) => task.key === taskKey)?.attemptId;
  return spec.evidence
    .filter(
      (entry) =>
        entry.taskKey === taskKey &&
        entry.checkKey === checkKey &&
        entry.passed &&
        (attemptId ? entry.attemptId === attemptId : entry.source === 'carried'),
    )
    .at(-1);
}
