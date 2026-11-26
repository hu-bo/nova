import { ApiError } from '@/api/api-error';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorNotice } from './error-notice';

describe('ErrorNotice', () => {
  afterEach(cleanup);

  it('suppresses duplicate inline alerts and retains retry and local validation feedback', () => {
    const failure = new ApiError(400, 'INVALID_NAME', '请输入名称。');
    failure.notified = true;
    const { rerender } = render(<ErrorNotice error={failure} />);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<ErrorNotice error={failure} onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByText(failure.message)).toBeNull();
    failure.notified = false;
    rerender(<ErrorNotice error={failure} />);
    expect(screen.getByText(failure.message)).toBeTruthy();
  });
});
