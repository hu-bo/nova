import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { GetSpec200 } from '@/api/generated/projectsAPI.schemas';
import { SpecAcceptance } from '@/features/specs/spec-acceptance';
import {
  parseAcceptanceCriteria,
  taskDependencyError,
} from '@/features/specs/spec-workbench-model';

afterEach(cleanup);
const spec: GetSpec200 = {
  id: 'spec',
  projectId: 'project',
  conversationId: 'conversation',
  title: 'Export',
  revision: 2,
  currentRevision: 2,
  requirementsMd: '## 验收条件\n### AC-01 导出\n### AC-02 下载',
  designMd: null,
  taskPlan: [
    {
      key: 'T-01',
      title: 'Export',
      objective: 'Export all',
      dependsOn: [],
      checks: [
        { key: 'C-01', criterionIds: ['AC-01'], label: 'Readable', method: { kind: 'manual' } },
      ],
    },
  ],
  tasks: [{ key: 'T-01', status: 'needs_verification', attemptId: 'new-attempt', runId: 'run' }],
  reviews: {},
  acceptance: null,
  history: [],
  createdAt: '2026-11-07T00:00:00Z',
  updatedAt: '2026-11-07T00:00:00Z',
  evidence: [
    {
      id: 'old',
      taskKey: 'T-01',
      checkKey: 'C-01',
      passed: true,
      source: 'automatic',
      attemptId: 'old-attempt',
      createdBy: 'user',
      createdAt: '2026-11-07T00:00:00Z',
    },
  ],
};

it('parses AC headings only within the acceptance section, excluding fenced code', () => {
  const markdown =
    '### AC-99 outside\n## 验收条件\n### AC-01 导出\n\n~~~md\n### AC-02 code\n~~~\n\n## 范围\n### AC-03 outside';
  expect(parseAcceptanceCriteria(markdown).map((item) => item.id)).toEqual(['AC-01']);
});
it('detects missing and cyclic task dependencies before save', () => {
  expect(taskDependencyError([{ ...spec.taskPlan[0]!, dependsOn: ['T-99'] }])).toContain('不存在');
  expect(taskDependencyError([{ ...spec.taskPlan[0]!, dependsOn: ['T-01'] }])).toContain(
    '循环依赖',
  );
  expect(taskDependencyError(spec.taskPlan)).toBeNull();
});
it('does not count previous attempt evidence or uncovered ACs as satisfied', () => {
  render(<SpecAcceptance spec={spec} />);
  expect(screen.getByText('0%')).toBeTruthy();
  expect(screen.getByText('尚未关联检查')).toBeTruthy();
});
it('shows explicit carried evidence and immutable acceptance', () => {
  const accepted: GetSpec200 = {
    ...spec,
    requirementsMd: '## 验收条件\n### AC-01 导出',
    tasks: [{ key: 'T-01', status: 'passed', attemptId: null, runId: null }],
    evidence: [
      {
        ...spec.evidence[0]!,
        source: 'carried',
        attemptId: undefined,
        fromRevision: 1,
        reviewedBy: 'user',
      },
    ],
    acceptance: {
      reviewerId: 'user',
      acceptedAt: '2026-11-07T00:00:00Z',
      revision: 2,
      evidenceIds: ['old'],
    },
  };
  render(<SpecAcceptance spec={accepted} />);
  expect(screen.getByText('100%')).toBeTruthy();
  expect(screen.getByText('已验收冻结')).toBeTruthy();
  expect(screen.queryByText(/Rev|版本/)).toBeNull();
});
