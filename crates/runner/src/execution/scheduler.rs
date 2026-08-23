//! Concurrency + queueing. docs/runner.md §4/§8: a full queue must reject immediately
//! (`BUSY`), not grow without bound. Two semaphores model that with no custom bookkeeping:
//!
//! - `admission` (size `max_concurrency + queue_size`): a non-blocking gate. Full → `BUSY`.
//!   Held for the whole `queued` + `running` lifetime of a request.
//! - `running` (size `max_concurrency`): acquired by *awaiting* — that wait *is* the `queued`
//!   state (runner.md's state machine has no separate "queued" event; the stream is simply
//!   open with nothing on it yet).

use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub struct Scheduler {
    admission: Arc<Semaphore>,
    running: Arc<Semaphore>,
    max_concurrency: usize,
    queue_size: usize,
}

impl Scheduler {
    pub fn new(max_concurrency: usize, queue_size: usize) -> Self {
        Self {
            admission: Arc::new(Semaphore::new(max_concurrency + queue_size)),
            running: Arc::new(Semaphore::new(max_concurrency)),
            max_concurrency,
            queue_size,
        }
    }

    /// Non-blocking: `None` means admission + queue capacity is exhausted (`BUSY`).
    pub fn try_admit(&self) -> Option<AdmissionPermit> {
        let permit = self.admission.clone().try_acquire_owned().ok()?;
        Some(AdmissionPermit {
            _permit: permit,
            running: self.running.clone(),
        })
    }

    /// Executions actually running right now (running slots taken).
    pub fn running_count(&self) -> usize {
        self.max_concurrency - self.running.available_permits()
    }

    /// Heartbeat-state input: busy when anything is queued or running. Every admitted
    /// execution holds an admission permit for its whole queued + running lifetime, so
    /// "any admission permit taken" is exactly "something is queued or running".
    pub fn is_busy(&self) -> bool {
        self.admission.available_permits() < self.max_concurrency + self.queue_size
    }
}

/// Held from admission until the execution finishes (queued + running).
pub struct AdmissionPermit {
    _permit: OwnedSemaphorePermit,
    running: Arc<Semaphore>,
}

impl AdmissionPermit {
    /// Waits for a running slot. This wait is the `queued` state. Returns `None` if `cancel`
    /// resolves first — the caller never spawned a process in that case.
    pub async fn wait_for_running_slot(self, cancel: &super::Cancel) -> Option<RunningPermit> {
        tokio::select! {
            _ = cancel.cancelled() => None,
            acquired = self.running.clone().acquire_owned() => {
                acquired.ok().map(|permit| RunningPermit { _permit: permit, _admission: self })
            }
        }
    }
}

/// Held only while the process is actually running; dropping it frees the slot for the next
/// queued execution.
pub struct RunningPermit {
    _permit: OwnedSemaphorePermit,
    _admission: AdmissionPermit,
}
