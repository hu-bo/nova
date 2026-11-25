import { cleanup, render, screen } from '@testing-library/react';
import { parseAcceptanceCriteria } from '@nova/agent-ui-contracts/spec';
import { afterEach, expect, it } from 'vitest';
import type { GetSpec200 } from '@/api/generated/projectsAPI.schemas';
import { ApiError } from '@/api/api-error';
import { SpecAcceptance } from '@/features/specs/spec-acceptance';
import {
  generationBlockReason,
  specGenerationError,
  specReviewError,
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
  requirementsMd: '## 验收条件\n### AC-99 原始草稿',
  designMd: '## 验收标准\n### AC-01 导出\n### AC-02 下载',
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
  reviews: {
    design: { revision: 2, reviewerId: 'user', reviewedAt: 'now', criteriaSource: 'design' },
  },
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
    '### AC-99 outside\n## 验收标准\n### AC-01 导出\n\n~~~md\n### AC-02 code\n~~~\n\n## 范围\n### AC-03 outside';
  expect(parseAcceptanceCriteria(markdown).map((item) => item.id)).toEqual(['AC-01']);
  expect(
    parseAcceptanceCriteria('## 验收标准 ##\n### AC-01 导出\n# 其他\n### AC-02 其他').map(
      (item) => item.id,
    ),
  ).toEqual(['AC-01']);
  expect(parseAcceptanceCriteria('## 验收标准##\n### AC-01')).toEqual([]);
});
it('explains missing and duplicate acceptance criteria in review errors', () => {
  expect(
    specReviewError(
      new ApiError(400, 400, 'generic', undefined, undefined, {
        reason: 'SPEC_DESIGN_SECTIONS_MISSING',
        missingSections: ['目标', '实现方案'],
      }),
    ),
  ).toContain('目标、实现方案');
  expect(
    specReviewError(
      new ApiError(400, 400, 'generic', undefined, undefined, { reason: 'SPEC_CRITERIA_MISSING' }),
    ),
  ).toContain('在设计文档的「验收标准」');
  expect(
    specReviewError(
      new ApiError(400, 400, 'generic', undefined, undefined, {
        reason: 'SPEC_CRITERION_DUPLICATE',
        criterionId: 'AC-01',
      }),
    ),
  ).toContain('AC-01 重复');
  expect(specReviewError(new ApiError(409, 409, '状态已变更'))).toBe('状态已变更');
});
it('gates draft generation behind confirmed upstream stages', () => {
  const reviews = {};
  expect(generationBlockReason({ ...spec, reviews }, 'requirements')).toBeNull();
  expect(generationBlockReason({ ...spec, reviews }, 'design')).toBe('请先确认需求');
  expect(generationBlockReason({ ...spec, reviews }, 'tasks')).toBe('请先确认需求');
  const requirementsConfirmed = {
    ...spec,
    reviews: { requirements: { revision: 2, reviewerId: 'user', reviewedAt: 'now' } },
  };
  expect(generationBlockReason(requirementsConfirmed, 'design')).toBeNull();
  expect(generationBlockReason(requirementsConfirmed, 'tasks')).toBe('请先确认设计');
  const designConfirmed = {
    ...requirementsConfirmed,
    reviews: {
      ...requirementsConfirmed.reviews,
      design: { revision: 2, reviewerId: 'user', reviewedAt: 'now' },
    },
  };
  expect(generationBlockReason(designConfirmed, 'tasks')).toBeNull();
});
it('explains generation conflicts in Chinese', () => {
  expect(
    specGenerationError(
      new ApiError(409, 409, 'Specification session is busy', undefined, undefined, {
        reason: 'SPEC_BUSY',
      }),
    ),
  ).toContain('会话正忙');
  expect(
    specGenerationError(
      new ApiError(409, 409, 'generic', undefined, undefined, {
        reason: 'SPEC_REVIEW_REQUIRED',
      }),
    ),
  ).toContain('上游阶段');
  expect(specGenerationError(new ApiError(409, 409, '状态已变更'))).toBe('状态已变更');
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
  expect(screen.getByText('AC-02')).toBeTruthy();
  expect(screen.queryByText('AC-99')).toBeNull();
});
it('shows carried evidence and immutable acceptance for designs confirmed under the previous format', () => {
  const accepted: GetSpec200 = {
    ...spec,
    requirementsMd: '## 验收条件\n### AC-01 导出',
    reviews: { design: { revision: 2, reviewerId: 'user', reviewedAt: 'now' } },
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
  expect(screen.queryByText('AC-02')).toBeNull();
  expect(screen.queryByText(/Rev|版本/)).toBeNull();
});
