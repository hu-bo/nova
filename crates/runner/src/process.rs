//! Process spawn and cross-platform tree-kill. docs/runner.md: `process.rs` — "spawn / kill
//! 进程组、stdout/stderr 分流(不合并)". Killing only the direct child would leave orphans
//! behind when the command itself forks (the mandated cancel test — testing.md §3.3 — checks
//! the process is *actually* dead, not just that the API call returned).
//!
//! `Killer` is deliberately split out from `SpawnedProcess`: the execution driver needs to
//! race "wait for exit" against "timeout fired" / "cancel requested" concurrently, and killing
//! doesn't need exclusive access to the `Child` the way `.wait()` does — so `Killer` only holds
//! the OS-level identifiers (pid / job handle) and is cheap to clone into a concurrent task.

use std::collections::HashMap;
use std::path::Path;

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStderr, ChildStdout, Command};

use crate::error::RunnerError;
use crate::pb::common::ErrorCode;

#[cfg(unix)]
mod platform {
    use tokio::process::Command;

    #[derive(Clone, Copy)]
    pub struct Killer {
        pid: i32,
    }

    impl Killer {
        pub fn for_child(child: &tokio::process::Child) -> Self {
            Self {
                pid: child.id().unwrap_or(0) as i32,
            }
        }

        pub fn kill(&self) {
            if self.pid != 0 {
                // Negative pid targets the whole process group (see `prepare` below).
                unsafe {
                    libc::kill(-self.pid, libc::SIGKILL);
                }
            }
        }
    }

    /// New process group whose pgid == the child's own pid, so `Killer::kill` can signal the
    /// whole tree instead of only the direct child.
    pub fn prepare(command: &mut Command) {
        command.process_group(0);
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::Arc;
    use tokio::process::Command;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::TerminateProcess;

    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}
    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    #[derive(Clone)]
    pub struct Killer {
        job: Option<Arc<JobHandle>>,
        // Fallback when the job object couldn't be created/assigned: terminate the direct
        // process only. Misses grandchildren, but beats being unable to kill anything.
        raw_handle: isize,
    }

    impl Killer {
        pub fn for_child(child: &tokio::process::Child) -> Self {
            // `Child` doesn't implement the std `AsRawHandle` trait itself (only its stdio
            // pipes do); it exposes the same thing via this named method instead.
            let raw_handle = child.raw_handle().map(|h| h as isize).unwrap_or(0);
            let job = unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    None
                } else {
                    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    let configured = SetInformationJobObject(
                        handle,
                        JobObjectExtendedLimitInformation,
                        &info as *const _ as *const core::ffi::c_void,
                        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    ) != 0;
                    let assigned =
                        configured && AssignProcessToJobObject(handle, raw_handle as HANDLE) != 0;
                    if assigned {
                        Some(Arc::new(JobHandle(handle)))
                    } else {
                        tracing::warn!(
                            "failed to set up a job object for tree-kill; cancel/timeout will only kill the direct process, not grandchildren"
                        );
                        CloseHandle(handle);
                        None
                    }
                }
            };
            Self { job, raw_handle }
        }

        pub fn kill(&self) {
            unsafe {
                match &self.job {
                    Some(job) => {
                        windows_sys::Win32::System::JobObjects::TerminateJobObject(job.0, 1);
                    }
                    None => {
                        TerminateProcess(self.raw_handle as HANDLE, 1);
                    }
                }
            }
        }
    }

    pub fn prepare(_command: &mut Command) {}
}

pub use platform::Killer;

pub struct SpawnedProcess {
    child: Child,
}

impl SpawnedProcess {
    /// Spawns the process and returns it alongside a `Killer` that can terminate the whole
    /// tree independently of whoever ends up owning the `SpawnedProcess` for `.wait()`.
    pub fn spawn(
        command: &str,
        args: &[String],
        cwd: &Path,
        env: &HashMap<String, String>,
        stdin_data: Vec<u8>,
    ) -> Result<(Self, Killer), RunnerError> {
        let mut cmd = Command::new(command);
        // Inherit the Runner's own environment (PATH etc.) and layer the request's `env` map
        // on top — an empty map (the common case) must not strip PATH out from under `bash`.
        cmd.args(args)
            .current_dir(cwd)
            .envs(env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        platform::prepare(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|err| RunnerError::new(ErrorCode::SpawnFailed, err.to_string()))?;
        let killer = Killer::for_child(&child);

        if let Some(mut stdin) = child.stdin.take() {
            tokio::spawn(async move {
                if !stdin_data.is_empty() {
                    let _ = stdin.write_all(&stdin_data).await;
                }
                let _ = stdin.shutdown().await;
            });
        }

        Ok((Self { child }, killer))
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }
}
