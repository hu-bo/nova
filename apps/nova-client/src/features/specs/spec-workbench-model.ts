import type { GetSpec200, GetSpec200TaskPlanItem } from '@/api/generated/projectsAPI.schemas';
import { ApiError } from '@/api/api-error';

/** 生成草稿的服务端前置门控（与 spec.service.generate 的上游确认要求一致）；返回 null 表示可发起。 */
export function generationBlockReason(
  spec: Pick<GetSpec200, 'revision' | 'reviews'>,
  stage: 'requirements' | 'design' | 'tasks',
): string | null {
  if (stage === 'requirements') return null;
  if (spec.reviews.requirements?.revision !== spec.revision) return '请先确认需求';
  if (stage === 'tasks' && spec.reviews.design?.revision !== spec.revision) return '请先确认设计';
  return null;
}

export function specGenerationError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.details?.reason === 'SPEC_BUSY') {
      return '会话正忙或有排队中的工作，请等当前运行结束后再生成。';
    }
    if (error.details?.reason === 'SPEC_REVIEW_REQUIRED') {
      return '请先确认上游阶段，再生成本阶段草稿。';
    }
  }
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

/** 服务端 validateTaskPlan 要求每个任务写明设计引用；保存草稿前预检，避免 400。 */
export function taskDesignRefError(tasks: GetSpec200TaskPlanItem[]): string | null {
  const missing = tasks.filter((task) => !task.designRef?.trim()).map((task) => task.key);
  if (!missing.length) return null;
  return `任务 ${missing.join('、')} 缺少设计引用，请写明对应的设计文档章节。`;
}

export function specReviewError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.details?.reason === 'SPEC_REQUIREMENTS_EMPTY') {
      return '请填写需求内容后再确认。';
    }
    if (error.details?.reason === 'SPEC_DESIGN_SECTIONS_MISSING') {
      const sections = error.details.missingSections;
      const names = Array.isArray(sections)
        ? sections.filter((section) => typeof section === 'string').join('、')
        : '';
      if (names) return `请补全设计文档的「${names}」章节后再确认。`;
      return '请补全设计文档的目标、功能、实现方案和验收标准后再确认。';
    }
    if (error.details?.reason === 'SPEC_DESIGN_REF_MISSING') {
      const taskKey = error.details.taskKey;
      if (typeof taskKey === 'string') {
        return `任务 ${taskKey} 缺少设计引用。请在任务中写明对应设计文档章节，或在会话中让助手补全后再确认。`;
      }
      return '任务缺少设计引用，请补全对应设计文档章节后再确认。';
    }
    if (error.details?.reason === 'SPEC_CRITERIA_MISSING') {
      return '请在设计文档的「验收标准」中添加至少一条验收项。';
    }
    if (error.details?.reason === 'SPEC_CRITERION_FORMAT') {
      return '请为每条设计验收项添加 AC-01 形式的三级标题，并描述可验证的预期结果。';
    }
    if (error.details?.reason === 'SPEC_CRITERION_DUPLICATE') {
      const id = error.details.criterionId;
      if (typeof id === 'string' && /^AC-\d{2,}$/.test(id)) {
        return `设计文档的验收编号 ${id} 重复，请为每条验收项使用唯一编号。`;
      }
      return '验收条件编号重复。请在右侧会话中让助手整理并更新草稿后再确认。';
    }
  }
  return error instanceof Error ? error.message : '操作失败，请重试。';
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
