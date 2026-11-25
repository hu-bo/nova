-- 一次性重分类旧的未确认取消记录；其余历史状态保持不变。
UPDATE runs
SET state = 'timed_out',
    failure_reason = COALESCE(failure_reason, 'LEGACY_CANCELLED_UNCONFIRMED'),
    lease_until = NULL,
    worker_id = NULL
WHERE state = 'cancelled_unconfirmed';
