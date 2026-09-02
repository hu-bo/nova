//! Execution state machine. docs/runner.md §4:
//! `queued --(slot free)--> running --> {completed, timed_out, cancelled, failed}`,
//! queue-full rejects immediately with `BUSY` rather than growing without bound, and
//! `execution_id` is an idempotency key (`BUSY` while in flight, `INVALID` once finished —
//! Phase 1 has no Event Store, so finished ids are never replayed).
//!
//! Only admission (the very first step) can fail the RPC outright. Once a stream starts, every
//! other outcome — spawn failure, timeout, cancel, truncation — is reported *in-band* as the
//! terminal `Finished` event, never as a stream error (proto.md §4: "`Finished` 必发,且是流的
//! 最后一个事件").

pub mod scheduler;
pub mod stream;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;
use tokio_stream::Stream as EventStream;

use crate::error::RunnerError;
use crate::pb::common::{Error as WireError, ErrorCode};
use crate::pb::execution::{
    ExecutionEvent, ExecutionStatus, Finished, Output, Started, execution_event,
};
use crate::process::SpawnedProcess;

use scheduler::Scheduler;

/// Runner-wide output cap per execution (runner.md §5): not for memory hygiene, but so a
/// runaway command (`find /`) can't take the whole link down. The process keeps running to
/// completion; forwarding just stops.
const MAX_OUTPUT_BYTES: u64 = 10 * 1024 * 1024;

pub struct ExecuteParams {
    pub execution_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    /// Already defaulted by the caller (0 in the wire request means "use the Runner default").
    pub timeout_ms: u32,
    pub stdin: Vec<u8>,
}

/// Race-free cancel signal shared between the registry (so `Cancel()` can trigger it) and the
/// running execution (so it can be awaited alongside a timeout).
pub struct Cancel {
    notify: Notify,
    triggered: AtomicBool,
}

impl Cancel {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            notify: Notify::new(),
            triggered: AtomicBool::new(false),
        })
    }

    fn trigger(&self) {
        self.triggered.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Resolves once `trigger()` has been (or is concurrently being) called. Registering the
    /// `Notified` future before re-checking the flag avoids the standard "missed wakeup" race.
    pub async fn cancelled(&self) {
        let notified = self.notify.notified();
        if self.triggered.load(Ordering::SeqCst) {
            return;
        }
        notified.await;
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RecordState {
    Queued,
    Running,
    Finished,
}

struct ExecutionHandle {
    cancel: Arc<Cancel>,
    state: Mutex<RecordState>,
}

/// Idempotency table for `execution_id`. Kept for the Runner's whole lifetime — Phase 1 has no
/// eviction policy; a long-lived Runner accumulating one entry per execution is an acceptable
/// simplicity/memory tradeoff for a local dev process (see CLAUDE.md Rule 14).
pub struct Registry {
    executions: Mutex<HashMap<String, Arc<ExecutionHandle>>>,
}

impl Registry {
    fn new() -> Self {
        Self {
            executions: Mutex::new(HashMap::new()),
        }
    }

    fn begin(&self, execution_id: &str) -> Result<Arc<ExecutionHandle>, RunnerError> {
        let mut map = self.executions.lock().unwrap();
        if let Some(existing) = map.get(execution_id) {
            let state = *existing.state.lock().unwrap();
            return Err(if state == RecordState::Finished {
                RunnerError::new(
                    ErrorCode::Invalid,
                    format!(
                        "execution_id {execution_id:?} already finished; ids are not replayable (no Event Store in Phase 1)"
                    ),
                )
            } else {
                RunnerError::busy(format!(
                    "execution_id {execution_id:?} is already in flight"
                ))
            });
        }
        let handle = Arc::new(ExecutionHandle {
            cancel: Cancel::new(),
            state: Mutex::new(RecordState::Queued),
        });
        map.insert(execution_id.to_string(), handle.clone());
        Ok(handle)
    }

    /// Only for the "admitted an id, then immediately hit BUSY on capacity" path: that attempt
    /// never went anywhere, so the id should stay retryable rather than becoming a phantom.
    fn abandon(&self, execution_id: &str) {
        self.executions.lock().unwrap().remove(execution_id);
    }

    fn set_running(&self, execution_id: &str) {
        if let Some(handle) = self.executions.lock().unwrap().get(execution_id) {
            *handle.state.lock().unwrap() = RecordState::Running;
        }
    }

    fn finish(&self, execution_id: &str) {
        if let Some(handle) = self.executions.lock().unwrap().get(execution_id) {
            *handle.state.lock().unwrap() = RecordState::Finished;
        }
    }

    /// `true` if an in-flight (queued or running) execution was found and signalled.
    pub fn cancel(&self, execution_id: &str) -> bool {
        match self.executions.lock().unwrap().get(execution_id) {
            Some(handle) => {
                let finished = *handle.state.lock().unwrap() == RecordState::Finished;
                if !finished {
                    handle.cancel.trigger();
                }
                !finished
            }
            None => false,
        }
    }

    /// Trigger cancel on every in-flight (queued or running) execution — the disconnect
    /// hook (runner.md §7) and server-requested shutdown both go through this.
    pub fn cancel_all(&self) {
        for handle in self.executions.lock().unwrap().values() {
            let finished = *handle.state.lock().unwrap() == RecordState::Finished;
            if !finished {
                handle.cancel.trigger();
            }
        }
    }
}

pub struct Executor {
    scheduler: Scheduler,
    registry: Registry,
    default_timeout_ms: u32,
}

enum KillReason {
    TimedOut,
    Cancelled,
}

impl Executor {
    pub fn new(max_concurrency: usize, queue_size: usize, default_timeout_ms: u32) -> Arc<Self> {
        Arc::new(Self {
            scheduler: Scheduler::new(max_concurrency, queue_size),
            registry: Registry::new(),
            default_timeout_ms,
        })
    }

    pub fn cancel(&self, execution_id: &str) -> bool {
        self.registry.cancel(execution_id)
    }

    /// Disconnect/shutdown hook (runner.md §7): cancel everything in flight. Running
    /// executions get their process group killed; queued ones resolve as cancelled without
    /// ever spawning. Nothing is ever replayed on a later connection.
    pub fn cancel_all(&self) {
        self.registry.cancel_all();
    }

    /// Executions actually running right now (heartbeat `running` field).
    pub fn running_count(&self) -> usize {
        self.scheduler.running_count()
    }

    /// Anything queued or running (heartbeat state input).
    pub fn is_busy(&self) -> bool {
        self.scheduler.is_busy()
    }

    /// Admits or rejects (`BUSY` / `INVALID`) synchronously. On success, returns a stream that
    /// always ends with exactly one `Finished` event. The returned stream owns everything it
    /// needs (cloned `Arc`s, owned params) and doesn't borrow `self` — `use<>` says so
    /// explicitly, since edition 2024 would otherwise conservatively tie the opaque type to
    /// `self`'s elided lifetime.
    pub fn execute(
        self: &Arc<Self>,
        params: ExecuteParams,
    ) -> Result<impl EventStream<Item = ExecutionEvent> + use<>, RunnerError> {
        let handle = self.registry.begin(&params.execution_id)?;
        let Some(admission) = self.scheduler.try_admit() else {
            self.registry.abandon(&params.execution_id);
            return Err(RunnerError::busy(format!(
                "execution_id {:?}: Runner is at capacity",
                params.execution_id
            )));
        };
        let executor = self.clone();
        Ok(async_stream::stream! {
            let execution_id = params.execution_id.clone();
            let mut sequence: u64 = 0;

            let Some(_running_permit) = admission.wait_for_running_slot(&handle.cancel).await else {
                executor.registry.finish(&execution_id);
                sequence += 1;
                yield finished_event(&execution_id, sequence, ExecutionStatus::Cancelled, -1, Some(wire_error(ErrorCode::Cancelled, "cancelled before it started running")), 0);
                return;
            };
            executor.registry.set_running(&execution_id);

            let timeout_ms = if params.timeout_ms == 0 { executor.default_timeout_ms } else { params.timeout_ms };
            let spawned = SpawnedProcess::spawn(&params.command, &params.args, &params.cwd, &params.env, params.stdin);
            let (mut process, killer) = match spawned {
                Ok(pair) => pair,
                Err(err) => {
                    executor.registry.finish(&execution_id);
                    sequence += 1;
                    yield finished_event(&execution_id, sequence, ExecutionStatus::Failed, -1, Some(err.into_wire()), 0);
                    return;
                }
            };

            let pid = process.pid().unwrap_or(0) as i32;
            sequence += 1;
            yield ExecutionEvent {
                execution_id: execution_id.clone(),
                sequence,
                ts: Some(now()),
                event: Some(execution_event::Event::Started(Started { pid })),
            };

            let stdout = process.take_stdout().expect("stdout was piped at spawn");
            let stderr = process.take_stderr().expect("stderr was piped at spawn");
            let mut output_rx = stream::spawn_readers(stdout, stderr);

            let wait_task = tokio::spawn(async move { process.wait().await });

            let started_at = Instant::now();
            let sleep = tokio::time::sleep(Duration::from_millis(timeout_ms as u64));
            tokio::pin!(sleep);

            let mut kill_reason: Option<KillReason> = None;
            let mut bytes_forwarded: u64 = 0;
            let mut truncated = false;

            loop {
                tokio::select! {
                    maybe_chunk = output_rx.recv() => {
                        match maybe_chunk {
                            Some(chunk) => {
                                if truncated {
                                    continue; // already announced; keep draining so the pipe doesn't block the process
                                }
                                bytes_forwarded += chunk.data.len() as u64;
                                if bytes_forwarded > MAX_OUTPUT_BYTES {
                                    truncated = true;
                                    continue;
                                }
                                sequence += 1;
                                yield ExecutionEvent {
                                    execution_id: execution_id.clone(),
                                    sequence,
                                    ts: Some(now()),
                                    event: Some(execution_event::Event::Output(Output { stream: chunk.stream as i32, data: chunk.data })),
                                };
                            }
                            None => break, // both readers hit EOF — the process is gone (exited or killed)
                        }
                    }
                    _ = &mut sleep, if kill_reason.is_none() => {
                        kill_reason = Some(KillReason::TimedOut);
                        tracing::warn!(
                            %execution_id,
                            category = "execution_timeout",
                            timeout_ms,
                            "execution timed out; killing process"
                        );
                        killer.kill();
                    }
                    _ = handle.cancel.cancelled(), if kill_reason.is_none() => {
                        kill_reason = Some(KillReason::Cancelled);
                        tracing::info!(
                            %execution_id,
                            category = "execution_cancelled",
                            "execution cancelled; killing process"
                        );
                        killer.kill();
                    }
                }
            }

            let exit_status = match wait_task.await {
                Ok(Ok(status)) => Some(status),
                Ok(Err(error)) => {
                    tracing::warn!(
                        %execution_id,
                        category = "process_error",
                        error = %error,
                        "failed to wait for the child process"
                    );
                    None
                }
                Err(error) => {
                    tracing::error!(
                        %execution_id,
                        category = if error.is_panic() { "panic" } else { "task_join_error" },
                        error = ?error,
                        "child-process wait task failed"
                    );
                    None
                }
            };
            let duration_ms = started_at.elapsed().as_millis() as u64;
            executor.registry.finish(&execution_id);

            let (status, exit_code, mut error) = match kill_reason {
                Some(KillReason::Cancelled) => (ExecutionStatus::Cancelled, -1, Some(wire_error(ErrorCode::Cancelled, "cancelled by client request"))),
                Some(KillReason::TimedOut) => (ExecutionStatus::TimedOut, -1, Some(wire_error(ErrorCode::Timeout, format!("timed out after {timeout_ms}ms")))),
                None => match exit_status {
                    // `code()` is None when the process died from a signal we didn't request
                    // (e.g. killed by something outside the Runner) — Phase 1 doesn't model
                    // that as a distinct state, just an exit without a code.
                    Some(status) => (ExecutionStatus::Completed, status.code().unwrap_or(-1), None),
                    None => (ExecutionStatus::Failed, -1, Some(wire_error(ErrorCode::Io, "execution task ended without a result"))),
                },
            };
            if truncated && error.is_none() {
                error = Some(wire_error(ErrorCode::TooLarge, format!("output truncated after {MAX_OUTPUT_BYTES} bytes; the process ran to completion")));
            }

            sequence += 1;
            yield finished_event(&execution_id, sequence, status, exit_code, error, duration_ms);
        })
    }
}

fn now() -> prost_types::Timestamp {
    prost_types::Timestamp::from(std::time::SystemTime::now())
}

fn wire_error(code: ErrorCode, message: impl Into<String>) -> WireError {
    WireError {
        code: code as i32,
        message: message.into(),
    }
}

fn finished_event(
    execution_id: &str,
    sequence: u64,
    status: ExecutionStatus,
    exit_code: i32,
    error: Option<WireError>,
    duration_ms: u64,
) -> ExecutionEvent {
    ExecutionEvent {
        execution_id: execution_id.to_string(),
        sequence,
        ts: Some(now()),
        event: Some(execution_event::Event::Finished(Finished {
            status: status as i32,
            exit_code,
            error,
            duration_ms,
        })),
    }
}

/// testing.md §2's explicit list for this crate: "并发上限与队列满、超时、cancel 杀进程组".
/// Path-escape/symlink coverage lives in `workspace::tests` instead.
#[cfg(test)]
mod tests {
    use super::*;
    use tokio_stream::StreamExt;

    fn sleep_command(seconds: u64) -> (String, Vec<String>) {
        #[cfg(unix)]
        {
            ("sleep".to_string(), vec![seconds.to_string()])
        }
        #[cfg(windows)]
        {
            // No portable `sleep` on Windows; `ping` with a count is the usual stand-in.
            (
                "cmd".to_string(),
                vec![
                    "/C".to_string(),
                    format!("ping -n {} 127.0.0.1 >NUL", seconds + 1),
                ],
            )
        }
    }

    fn sleep_params(id: &str, seconds: u64, timeout_ms: u32) -> ExecuteParams {
        let (command, args) = sleep_command(seconds);
        ExecuteParams {
            execution_id: id.to_string(),
            command,
            args,
            cwd: std::env::current_dir().unwrap(),
            env: HashMap::new(),
            timeout_ms,
            stdin: Vec::new(),
        }
    }

    fn command_line_as_executable_params(id: &str) -> ExecuteParams {
        let command = if cfg!(windows) {
            "cmd /C dir C:\\workspace\\synes\\".to_string()
        } else {
            "ls /workspace/synes/".to_string()
        };
        ExecuteParams {
            execution_id: id.to_string(),
            // `command` is an executable path, not a shell command line. Keeping the
            // argument in this string must therefore fail to spawn rather than run `ls`/`cmd`.
            command,
            args: Vec::new(),
            cwd: std::env::current_dir().unwrap(),
            env: HashMap::new(),
            timeout_ms: 5_000,
            stdin: Vec::new(),
        }
    }

    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(windows)]
    fn process_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE as u32
        }
    }

    #[tokio::test]
    async fn queue_full_returns_busy_immediately() {
        // admission capacity = max_concurrency + queue_size = 1 + 1 = 2
        let executor = Executor::new(1, 1, 5_000);
        let a = executor
            .execute(sleep_params("a", 3, 5_000))
            .expect("first must be admitted (running)");
        let b = executor
            .execute(sleep_params("b", 3, 5_000))
            .expect("second must be admitted (queued)");
        match executor.execute(sleep_params("c", 3, 5_000)) {
            Ok(_) => panic!("third must be rejected: at capacity"),
            Err(err) => assert_eq!(err.code, ErrorCode::Busy),
        }
        drop(a);
        drop(b);
    }

    #[tokio::test]
    async fn timeout_ends_timed_out_without_waiting_the_full_duration() {
        let executor = Executor::new(4, 4, 5_000);
        let stream = executor.execute(sleep_params("timeout", 30, 200)).unwrap();
        tokio::pin!(stream);
        let started_at = Instant::now();
        let mut last = None;
        while let Some(event) = stream.next().await {
            last = Some(event);
        }
        assert!(
            started_at.elapsed() < Duration::from_secs(15),
            "must not wait anywhere near the full 30s sleep"
        );
        match last.expect("stream must yield at least Finished").event {
            Some(execution_event::Event::Finished(f)) => {
                assert_eq!(f.status, ExecutionStatus::TimedOut as i32)
            }
            _ => panic!("last event must be Finished"),
        }
    }

    #[tokio::test]
    async fn cancel_actually_kills_the_process() {
        let executor = Executor::new(4, 4, 30_000);
        let stream = executor
            .execute(sleep_params("cancel-me", 30, 30_000))
            .unwrap();
        tokio::pin!(stream);

        let pid = match stream.next().await.expect("Started event").event {
            Some(execution_event::Event::Started(s)) => s.pid as u32,
            _ => panic!("first event must be Started"),
        };
        assert!(
            process_alive(pid),
            "process should be alive right after Started"
        );

        assert!(executor.cancel("cancel-me"));

        let mut finished_status = None;
        while let Some(event) = stream.next().await {
            if let Some(execution_event::Event::Finished(f)) = event.event {
                finished_status = Some(f.status);
            }
        }
        assert_eq!(finished_status, Some(ExecutionStatus::Cancelled as i32));

        // The kill itself is forceful (SIGKILL / TerminateJobObject), but OS reaping can lag.
        for _ in 0..50 {
            if !process_alive(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("process {pid} is still alive 5s after being cancelled");
    }

    #[tokio::test]
    async fn command_line_in_command_field_finishes_with_spawn_failed() {
        let executor = Executor::new(1, 0, 5_000);
        let stream = executor
            .execute(command_line_as_executable_params("command-line"))
            .expect("spawn failures are reported in-band after admission");
        tokio::pin!(stream);

        let events: Vec<_> = stream.collect().await;
        assert!(
            !events
                .iter()
                .any(|event| matches!(event.event, Some(execution_event::Event::Started(_)))),
            "a failed spawn must not emit Started"
        );
        let Some(execution_event::Event::Finished(finished)) =
            events.last().and_then(|event| event.event.as_ref())
        else {
            panic!("spawn failure must end with Finished");
        };
        assert_eq!(finished.status, ExecutionStatus::Failed as i32);
        assert_eq!(finished.exit_code, -1);
        assert_eq!(
            finished.error.as_ref().map(|error| error.code),
            Some(ErrorCode::SpawnFailed as i32)
        );
    }
}
