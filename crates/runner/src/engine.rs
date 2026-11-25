use crate::{
    config::Config,
    digest::operation_digest,
    local_resources::{self, CatalogScan, LocalResources, ResourceError},
    proto::nova::{
        common::v1::{Error as WireError, ErrorCode},
        execution::v1::OutputStream,
        runner::v1::{
            ApplyPatchResult, DeleteWorkspacePathsRequest, DeleteWorkspacePathsResult, FileEntry,
            ListFilesResult, LocalResourceDiagnostic, Operation, OperationOutput, OperationResult,
            OperationStatus, ReadFileResult, ReadTextFileResult, ReconcileRequest,
            RefreshResourceCatalog, RunnerEnvelope, SearchMatch, SearchResult, WriteFileResult,
            operation::Params, operation_result::Result as ResultPayload,
            runner_envelope::Payload as RunnerPayload,
        },
    },
    workspace::{self, WorkspaceError},
};
use globset::GlobBuilder;
use ignore::WalkBuilder;
use prost::Message;
use regex::Regex;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    process::ExitStatus,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{Mutex, RwLock, Semaphore, mpsc, watch},
    time::Instant,
};
use tracing::warn;
use uuid::Uuid;

const RECEIPT_LIMIT: usize = 1_024;
const TOMBSTONE_LIMIT: usize = 65_536;
const RETAINED_BYTES_LIMIT: usize = 64 * 1024 * 1024;
const OUTPUT_RING_LIMIT: usize = 256 * 1024;
const COMMAND_OUTPUT_LIMIT: usize = 10 * 1024 * 1024;
const FILE_LIMIT: usize = 20 * 1024 * 1024;
const FILE_CHUNK_LIMIT: usize = 256 * 1024;
const TEXT_LIMIT: usize = 1024 * 1024;
/// 单次 DeleteWorkspacePaths 批量上限（tmp 清理按 Run 目录粒度，64 已远超正常需求）。
const MAX_DELETE_PATHS: usize = 64;

#[derive(Clone)]
pub struct EventQueues {
    pub control: mpsc::UnboundedSender<RunnerEnvelope>,
    pub output: mpsc::Sender<RunnerEnvelope>,
}

#[derive(Clone)]
struct Stored {
    digest: [u8; 32],
    record: Arc<Mutex<OperationRecord>>,
}

struct Registry {
    operations: HashMap<String, Stored>,
    tombstones: HashMap<String, [u8; 32]>,
    retained_bytes: usize,
}

struct OperationRecord {
    id: String,
    request_id: String,
    operation: Operation,
    input_bytes: usize,
    status: OperationStatus,
    result: Option<OperationResult>,
    result_acked: bool,
    output_gap: bool,
    last_sequence: u64,
    acked_sequence: u64,
    offsets: [u64; 2],
    output_bytes: usize,
    outputs: VecDeque<OperationOutput>,
    cancel: watch::Sender<bool>,
    reserved_bytes: usize,
}

pub struct App {
    pub boot_id: String,
    root: PathBuf,
    workspace_id: String,
    read_only: bool,
    registry: Mutex<Registry>,
    semaphore: Arc<Semaphore>,
    events: RwLock<Option<EventQueues>>,
    /// 本地受限资源（skills/agents 源根）的发现状态。
    local: Mutex<LocalResources>,
}

impl App {
    pub fn new(config: &Config) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        Ok(Arc::new(Self {
            boot_id: Uuid::new_v4().to_string(),
            root: fs::canonicalize(&config.workspace)?,
            workspace_id: config.workspace_id.clone(),
            read_only: config.read_only,
            registry: Mutex::new(Registry {
                operations: HashMap::new(),
                tombstones: HashMap::new(),
                retained_bytes: 0,
            }),
            semaphore: Arc::new(Semaphore::new(config.max_concurrency)),
            events: RwLock::new(None),
            local: Mutex::new(LocalResources::from_config(config)),
        }))
    }

    #[cfg(test)]
    pub(crate) async fn set_local_for_test(&self, local: LocalResources) {
        *self.local.lock().await = local;
    }

    /// 发布本地资源目录（启动、重连后的自发发布，或对 RefreshResourceCatalog 的应答）。
    /// 扫描在 blocking 池执行；任何失败只体现为诊断日志或不完整应答，绝不中断连接。
    pub(crate) async fn publish_resources(
        &self,
        refresh: Option<RefreshResourceCatalog>,
        control: &mpsc::UnboundedSender<RunnerEnvelope>,
    ) {
        let refresh_id = refresh
            .as_ref()
            .map(|item| item.refresh_id.clone())
            .unwrap_or_default();
        let rejection = match refresh.as_ref() {
            Some(request) => self.local.lock().await.apply_refresh(request).err(),
            None => None,
        };
        if let Some(message) = rejection {
            // 非法定位：如实回带 refresh_id 的失败应答，不动已跟踪目录、不递增版本。
            let envelope = crate::local_resources::published_frame(
                CatalogScan {
                    entries: Vec::new(),
                    diagnostics: vec![LocalResourceDiagnostic {
                        code: "scan_error".into(),
                        message,
                        name: String::new(),
                        path: String::new(),
                    }],
                    complete: false,
                },
                self.local.lock().await.revision(),
                refresh_id,
            );
            let _ = control.send(envelope);
            return;
        }
        let local = self.local.lock().await.clone();
        let revision = self.local.lock().await.next_revision();
        let outcome = tokio::task::spawn_blocking(move || local.scan()).await;
        let scan = match outcome {
            Ok(scan) => scan,
            Err(error) => {
                warn!(reason = %error, "Local resource scan task failed");
                CatalogScan {
                    entries: Vec::new(),
                    diagnostics: vec![LocalResourceDiagnostic {
                        code: "scan_error".into(),
                        message: "resource scan task failed".into(),
                        name: String::new(),
                        path: String::new(),
                    }],
                    complete: false,
                }
            }
        };
        if control
            .send(crate::local_resources::published_frame(
                scan, revision, refresh_id,
            ))
            .is_err()
        {
            warn!("Local resource catalog publish dropped: control channel closed");
        }
    }

    pub async fn heartbeat_state(&self) -> (Vec<String>, bool) {
        let registry = self.registry.lock().await;
        let mut active = Vec::new();
        for (id, stored) in &registry.operations {
            let record = stored.record.lock().await;
            if matches!(
                record.status,
                OperationStatus::Accepted | OperationStatus::Running
            ) {
                active.push(id.clone());
            }
        }
        let busy = !active.is_empty();
        (active, busy)
    }

    pub async fn set_events(&self, events: EventQueues) {
        *self.events.write().await = Some(events);
    }

    pub async fn send_reconcile(&self, sender: &mpsc::UnboundedSender<RunnerEnvelope>) {
        let registry = self.registry.lock().await;
        let mut active = Vec::new();
        let mut terminal = Vec::new();
        for (id, stored) in &registry.operations {
            let record = stored.record.lock().await;
            if matches!(
                record.status,
                OperationStatus::Accepted | OperationStatus::Running
            ) {
                active.push(id.clone());
            } else if !record.result_acked {
                terminal.push(id.clone());
            }
        }
        let _ = sender.send(RunnerEnvelope {
            request_id: Uuid::new_v4().to_string(),
            payload: Some(RunnerPayload::Reconcile(ReconcileRequest {
                boot_id: self.boot_id.clone(),
                active_operation_ids: active,
                unacknowledged_terminal_ids: terminal,
            })),
        });
    }

    pub async fn submit(
        self: &Arc<Self>,
        request_id: String,
        operation: Operation,
        events: &EventQueues,
    ) {
        let id = operation.operation_id.clone();
        let digest = match operation_digest(&operation) {
            Ok(digest) if operation.params_sha256 == digest => digest,
            _ => {
                self.send_failure(
                    request_id,
                    id,
                    OperationStatus::Failed,
                    ErrorCode::Invalid,
                    "Operation digest is invalid.",
                    events,
                )
                .await;
                return;
            }
        };
        if operation.protocol_version != 2
            || operation.target_boot_id != self.boot_id
            || operation.workspace_id != self.workspace_id
        {
            self.send_failure(
                request_id,
                id,
                OperationStatus::Failed,
                ErrorCode::OutOfWorkspace,
                "Operation target is not registered on this Runner.",
                events,
            )
            .await;
            return;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if operation.expires_at_unix_ms <= now {
            self.send_failure(
                request_id,
                id,
                OperationStatus::Failed,
                ErrorCode::Expired,
                "Operation deadline expired before dispatch.",
                events,
            )
            .await;
            return;
        }
        let reserve = reserve_bytes(&operation);
        let input_bytes = operation.encoded_len();
        {
            let registry = self.registry.lock().await;
            if let Some(prior_digest) = registry.tombstones.get(&id) {
                let status = if prior_digest == &digest {
                    OperationStatus::OutcomeUnknown
                } else {
                    OperationStatus::Failed
                };
                let code = if prior_digest == &digest {
                    ErrorCode::OutcomeUnknown
                } else {
                    ErrorCode::IdempotencyConflict
                };
                let message = if prior_digest == &digest {
                    "This acknowledged operation ID cannot be executed again; its result payload was released."
                } else {
                    "Operation ID was already used with different parameters."
                };
                drop(registry);
                self.send_failure(request_id, id, status, code, message, events)
                    .await;
                return;
            }
            if let Some(existing) = registry.operations.get(&id) {
                if existing.digest != digest {
                    drop(registry);
                    self.send_failure(
                        request_id,
                        id,
                        OperationStatus::Failed,
                        ErrorCode::IdempotencyConflict,
                        "Operation ID was already used with different parameters.",
                        events,
                    )
                    .await;
                    return;
                }
                let record = existing.record.clone();
                drop(registry);
                self.replay(request_id, record, events).await;
                return;
            }
        }
        let (cancel, cancel_rx) = watch::channel(false);
        let record = Arc::new(Mutex::new(OperationRecord {
            id: id.clone(),
            request_id: request_id.clone(),
            operation: operation.clone(),
            input_bytes,
            status: OperationStatus::Accepted,
            result: None,
            result_acked: false,
            output_gap: false,
            last_sequence: 0,
            acked_sequence: 0,
            offsets: [0, 0],
            output_bytes: 0,
            outputs: VecDeque::new(),
            cancel,
            reserved_bytes: reserve,
        }));
        {
            let mut registry = self.registry.lock().await;
            if registry.operations.len() >= RECEIPT_LIMIT
                || registry.retained_bytes.saturating_add(reserve) > RETAINED_BYTES_LIMIT
            {
                drop(registry);
                self.send_failure(
                    request_id,
                    id,
                    OperationStatus::Failed,
                    ErrorCode::Busy,
                    "Runner operation receipt capacity is full.",
                    events,
                )
                .await;
                return;
            }
            registry.retained_bytes += reserve;
            registry.operations.insert(
                id.clone(),
                Stored {
                    digest,
                    record: record.clone(),
                },
            );
        }
        if !self
            .emit_control(RunnerEnvelope {
                request_id: request_id.clone(),
                payload: Some(RunnerPayload::Accepted(
                    crate::proto::nova::runner::v1::OperationAccepted {
                        operation_id: id.clone(),
                        boot_id: self.boot_id.clone(),
                    },
                )),
            })
            .await
        {
            // The accepted fact remains in the local receipt cache and is reconciled after reconnect.
        }
        let app = self.clone();
        let queues = events.clone();
        tokio::spawn(async move {
            let permit = app.semaphore.clone().acquire_owned().await;
            if permit.is_err() {
                app.finish_error(
                    &record,
                    ErrorCode::Busy,
                    "Runner is shutting down.",
                    OperationStatus::Failed,
                    &queues,
                )
                .await;
                return;
            }
            let _permit = permit.expect("checked semaphore permit");
            if *cancel_rx.borrow() {
                app.finish_error(
                    &record,
                    ErrorCode::Cancelled,
                    "Operation was cancelled before execution.",
                    OperationStatus::Cancelled,
                    &queues,
                )
                .await;
                return;
            }
            let expires_at = record.lock().await.operation.expires_at_unix_ms;
            if unix_time_ms() >= expires_at {
                app.finish_error(
                    &record,
                    ErrorCode::Timeout,
                    "Operation deadline expired while queued.",
                    OperationStatus::TimedOut,
                    &queues,
                )
                .await;
                return;
            }
            {
                let mut state = record.lock().await;
                state.status = OperationStatus::Running;
            }
            let outcome = app.execute(&record, cancel_rx, &queues).await;
            match outcome {
                Ok(payload) => app.finish_success(&record, payload, &queues).await,
                Err((status, code, message)) => {
                    app.finish_error(&record, code, &message, status, &queues)
                        .await
                }
            }
        });
    }

    pub async fn query(
        &self,
        request_id: String,
        id: &str,
        sender: &mpsc::UnboundedSender<RunnerEnvelope>,
    ) {
        let record = {
            self.registry
                .lock()
                .await
                .operations
                .get(id)
                .map(|stored| stored.record.clone())
        };
        let Some(record) = record else {
            let result = make_error(
                id,
                &self.boot_id,
                OperationStatus::OutcomeUnknown,
                ErrorCode::OutcomeUnknown,
                "Runner has no receipt for this operation ID.",
            );
            let _ = sender.send(RunnerEnvelope {
                request_id,
                payload: Some(RunnerPayload::Result(result)),
            });
            return;
        };
        let state = record.lock().await;
        for output in &state.outputs {
            let _ = self.emit_output_frame(output.clone()).await;
        }
        if state.result_acked {
            let result = make_error(
                id,
                &self.boot_id,
                OperationStatus::OutcomeUnknown,
                ErrorCode::OutcomeUnknown,
                "The result was acknowledged and its payload has been released.",
            );
            let _ = sender.send(RunnerEnvelope {
                request_id,
                payload: Some(RunnerPayload::Result(result)),
            });
        } else if let Some(result) = state.result.clone() {
            let _ = sender.send(RunnerEnvelope {
                request_id,
                payload: Some(RunnerPayload::Result(result)),
            });
        } else {
            let result = OperationResult {
                operation_id: state.id.clone(),
                boot_id: self.boot_id.clone(),
                status: state.status as i32,
                error: None,
                last_output_sequence: state.last_sequence,
                output_gap: state.output_gap,
                result: None,
            };
            let _ = sender.send(RunnerEnvelope {
                request_id,
                payload: Some(RunnerPayload::Result(result)),
            });
        }
    }

    pub async fn cancel(&self, id: &str) {
        let record = {
            self.registry
                .lock()
                .await
                .operations
                .get(id)
                .map(|stored| stored.record.clone())
        };
        if let Some(record) = record {
            let _ = record.lock().await.cancel.send(true);
        }
    }

    pub async fn ack_result(&self, id: &str, boot_id: &str) {
        if boot_id != self.boot_id {
            return;
        }
        let record = {
            self.registry
                .lock()
                .await
                .operations
                .get(id)
                .map(|stored| stored.record.clone())
        };
        if let Some(record) = record {
            let mut state = record.lock().await;
            if state.result.take().is_some() {
                state.result_acked = true;
                let outputs_remain = !state.outputs.is_empty();
                drop(state);
                self.set_accounted_bytes(&record, 0).await;
                if !outputs_remain {
                    self.compact_acknowledged(id, &record).await;
                }
            }
        }
    }

    pub async fn ack_output(&self, id: &str, boot_id: &str, sequence: u64) {
        if boot_id != self.boot_id {
            return;
        }
        let record = {
            self.registry
                .lock()
                .await
                .operations
                .get(id)
                .map(|stored| stored.record.clone())
        };
        if let Some(record) = record {
            let mut state = record.lock().await;
            state.acked_sequence = state.acked_sequence.max(sequence);
            while state
                .outputs
                .front()
                .is_some_and(|event| event.sequence <= state.acked_sequence)
            {
                if let Some(event) = state.outputs.pop_front() {
                    state.output_bytes = state.output_bytes.saturating_sub(event.data.len());
                }
            }
            let result_bytes = state.result.as_ref().map(encoded_size).unwrap_or_default();
            let result_acked = state.result_acked;
            let outputs_remain = !state.outputs.is_empty();
            drop(state);
            if result_acked || result_bytes > 0 {
                self.set_accounted_bytes(&record, result_bytes).await;
            }
            if result_acked && !outputs_remain {
                self.compact_acknowledged(id, &record).await;
            }
        }
    }

    async fn replay(
        &self,
        request_id: String,
        record: Arc<Mutex<OperationRecord>>,
        events: &EventQueues,
    ) {
        let state = record.lock().await;
        if state.result.is_none() {
            let _ = events.control.send(RunnerEnvelope {
                request_id: state.request_id.clone(),
                payload: Some(RunnerPayload::Accepted(
                    crate::proto::nova::runner::v1::OperationAccepted {
                        operation_id: state.id.clone(),
                        boot_id: self.boot_id.clone(),
                    },
                )),
            });
        }
        for output in &state.outputs {
            let _ = self.emit_output_frame(output.clone()).await;
        }
        if state.result_acked {
            let result = make_error(
                &state.id,
                &self.boot_id,
                OperationStatus::OutcomeUnknown,
                ErrorCode::OutcomeUnknown,
                "The result was acknowledged and its payload has been released.",
            );
            let _ = events.control.send(RunnerEnvelope {
                request_id,
                payload: Some(RunnerPayload::Result(result)),
            });
        } else if let Some(result) = state.result.clone() {
            let _ = events.control.send(RunnerEnvelope {
                request_id,
                payload: Some(RunnerPayload::Result(result)),
            });
        }
    }

    async fn execute(
        self: &Arc<Self>,
        record: &Arc<Mutex<OperationRecord>>,
        mut cancel: watch::Receiver<bool>,
        events: &EventQueues,
    ) -> Result<ResultPayload, (OperationStatus, ErrorCode, String)> {
        let operation = record.lock().await.operation.clone();
        let params = operation.params.as_ref().ok_or((
            OperationStatus::Failed,
            ErrorCode::Invalid,
            "Operation parameters are missing.".into(),
        ))?;
        if self.read_only
            && matches!(
                params,
                Params::WriteFile(_)
                    | Params::ApplyPatch(_)
                    | Params::ExecuteCommand(_)
                    | Params::WriteResourceFile(_)
                    | Params::DeleteWorkspacePaths(_)
            )
        {
            return Err((
                OperationStatus::Failed,
                ErrorCode::Denied,
                "Workspace is registered read-only.".into(),
            ));
        }
        if let Params::ExecuteCommand(request) = params {
            return self
                .execute_command(record, request, &mut cancel, events)
                .await
                .map(ResultPayload::ExecuteCommand);
        }
        let app = self.clone();
        // 资源快照/写入只读扫描状态；在异步上下文克隆定位信息，blocking 池内做 IO。
        let local = self.local.lock().await.clone();
        // Filesystem traversal and I/O must leave the runtime free to receive cancellation and heartbeats.
        tokio::task::spawn_blocking(move || {
            let params = operation
                .params
                .as_ref()
                .expect("checked operation parameters");
            match params {
                Params::ListFiles(request) => app
                    .list_files(
                        &request.path,
                        request.depth,
                        request.max_entries,
                        &cancel,
                        operation.expires_at_unix_ms,
                    )
                    .map(ResultPayload::ListFiles)
                    .map_err(error_to_failure),
                Params::ReadFile(request) => app
                    .read_file(
                        &request.path,
                        request.offset,
                        request.max_bytes,
                        &cancel,
                        operation.expires_at_unix_ms,
                    )
                    .map(ResultPayload::ReadFile)
                    .map_err(error_to_failure),
                Params::ReadText(request) => app
                    .read_text(
                        &request.path,
                        request.offset,
                        request.limit,
                        request.max_bytes,
                        &cancel,
                        operation.expires_at_unix_ms,
                    )
                    .map(ResultPayload::ReadText)
                    .map_err(error_to_failure),
                Params::Search(request) => app
                    .search(
                        &request.query,
                        &request.path,
                        &request.glob,
                        request.max_results,
                        &cancel,
                        operation.expires_at_unix_ms,
                    )
                    .map(ResultPayload::Search)
                    .map_err(error_to_failure),
                Params::WriteFile(request) => app
                    .write_file(
                        &request.path,
                        &request.contents,
                        &request.expected_sha256,
                        &cancel,
                        operation.expires_at_unix_ms,
                    )
                    .map(ResultPayload::WriteFile)
                    .map_err(error_to_failure),
                Params::ApplyPatch(request) => app
                    .apply_patch(
                        &request.path,
                        &request.edits,
                        &request.expected_sha256,
                        &cancel,
                        operation.expires_at_unix_ms,
                    )
                    .map(ResultPayload::ApplyPatch)
                    .map_err(error_to_failure),
                Params::ExecuteCommand(_) => unreachable!("commands execute asynchronously"),
                Params::ReadResourceSnapshot(request) => {
                    check_operation(&cancel, operation.expires_at_unix_ms)
                        .map_err(error_to_failure)
                        .and_then(|()| {
                            local
                                .read_snapshot(request)
                                .map(ResultPayload::ReadResourceSnapshot)
                                .map_err(resource_error_to_failure)
                        })
                }
                Params::WriteResourceFile(request) => {
                    check_operation(&cancel, operation.expires_at_unix_ms)
                        .map_err(error_to_failure)
                        .and_then(|()| {
                            local
                                .write_resource(request)
                                .map(ResultPayload::WriteResourceFile)
                                .map_err(resource_error_to_failure)
                        })
                }
                Params::DeleteWorkspacePaths(request) => app
                    .delete_workspace_paths(request, &cancel, operation.expires_at_unix_ms)
                    .map(ResultPayload::DeleteWorkspacePaths)
                    .map_err(error_to_failure),
            }
        })
        .await
        .map_err(|_| {
            (
                OperationStatus::Failed,
                ErrorCode::Io,
                "Workspace operation task failed.".into(),
            )
        })?
    }

    fn list_files(
        &self,
        path: &str,
        depth: u32,
        max_entries: u32,
        cancel: &watch::Receiver<bool>,
        expires_at: u64,
    ) -> Result<ListFilesResult, WorkspaceError> {
        check_operation(cancel, expires_at)?;
        let base = workspace::resolve(&self.root, path)?;
        if !base.is_dir() {
            return Err(WorkspaceError::NotDirectory);
        }
        let depth = depth.clamp(1, 8) as usize;
        let cap = max_entries.clamp(1, 10_000) as usize;
        let mut pending = vec![(base.clone(), 0usize)];
        let mut entries = Vec::new();
        let mut truncated = false;
        while let Some((directory, level)) = pending.pop() {
            check_operation(cancel, expires_at)?;
            let child_limit = cap.saturating_sub(entries.len()).saturating_add(1);
            let mut children: Vec<_> = fs::read_dir(&directory)?
                .filter_map(Result::ok)
                .take(child_limit)
                .collect();
            children.sort_by_key(|entry| entry.file_name());
            for child in children {
                check_operation(cancel, expires_at)?;
                if entries.len() >= cap {
                    truncated = true;
                    break;
                }
                let metadata = fs::symlink_metadata(child.path())?;
                let relative = self.relative(&child.path());
                if relative.len() > 1_024 {
                    truncated = true;
                    continue;
                }
                let kind = if metadata.file_type().is_symlink() {
                    "SYMLINK"
                } else if metadata.is_dir() {
                    "DIRECTORY"
                } else {
                    "FILE"
                };
                let canonical = fs::canonicalize(child.path()).ok();
                entries.push(FileEntry {
                    path: relative,
                    kind: kind.into(),
                    size_bytes: if canonical
                        .as_ref()
                        .is_some_and(|target| !target.starts_with(&self.root))
                    {
                        0
                    } else {
                        metadata.len()
                    },
                });
                if metadata.is_dir() && !metadata.file_type().is_symlink() && level + 1 < depth {
                    pending.push((child.path(), level + 1));
                }
                if entries.len() >= cap {
                    truncated = true;
                    break;
                }
            }
            if entries.len() >= cap {
                break;
            }
        }
        Ok(ListFilesResult { entries, truncated })
    }

    fn read_file(
        &self,
        path: &str,
        offset: u64,
        max_bytes: u32,
        cancel: &watch::Receiver<bool>,
        expires_at: u64,
    ) -> Result<ReadFileResult, WorkspaceError> {
        check_operation(cancel, expires_at)?;
        let full = workspace::resolve(&self.root, path)?;
        if full.is_dir() {
            return Err(WorkspaceError::IsDirectory);
        }
        let bytes = read_bounded(&full, FILE_LIMIT)?;
        check_operation(cancel, expires_at)?;
        if bytes.len() > FILE_LIMIT {
            return Err(WorkspaceError::TooLarge);
        }
        let start = usize::try_from(offset).map_err(|_| WorkspaceError::TooLarge)?;
        if start > bytes.len() {
            return Err(WorkspaceError::NotFound);
        }
        let cap = (max_bytes as usize).clamp(1, FILE_CHUNK_LIMIT);
        let end = start.saturating_add(cap).min(bytes.len());
        Ok(ReadFileResult {
            contents: bytes[start..end].to_vec(),
            offset,
            total_size: bytes.len() as u64,
            truncated: end < bytes.len(),
            sha256: workspace::sha256(&bytes),
        })
    }

    fn read_text(
        &self,
        path: &str,
        offset: u64,
        limit: u32,
        max_bytes: u32,
        cancel: &watch::Receiver<bool>,
        expires_at: u64,
    ) -> Result<ReadTextFileResult, WorkspaceError> {
        check_operation(cancel, expires_at)?;
        let full = workspace::resolve(&self.root, path)?;
        if full.is_dir() {
            return Err(WorkspaceError::IsDirectory);
        }
        let bytes = read_bounded(&full, FILE_LIMIT)?;
        check_operation(cancel, expires_at)?;
        if bytes.len() > FILE_LIMIT {
            return Err(WorkspaceError::TooLarge);
        }
        let content = std::str::from_utf8(&bytes).map_err(|_| WorkspaceError::InvalidText)?;
        let lines: Vec<&str> = content.split_inclusive('\n').collect();
        let total_lines = if content.is_empty() {
            0
        } else {
            content.lines().count()
        };
        if offset == 0 {
            return Err(WorkspaceError::InvalidText);
        }
        let start =
            usize::try_from(offset.saturating_sub(1)).map_err(|_| WorkspaceError::TooLarge)?;
        let requested = (limit as usize).clamp(1, 2_000);
        let byte_cap = (max_bytes as usize).clamp(1, FILE_CHUNK_LIMIT);
        let mut selected = String::new();
        let mut consumed_lines = 0usize;
        let mut line_truncated = false;
        for line in lines.iter().skip(start).take(requested) {
            let remaining = byte_cap.saturating_sub(selected.len());
            if remaining == 0 {
                break;
            }
            if line.len() <= remaining {
                selected.push_str(line);
                consumed_lines += 1;
            } else {
                let mut end = remaining;
                while !line.is_char_boundary(end) {
                    end -= 1;
                }
                selected.push_str(&line[..end]);
                consumed_lines += usize::from(end > 0);
                line_truncated = true;
                break;
            }
        }
        let start_line = offset.max(1);
        let end_line = if consumed_lines == 0 {
            start_line.saturating_sub(1)
        } else {
            start_line
                .saturating_add(consumed_lines as u64)
                .saturating_sub(1)
        };
        let truncated = line_truncated || start.saturating_add(consumed_lines) < total_lines;
        Ok(ReadTextFileResult {
            text: selected,
            start_line,
            end_line,
            total_lines: Some(total_lines as u64),
            total_size: bytes.len() as u64,
            truncated,
            line_truncated,
            sha256: workspace::sha256(&bytes),
        })
    }

    fn search(
        &self,
        query: &str,
        path: &str,
        glob: &str,
        max_results: u32,
        cancel: &watch::Receiver<bool>,
        expires_at: u64,
    ) -> Result<SearchResult, WorkspaceError> {
        check_operation(cancel, expires_at)?;
        if query.len() > 16_384 {
            return Err(WorkspaceError::TooLarge);
        }
        let regex = Regex::new(query).map_err(|_| WorkspaceError::InvalidText)?;
        let matcher = if glob.is_empty() {
            None
        } else {
            Some(
                GlobBuilder::new(glob)
                    .literal_separator(true)
                    .build()
                    .map_err(|_| WorkspaceError::InvalidText)?
                    .compile_matcher(),
            )
        };
        let base = workspace::resolve(&self.root, path)?;
        let mut matches = Vec::new();
        let cap = max_results.clamp(1, 1_000) as usize;
        let walker = WalkBuilder::new(&base)
            .require_git(false)
            .follow_links(false)
            .build();
        let mut truncated = false;
        for item in walker {
            check_operation(cancel, expires_at)?;
            let Ok(entry) = item else {
                continue;
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            let display = self.relative(entry.path());
            if display.len() > 4_096 {
                truncated = true;
                continue;
            }
            if matcher.as_ref().is_some_and(|matcher| {
                !matcher.is_match(&display) && !matcher.is_match(entry.file_name())
            }) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() as usize > FILE_LIMIT {
                continue;
            }
            let Ok(bytes) = read_bounded(entry.path(), FILE_LIMIT) else {
                continue;
            };
            let Ok(text) = std::str::from_utf8(&bytes) else {
                continue;
            };
            for (index, line) in text.lines().enumerate() {
                check_operation(cancel, expires_at)?;
                if regex.is_match(line) {
                    if matches.len() == cap {
                        truncated = true;
                        break;
                    }
                    matches.push(SearchMatch {
                        path: display.clone(),
                        line: (index + 1) as u32,
                        text: line.chars().take(1_024).collect(),
                    });
                }
            }
            if truncated {
                break;
            }
        }
        Ok(SearchResult { matches, truncated })
    }

    fn write_file(
        &self,
        path: &str,
        content: &[u8],
        expected: &str,
        cancel: &watch::Receiver<bool>,
        expires_at: u64,
    ) -> Result<WriteFileResult, WorkspaceError> {
        check_operation(cancel, expires_at)?;
        if content.len() > TEXT_LIMIT {
            return Err(WorkspaceError::TooLarge);
        }
        let full = workspace::resolve(&self.root, path)?;
        if full.exists() {
            if expected.is_empty() {
                return Err(WorkspaceError::Exists);
            }
            if full.is_dir() {
                return Err(WorkspaceError::IsDirectory);
            }
            if workspace::sha256(&read_bounded(&full, FILE_LIMIT)?) != expected {
                return Err(WorkspaceError::Conflict);
            }
        } else if !expected.is_empty() {
            return Err(WorkspaceError::Conflict);
        }
        workspace::ensure_parent(&self.root, &full)?;
        check_operation(cancel, expires_at)?;
        workspace::atomic_write(&full, content)?;
        Ok(WriteFileResult {
            path: self.relative(&full),
            sha256: workspace::sha256(content),
            size_bytes: content.len() as u64,
        })
    }

    fn apply_patch(
        &self,
        path: &str,
        edits: &[crate::proto::nova::runner::v1::TextEdit],
        expected: &str,
        cancel: &watch::Receiver<bool>,
        expires_at: u64,
    ) -> Result<ApplyPatchResult, WorkspaceError> {
        check_operation(cancel, expires_at)?;
        let full = workspace::resolve(&self.root, path)?;
        if full.is_dir() {
            return Err(WorkspaceError::IsDirectory);
        }
        let original = read_bounded(&full, TEXT_LIMIT)?;
        if workspace::sha256(&original) != expected {
            return Err(WorkspaceError::Conflict);
        }
        let mut text = String::from_utf8(original).map_err(|_| WorkspaceError::InvalidText)?;
        for edit in edits {
            check_operation(cancel, expires_at)?;
            if edit.old_text.is_empty() {
                return Err(WorkspaceError::InvalidText);
            }
            if text.matches(&edit.old_text).count() != 1 {
                return Err(WorkspaceError::Conflict);
            }
            text = text.replacen(&edit.old_text, &edit.new_text, 1);
            if text.len() > TEXT_LIMIT {
                return Err(WorkspaceError::TooLarge);
            }
        }
        let bytes = text.as_bytes();
        check_operation(cancel, expires_at)?;
        workspace::atomic_write(&full, bytes)?;
        Ok(ApplyPatchResult {
            path: self.relative(&full),
            sha256: workspace::sha256(bytes),
            size_bytes: bytes.len() as u64,
            edit_count: edits.len() as u32,
        })
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// 工作区路径批量删除（P1-F1 tmp 清理；§5.2 `.nova/runs/<runId>/tmp` 形态）：
    /// 先整批校验定位（任一非法或超限即整笔 INVALID，不产生任何副作用），再顺序执行：
    /// 父链经符号链接解析后必须仍在注册工作区内；符号链接只解除链接本身、不进入目标；
    /// 目录递归删除；不存在视为已清理（幂等，不计入 removed）。
    fn delete_workspace_paths(
        &self,
        request: &DeleteWorkspacePathsRequest,
        cancel: &watch::Receiver<bool>,
        expires_at: u64,
    ) -> Result<DeleteWorkspacePathsResult, WorkspaceError> {
        check_operation(cancel, expires_at)?;
        if request.relative_paths.is_empty() || request.relative_paths.len() > MAX_DELETE_PATHS {
            return Err(WorkspaceError::InvalidPath);
        }
        // 整批定位校验先于任何副作用：任一非法即整笔 INVALID，不部分执行。
        let mut batch = Vec::with_capacity(request.relative_paths.len());
        for raw in &request.relative_paths {
            let normalized =
                local_resources::normalize_relative_dir(raw).ok_or(WorkspaceError::InvalidPath)?;
            if normalized == "." {
                // 工作区根本身不是可删除的 tmp 目标。
                return Err(WorkspaceError::InvalidPath);
            }
            let segments: Vec<&str> = normalized.split('/').collect();
            let (last, parents) = segments.split_last().ok_or(WorkspaceError::InvalidPath)?;
            batch.push((parents.join("/"), last.to_string()));
        }
        let mut removed = 0_u32;
        for (parent_raw, leaf) in &batch {
            check_operation(cancel, expires_at)?;
            let parent = match workspace::resolve(&self.root, parent_raw) {
                Ok(parent) => parent,
                // 父链尚不存在：目标必然不存在，幂等跳过（不计 removed）。
                Err(WorkspaceError::Io(error)) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            // resolve 对父链做工作区边界与符号链接解析；末段不跟随。
            removed += u32::from(delete_single_path(&parent.join(leaf))?);
        }
        Ok(DeleteWorkspacePathsResult { removed })
    }

    async fn execute_command(
        &self,
        record: &Arc<Mutex<OperationRecord>>,
        request: &crate::proto::nova::runner::v1::ExecuteCommandRequest,
        cancel: &mut watch::Receiver<bool>,
        _events: &EventQueues,
    ) -> Result<
        crate::proto::nova::runner::v1::ExecuteCommandResult,
        (OperationStatus, ErrorCode, String),
    > {
        if request.executable.is_empty()
            || request.executable.trim() != request.executable
            || request.executable.contains('\0')
        {
            return Err((
                OperationStatus::Failed,
                ErrorCode::Invalid,
                "Executable name is invalid.".into(),
            ));
        }
        if request.args.len() > 4_096
            || request
                .args
                .iter()
                .any(|arg| arg.contains('\0') || arg.len() > 32_768)
        {
            return Err((
                OperationStatus::Failed,
                ErrorCode::TooLarge,
                "Command arguments exceed the Runner limit.".into(),
            ));
        }
        if request.stdin.len() > 512 * 1024 || request.env.len() > 256 {
            return Err((
                OperationStatus::Failed,
                ErrorCode::TooLarge,
                "Command input exceeds the Runner limit.".into(),
            ));
        }
        let cwd = workspace::resolve(
            &self.root,
            if request.cwd.is_empty() {
                "."
            } else {
                &request.cwd
            },
        )
        .map_err(error_to_failure)?;
        if !cwd.is_dir() {
            return Err((
                OperationStatus::Failed,
                ErrorCode::NotDir,
                "Command cwd is not a directory.".into(),
            ));
        }
        let timeout_ms = request.timeout_ms.clamp(1, 900_000);
        let started = Instant::now();
        let mut command = Command::new(&request.executable);
        command
            .args(&request.args)
            .current_dir(cwd)
            .kill_on_drop(true);
        for (key, value) in &request.env {
            if key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0') {
                return Err((
                    OperationStatus::Failed,
                    ErrorCode::Invalid,
                    "Environment variable is invalid.".into(),
                ));
            }
            command.env(key, value);
        }
        #[cfg(unix)]
        command.process_group(0);
        command.stdin(if request.stdin.is_empty() {
            std::process::Stdio::null()
        } else {
            std::process::Stdio::piped()
        });
        command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = command.spawn().map_err(|error| {
            let message = if error.kind() == ErrorKind::NotFound {
                format!("Executable could not be found: {error}")
            } else {
                format!("Executable could not be started: {error}")
            };
            (OperationStatus::Failed, ErrorCode::SpawnFailed, message)
        })?;
        let pid = child.id();
        #[cfg(windows)]
        let job = match WindowsJob::assign(&child) {
            Ok(job) => Some(job),
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err((
                    OperationStatus::Failed,
                    ErrorCode::Io,
                    "Process could not be assigned to a cleanup Job Object.".into(),
                ));
            }
        };
        let mut stdout = child.stdout.take().ok_or((
            OperationStatus::Failed,
            ErrorCode::Io,
            "stdout pipe is unavailable.".into(),
        ))?;
        let mut stderr = child.stderr.take().ok_or((
            OperationStatus::Failed,
            ErrorCode::Io,
            "stderr pipe is unavailable.".into(),
        ))?;
        let mut stdin_writer = None;
        if !request.stdin.is_empty() {
            let mut input = child.stdin.take().ok_or((
                OperationStatus::Failed,
                ErrorCode::Io,
                "stdin pipe is unavailable.".into(),
            ))?;
            let bytes = request.stdin.clone();
            stdin_writer = Some(tokio::spawn(async move { input.write_all(&bytes).await }));
        }
        let mut buffers = [Vec::new(), Vec::new()];
        let mut captured_bytes = 0usize;
        let mut output_truncated = false;
        let deadline = tokio::time::sleep(Duration::from_millis(u64::from(timeout_ms)));
        tokio::pin!(deadline);
        let mut out_done = false;
        let mut err_done = false;
        let mut command_end: Option<Result<ExitStatus, std::io::Error>> = None;
        let mut terminal = None;
        let mut pipe_error: Option<String> = None;
        let mut out_chunk = vec![0_u8; 16 * 1024];
        let mut err_chunk = vec![0_u8; 16 * 1024];
        while !out_done || !err_done || command_end.is_none() {
            tokio::select! {
                biased;
                changed = cancel.changed() => {
                    if changed.is_ok() && *cancel.borrow() { terminal = Some(OperationStatus::Cancelled); break; }
                }
                _ = &mut deadline => { terminal = Some(OperationStatus::TimedOut); break; }
                status = child.wait(), if command_end.is_none() => { command_end = Some(status); }
                read = stdout.read(&mut out_chunk), if !out_done => match read {
                    Ok(0) => out_done = true,
                    Ok(count) => collect_output(self, record, 0, &out_chunk[..count], &mut buffers[0], &mut captured_bytes, &mut output_truncated).await,
                    Err(error) => { pipe_error = Some(format!("stdout pipe read failed: {error}")); out_done = true; },
                },
                read = stderr.read(&mut err_chunk), if !err_done => match read {
                    Ok(0) => err_done = true,
                    Ok(count) => collect_output(self, record, 1, &err_chunk[..count], &mut buffers[1], &mut captured_bytes, &mut output_truncated).await,
                    Err(error) => { pipe_error = Some(format!("stderr pipe read failed: {error}")); err_done = true; },
                },
            }
        }
        if let Some(status) = terminal {
            terminate_process_tree(pid);
            let _ = child.start_kill();
            let _ = child.wait().await;
            if let Some(writer) = stdin_writer.take() {
                let _ = writer.await;
            }
            #[cfg(windows)]
            drop(job);
            return Err((
                status,
                if status == OperationStatus::TimedOut {
                    ErrorCode::Timeout
                } else {
                    ErrorCode::Cancelled
                },
                if status == OperationStatus::TimedOut {
                    "Command exceeded its deadline.".into()
                } else {
                    "Command was cancelled.".into()
                },
            ));
        }
        if let Some(writer) = stdin_writer {
            match writer.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    return Err((
                        OperationStatus::Failed,
                        ErrorCode::Io,
                        format!("stdin write failed: {error}"),
                    ));
                }
                Err(error) => {
                    return Err((
                        OperationStatus::Failed,
                        ErrorCode::Io,
                        format!("stdin writer task failed: {error}"),
                    ));
                }
            }
        }
        if let Some(error) = pipe_error {
            return Err((OperationStatus::Failed, ErrorCode::Io, error));
        }
        #[cfg(windows)]
        drop(job);
        let status = match command_end {
            Some(Ok(status)) => status,
            _ => {
                return Err((
                    OperationStatus::Failed,
                    ErrorCode::Io,
                    "Command wait failed.".into(),
                ));
            }
        };
        if !status.success() {
            tracing::warn!(pid = ?pid, status = ?status, exit_code = ?status.code(), "Command process did not exit successfully");
        }
        Ok(crate::proto::nova::runner::v1::ExecuteCommandResult {
            exit_code: process_exit_code(status),
            stdout: buffers[0].clone(),
            stderr: buffers[1].clone(),
            output_truncated,
            duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        })
    }

    async fn finish_success(
        &self,
        record: &Arc<Mutex<OperationRecord>>,
        payload: ResultPayload,
        _events: &EventQueues,
    ) {
        let result = {
            let mut state = record.lock().await;
            state.status = OperationStatus::Succeeded;
            let result = OperationResult {
                operation_id: state.id.clone(),
                boot_id: self.boot_id.clone(),
                status: OperationStatus::Succeeded as i32,
                error: None,
                last_output_sequence: state.last_sequence,
                output_gap: state.output_gap,
                result: Some(payload),
            };
            state.result = Some(result.clone());
            result
        };
        self.set_accounted_bytes(record, encoded_size(&result))
            .await;
        let request_id = record.lock().await.request_id.clone();
        let _ = self
            .emit_control(RunnerEnvelope {
                request_id,
                payload: Some(RunnerPayload::Result(result)),
            })
            .await;
    }

    async fn finish_error(
        &self,
        record: &Arc<Mutex<OperationRecord>>,
        code: ErrorCode,
        message: &str,
        status: OperationStatus,
        _events: &EventQueues,
    ) {
        let result = {
            let mut state = record.lock().await;
            state.status = status;
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            for output in &state.outputs {
                if output.stream == OutputStream::Stdout as i32 {
                    stdout.extend_from_slice(&output.data);
                } else {
                    stderr.extend_from_slice(&output.data);
                }
            }
            let result = OperationResult {
                operation_id: state.id.clone(),
                boot_id: self.boot_id.clone(),
                status: status as i32,
                error: Some(WireError {
                    code: code as i32,
                    message: message.into(),
                    stdout,
                    stderr,
                    output_truncated: state.output_gap,
                    output_gap: state.output_gap,
                }),
                last_output_sequence: state.last_sequence,
                output_gap: state.output_gap,
                result: None,
            };
            state.result = Some(result.clone());
            result
        };
        self.set_accounted_bytes(record, encoded_size(&result))
            .await;
        let request_id = record.lock().await.request_id.clone();
        let _ = self
            .emit_control(RunnerEnvelope {
                request_id,
                payload: Some(RunnerPayload::Result(result)),
            })
            .await;
    }

    async fn send_failure(
        &self,
        request_id: String,
        id: String,
        status: OperationStatus,
        code: ErrorCode,
        message: &str,
        events: &EventQueues,
    ) {
        let result = make_error(&id, &self.boot_id, status, code, message);
        let _ = events.control.send(RunnerEnvelope {
            request_id,
            payload: Some(RunnerPayload::Result(result)),
        });
    }

    async fn set_accounted_bytes(&self, record: &Arc<Mutex<OperationRecord>>, actual: usize) {
        let mut state = record.lock().await;
        let old = state.reserved_bytes;
        state.reserved_bytes = state
            .input_bytes
            .saturating_add(actual)
            .saturating_add(state.output_bytes);
        let delta = state.reserved_bytes as isize - old as isize;
        drop(state);
        let mut registry = self.registry.lock().await;
        registry.retained_bytes = if delta < 0 {
            registry.retained_bytes.saturating_sub((-delta) as usize)
        } else {
            registry.retained_bytes.saturating_add(delta as usize)
        };
    }

    async fn compact_acknowledged(&self, id: &str, record: &Arc<Mutex<OperationRecord>>) {
        let retained = {
            let state = record.lock().await;
            if !state.result_acked || !state.outputs.is_empty() || state.output_bytes != 0 {
                return;
            }
            state.reserved_bytes
        };
        let mut registry = self.registry.lock().await;
        let same_record = registry
            .operations
            .get(id)
            .is_some_and(|stored| Arc::ptr_eq(&stored.record, record));
        if !same_record || registry.tombstones.len() >= TOMBSTONE_LIMIT {
            return;
        }
        let Some(stored) = registry.operations.remove(id) else {
            return;
        };
        registry.retained_bytes = registry.retained_bytes.saturating_sub(retained);
        registry.tombstones.insert(id.to_owned(), stored.digest);
    }

    async fn emit_control(&self, envelope: RunnerEnvelope) -> bool {
        self.events
            .read()
            .await
            .as_ref()
            .is_some_and(|events| events.control.send(envelope).is_ok())
    }

    async fn emit_output_frame(&self, output: OperationOutput) -> bool {
        let frame = RunnerEnvelope {
            request_id: output.operation_id.clone(),
            payload: Some(RunnerPayload::Output(output)),
        };
        self.events
            .read()
            .await
            .as_ref()
            .is_some_and(|events| events.output.try_send(frame).is_ok())
    }
}

async fn collect_output(
    app: &App,
    record: &Arc<Mutex<OperationRecord>>,
    stream_index: usize,
    bytes: &[u8],
    capture: &mut Vec<u8>,
    captured_total: &mut usize,
    truncated: &mut bool,
) {
    let room = COMMAND_OUTPUT_LIMIT.saturating_sub(*captured_total);
    let take = room.min(bytes.len());
    capture.extend_from_slice(&bytes[..take]);
    *captured_total += take;
    if take < bytes.len() {
        *truncated = true;
    }
    let mut state = record.lock().await;
    let sequence = state.last_sequence.saturating_add(1);
    state.last_sequence = sequence;
    let stream = if stream_index == 0 {
        OutputStream::Stdout
    } else {
        OutputStream::Stderr
    };
    let offset = state.offsets[stream_index];
    state.offsets[stream_index] = offset.saturating_add(bytes.len() as u64);
    let event = OperationOutput {
        operation_id: state.id.clone(),
        boot_id: app.boot_id.clone(),
        sequence,
        stream: stream as i32,
        offset,
        data: bytes.to_vec(),
    };
    state.outputs.push_back(event.clone());
    state.output_bytes += bytes.len();
    while state.output_bytes > OUTPUT_RING_LIMIT {
        if let Some(old) = state.outputs.pop_front() {
            state.output_bytes = state.output_bytes.saturating_sub(old.data.len());
            state.output_gap = true;
        } else {
            break;
        }
    }
    drop(state);
    if !app.emit_output_frame(event).await {
        record.lock().await.output_gap = true;
    }
}

fn reserve_bytes(operation: &Operation) -> usize {
    let result_capacity = match operation.params.as_ref() {
        Some(Params::ExecuteCommand(_)) => COMMAND_OUTPUT_LIMIT + OUTPUT_RING_LIMIT + 1024 * 1024,
        Some(Params::ReadFile(_)) | Some(Params::ReadText(_)) => FILE_CHUNK_LIMIT + 64 * 1024,
        Some(Params::WriteFile(_)) | Some(Params::ApplyPatch(_)) => 64 * 1024,
        Some(Params::ListFiles(_)) => 12 * 1024 * 1024,
        Some(Params::Search(_)) => 10 * 1024 * 1024,
        // 资源快照上限 256 KiB（local_resources::MAX_ENTRY_BYTES），回执远小于此。
        Some(Params::ReadResourceSnapshot(_)) => 256 * 1024 + 64 * 1024,
        Some(Params::WriteResourceFile(_)) => 64 * 1024,
        Some(Params::DeleteWorkspacePaths(_)) => 64 * 1024,
        None => 64 * 1024,
    };
    operation.encoded_len().saturating_add(result_capacity)
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, WorkspaceError> {
    let mut file = fs::File::open(path)?.take((limit as u64).saturating_add(1));
    let mut bytes = Vec::with_capacity(limit.min(256 * 1024));
    file.read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(WorkspaceError::TooLarge);
    }
    Ok(bytes)
}

/// 删除单个已定位目标：不存在返回 false（幂等）；符号链接只解除链接本身；
/// 真实目录递归删除（std 的 remove_dir_all 不跟随目录内符号链接）。
fn delete_single_path(path: &Path) -> Result<bool, WorkspaceError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        // Linux 上 remove_file 可直接解除任意符号链接；Windows 上指向目录的
        // 链接需 remove_dir（同样只删链接、不进入目标）。
        if fs::remove_file(path).is_err() {
            fs::remove_dir(path)?;
        }
        return Ok(true);
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path)?;
        return Ok(true);
    }
    fs::remove_file(path)?;
    Ok(true)
}

fn encoded_size(result: &OperationResult) -> usize {
    prost::Message::encoded_len(result)
}

fn process_exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        return status.signal().map(|signal| -signal).unwrap_or(-1);
    }
    #[cfg(not(unix))]
    {
        -1
    }
}

fn make_error(
    id: &str,
    boot: &str,
    status: OperationStatus,
    code: ErrorCode,
    message: &str,
) -> OperationResult {
    OperationResult {
        operation_id: id.to_owned(),
        boot_id: boot.to_owned(),
        status: status as i32,
        error: Some(WireError {
            code: code as i32,
            message: message.to_owned(),
            stdout: Vec::new(),
            stderr: Vec::new(),
            output_truncated: false,
            output_gap: false,
        }),
        last_output_sequence: 0,
        output_gap: false,
        result: None,
    }
}

fn error_to_failure(error: WorkspaceError) -> (OperationStatus, ErrorCode, String) {
    let status = match error {
        WorkspaceError::Cancelled => OperationStatus::Cancelled,
        WorkspaceError::Expired => OperationStatus::TimedOut,
        _ => OperationStatus::Failed,
    };
    let code = match error {
        WorkspaceError::Cancelled => ErrorCode::Cancelled,
        WorkspaceError::Expired => ErrorCode::Timeout,
        WorkspaceError::OutOfWorkspace => ErrorCode::OutOfWorkspace,
        WorkspaceError::NotFound => ErrorCode::NotFound,
        WorkspaceError::Exists => ErrorCode::Exists,
        WorkspaceError::IsDirectory => ErrorCode::IsDir,
        WorkspaceError::NotDirectory => ErrorCode::NotDir,
        WorkspaceError::TooLarge => ErrorCode::TooLarge,
        WorkspaceError::Conflict => ErrorCode::Conflict,
        WorkspaceError::InvalidText => ErrorCode::Invalid,
        WorkspaceError::InvalidPath => ErrorCode::Invalid,
        WorkspaceError::Io(ref io) if io.kind() == ErrorKind::NotFound => ErrorCode::NotFound,
        WorkspaceError::Io(ref io) if io.kind() == ErrorKind::PermissionDenied => {
            ErrorCode::Permission
        }
        WorkspaceError::Io(_) => ErrorCode::Io,
    };
    let message = match code {
        ErrorCode::Cancelled => "Workspace operation was cancelled.",
        ErrorCode::Timeout => "Workspace operation deadline expired.",
        ErrorCode::OutOfWorkspace => "Path escapes the registered workspace.",
        ErrorCode::NotFound => "Workspace path was not found.",
        ErrorCode::Exists => "File already exists; supply its current digest to replace it.",
        ErrorCode::Conflict => "Workspace content changed or the exact edit was not unique.",
        ErrorCode::TooLarge => "Workspace item exceeds the operation limit.",
        ErrorCode::Invalid => "Workspace item is not valid UTF-8 text or request data.",
        ErrorCode::Permission => "Workspace permission was denied.",
        _ => "Workspace operation failed.",
    };
    (status, code, message.into())
}

/// 资源操作错误直接携带语义消息（CONFLICT 消息含当前摘要，供服务端提示刷新）。
fn resource_error_to_failure(error: ResourceError) -> (OperationStatus, ErrorCode, String) {
    (
        OperationStatus::Failed,
        error.wire_code(),
        error.to_string(),
    )
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn check_operation(cancel: &watch::Receiver<bool>, expires_at: u64) -> Result<(), WorkspaceError> {
    if *cancel.borrow() {
        return Err(WorkspaceError::Cancelled);
    }
    if unix_time_ms() >= expires_at {
        return Err(WorkspaceError::Expired);
    }
    Ok(())
}

fn terminate_process_tree(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

#[cfg(windows)]
struct WindowsJob(isize);
#[cfg(windows)]
impl WindowsJob {
    fn assign(child: &tokio::process::Child) -> Result<Self, std::io::Error> {
        use std::mem;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                mem::size_of_val(&info) as u32,
            )
        };
        let process = child
            .raw_handle()
            .ok_or_else(std::io::Error::last_os_error)?;
        let assigned = unsafe { AssignProcessToJobObject(job, process as _) };
        if configured == 0 || assigned == 0 {
            unsafe {
                CloseHandle(job);
            }
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self(job as isize))
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::nova::runner::v1::{
        DeleteWorkspacePathsRequest, ExecuteCommandRequest, ReadResourceSnapshotRequest,
        SearchRequest, WriteResourceFileRequest,
    };

    struct TestWorkspace(PathBuf);

    impl TestWorkspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("nova-runner-test-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn app(&self) -> Arc<App> {
            App::new(&Config {
                server: "ws://127.0.0.1:1".into(),
                token: "test".into(),
                workspace: self.0.clone(),
                workspace_id: "test".into(),
                display_name: "test".into(),
                runner_id: "test".into(),
                max_concurrency: 1,
                read_only: false,
            })
            .unwrap()
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    async fn submit(
        app: &Arc<App>,
        params: Params,
    ) -> (String, mpsc::UnboundedReceiver<RunnerEnvelope>) {
        let (control, receiver) = mpsc::unbounded_channel();
        let (output, _output_receiver) = mpsc::channel(16);
        let events = EventQueues { control, output };
        app.set_events(events.clone()).await;
        let mut operation = Operation {
            operation_id: Uuid::new_v4().to_string(),
            target_boot_id: app.boot_id.clone(),
            workspace_id: "test".into(),
            protocol_version: 2,
            expires_at_unix_ms: unix_time_ms() + 10_000,
            timeout_ms: 10_000,
            params: Some(params),
            ..Default::default()
        };
        operation.params_sha256 = operation_digest(&operation).unwrap().to_vec();
        let id = operation.operation_id.clone();
        app.submit(id.clone(), operation, &events).await;
        (id, receiver)
    }

    async fn terminal(receiver: &mut mpsc::UnboundedReceiver<RunnerEnvelope>) -> OperationResult {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(RunnerPayload::Result(result)) = receiver.recv().await.unwrap().payload
                {
                    return result;
                }
            }
        })
        .await
        .unwrap()
    }

    #[test]
    fn search_respects_ignore_rules_and_globs() {
        let workspace = TestWorkspace::new();
        fs::create_dir(workspace.0.join("src")).unwrap();
        fs::create_dir(workspace.0.join("node_modules")).unwrap();
        fs::write(workspace.0.join(".gitignore"), "node_modules/\n").unwrap();
        fs::write(workspace.0.join("src/main.ts"), "const matchMe = 1;\n").unwrap();
        fs::write(workspace.0.join("main.ts"), "matchMe\n").unwrap();
        fs::write(workspace.0.join("src/main.js"), "matchMe\n").unwrap();
        fs::write(workspace.0.join("node_modules/dep.ts"), "matchMe\n").unwrap();
        let (_sender, cancel) = watch::channel(false);
        let result = workspace
            .app()
            .search(
                "matchMe",
                ".",
                "**/*.ts",
                100,
                &cancel,
                unix_time_ms() + 10_000,
            )
            .unwrap();
        let mut paths: Vec<_> = result
            .matches
            .iter()
            .map(|item| item.path.as_str())
            .collect();
        paths.sort_unstable();
        assert_eq!(paths, ["main.ts", "src/main.ts"]);
        assert!(!result.truncated);
    }

    #[test]
    fn workspace_io_leaves_runtime_free_to_cancel() {
        let workspace = TestWorkspace::new();
        let app = workspace.app();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let (ready, started) = tokio::sync::oneshot::channel();
            let (release, wait) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                ready.send(()).unwrap();
                let _ = wait.recv();
            });
            started.await.unwrap();
            let (id, mut receiver) = submit(
                &app,
                Params::Search(SearchRequest {
                    query: "test".into(),
                    path: ".".into(),
                    glob: "**/*.ts".into(),
                    max_results: 100,
                }),
            )
            .await;
            tokio::task::yield_now().await;
            assert_eq!(app.heartbeat_state().await.0, [id.clone()]);
            app.cancel(&id).await;
            release.send(()).unwrap();
            blocker.await.unwrap();
            let result = terminal(&mut receiver).await;
            assert_eq!(result.status, OperationStatus::Cancelled as i32);
            let error = result.error.unwrap();
            assert_eq!(error.code, ErrorCode::Cancelled as i32);
            assert_eq!(error.message, "Workspace operation was cancelled.");
        });
    }

    #[tokio::test]
    async fn git_status_runs_with_separate_arguments() {
        let workspace = TestWorkspace::new();
        assert!(
            std::process::Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(&workspace.0)
                .status()
                .unwrap()
                .success()
        );
        fs::write(workspace.0.join("untracked.ts"), "test\n").unwrap();
        let app = workspace.app();
        let (_, mut receiver) = submit(
            &app,
            Params::ExecuteCommand(ExecuteCommandRequest {
                executable: "git".into(),
                args: vec!["status".into(), "--short".into()],
                cwd: ".".into(),
                timeout_ms: 10_000,
                ..Default::default()
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(
            result.status,
            OperationStatus::Succeeded as i32,
            "{:?}",
            result.error
        );
        let Some(ResultPayload::ExecuteCommand(output)) = result.result else {
            panic!("missing command output")
        };
        assert_eq!(output.exit_code, 0);
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .contains("?? untracked.ts")
        );
    }

    #[tokio::test]
    async fn spawn_failure_includes_the_operating_system_error() {
        let workspace = TestWorkspace::new();
        let app = workspace.app();
        let (_, mut receiver) = submit(
            &app,
            Params::ExecuteCommand(ExecuteCommandRequest {
                executable: "nova-runner-command-that-does-not-exist".into(),
                cwd: ".".into(),
                timeout_ms: 10_000,
                ..Default::default()
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(result.status, OperationStatus::Failed as i32);
        let error = result.error.unwrap();
        assert_eq!(error.code, ErrorCode::SpawnFailed as i32);
        assert!(error.message.starts_with("Executable could not be found:"));
        assert!(error.message.len() > "Executable could not be found:".len());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_timeout_and_cancel_keep_captured_stderr() {
        let workspace = TestWorkspace::new();
        let app = workspace.app();
        let (_, mut timeout_receiver) = submit(
            &app,
            Params::ExecuteCommand(ExecuteCommandRequest {
                executable: "sh".into(),
                args: vec!["-c".into(), "printf 'before timeout' >&2; sleep 2".into()],
                cwd: ".".into(),
                timeout_ms: 100,
                ..Default::default()
            }),
        )
        .await;
        let timed_out = terminal(&mut timeout_receiver).await;
        assert_eq!(timed_out.status, OperationStatus::TimedOut as i32);
        let timeout_error = timed_out.error.unwrap();
        assert_eq!(timeout_error.code, ErrorCode::Timeout as i32);
        assert_eq!(
            String::from_utf8(timeout_error.stderr).unwrap(),
            "before timeout"
        );

        let (operation_id, mut cancel_receiver) = submit(
            &app,
            Params::ExecuteCommand(ExecuteCommandRequest {
                executable: "sh".into(),
                args: vec!["-c".into(), "printf 'before cancel' >&2; sleep 2".into()],
                cwd: ".".into(),
                timeout_ms: 10_000,
                ..Default::default()
            }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.cancel(&operation_id).await;
        let cancelled = terminal(&mut cancel_receiver).await;
        assert_eq!(cancelled.status, OperationStatus::Cancelled as i32);
        let cancel_error = cancelled.error.unwrap();
        assert_eq!(cancel_error.code, ErrorCode::Cancelled as i32);
        assert_eq!(
            String::from_utf8(cancel_error.stderr).unwrap(),
            "before cancel"
        );
    }

    #[cfg(unix)]
    #[test]
    fn signalled_command_exit_code_preserves_the_signal() {
        let status = std::process::Command::new("sh")
            .args(["-c", "kill -TERM $$"])
            .status()
            .unwrap();
        assert_eq!(process_exit_code(status), -15);
    }

    #[test]
    fn workspace_deadline_has_a_specific_error() {
        let (_sender, cancel) = watch::channel(false);
        let failure = error_to_failure(check_operation(&cancel, 0).unwrap_err());
        assert_eq!(
            failure,
            (
                OperationStatus::TimedOut,
                ErrorCode::Timeout,
                "Workspace operation deadline expired.".into()
            )
        );
    }

    /// 用注入的源根替换真实主目录，保证发布/快照用例跨平台可重复（含 win32）。
    struct ResourceTree {
        base: PathBuf,
        home: PathBuf,
        workspace: PathBuf,
    }

    fn resource_tree(label: &str) -> ResourceTree {
        let base = std::env::temp_dir().join(format!("nova-runner-pub-{label}-{}", Uuid::new_v4()));
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(home.join(".nova/skills/global-skill")).unwrap();
        fs::write(
            home.join(".nova/skills/global-skill/SKILL.md"),
            "---\nname: global-skill\ndescription: 全局\n---\n",
        )
        .unwrap();
        fs::create_dir_all(&workspace).unwrap();
        ResourceTree {
            base,
            home: fs::canonicalize(&home).unwrap(),
            workspace: fs::canonicalize(&workspace).unwrap(),
        }
    }

    impl Drop for ResourceTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    async fn app_with_tree(tree: &ResourceTree, read_only: bool) -> Arc<App> {
        let config = Config {
            server: "ws://127.0.0.1:1".into(),
            token: "test".into(),
            workspace: tree.workspace.clone(),
            workspace_id: "test".into(),
            display_name: "test".into(),
            runner_id: "test".into(),
            max_concurrency: 1,
            read_only,
        };
        let app = App::new(&config).unwrap();
        let local = crate::local_resources::LocalResources::with_roots(
            Some(tree.home.clone()),
            tree.workspace.clone(),
            "test".into(),
        );
        app.set_local_for_test(local).await;
        app
    }

    #[tokio::test]
    async fn catalog_publish_carries_entries_revisions_and_refresh_targets() {
        let tree = resource_tree("publish");
        let app = app_with_tree(&tree, false).await;
        let (control, mut receiver) = mpsc::unbounded_channel();
        // 首个完整目录（对应“认证接入完成后发布”）。
        app.publish_resources(None, &control).await;
        let Some(RunnerPayload::ResourceCatalogPublished(first)) =
            receiver.recv().await.unwrap().payload
        else {
            panic!("expected catalog publish");
        };
        assert_eq!(first.catalog_revision, 1);
        assert!(first.refresh_id.is_empty());
        assert!(first.complete);
        assert!(first.entries.iter().any(|item| item.name == "global-skill"));
        // 定向刷新新的 canonicalCwd 子目录：跟踪该层并回带 refresh_id。
        fs::create_dir_all(tree.workspace.join("sub/app/.nova/skills/sub-skill")).unwrap();
        fs::write(
            tree.workspace
                .join("sub/app/.nova/skills/sub-skill/SKILL.md"),
            "---\nname: sub-skill\ndescription: 子层\n---\n",
        )
        .unwrap();
        app.publish_resources(
            Some(RefreshResourceCatalog {
                refresh_id: "refresh-1".into(),
                scope: 2,
                workspace_id: "test".into(),
                relative_dir: "sub/app".into(),
            }),
            &control,
        )
        .await;
        let Some(RunnerPayload::ResourceCatalogPublished(second)) =
            receiver.recv().await.unwrap().payload
        else {
            panic!("expected refresh publish");
        };
        assert_eq!(second.refresh_id, "refresh-1");
        assert_eq!(second.catalog_revision, 2);
        assert!(second.complete);
        let sub = second
            .entries
            .iter()
            .find(|item| item.name == "sub-skill")
            .expect("targeted layer discovered");
        assert_eq!(sub.relative_dir, "sub/app");
        assert_eq!(sub.workspace_id, "test");
        // 非法刷新定位：应答 complete=false + 诊断 + 回带 refresh_id，版本不递增、不清空语义由服务端处理。
        app.publish_resources(
            Some(RefreshResourceCatalog {
                refresh_id: "refresh-bad".into(),
                scope: 2,
                workspace_id: "other-workspace".into(),
                relative_dir: ".".into(),
            }),
            &control,
        )
        .await;
        let Some(RunnerPayload::ResourceCatalogPublished(rejected)) =
            receiver.recv().await.unwrap().payload
        else {
            panic!("expected rejected refresh");
        };
        assert_eq!(rejected.refresh_id, "refresh-bad");
        assert!(!rejected.complete);
        assert_eq!(
            rejected.catalog_revision, 2,
            "failed refresh keeps the published revision"
        );
        assert!(
            rejected
                .diagnostics
                .iter()
                .any(|item| item.code == "scan_error")
        );
        // 重连语义：再次自发发布仍然成功且版本递增。
        app.publish_resources(None, &control).await;
        let Some(RunnerPayload::ResourceCatalogPublished(third)) =
            receiver.recv().await.unwrap().payload
        else {
            panic!("expected reconnect republish");
        };
        assert_eq!(third.catalog_revision, 3);
        assert!(
            third.entries.iter().any(|item| item.name == "sub-skill"),
            "layers survive reconnect"
        );
    }

    #[tokio::test]
    async fn snapshot_and_write_operations_round_trip_with_digests() {
        let tree = resource_tree("snapshot-op");
        let app = app_with_tree(&tree, false).await;
        let content = "---\nname: op-skill\ndescription: ok\n---\n正文\n";
        fs::create_dir_all(tree.home.join(".nova/skills/op-skill")).unwrap();
        fs::write(tree.home.join(".nova/skills/op-skill/SKILL.md"), content).unwrap();
        let current = crate::workspace::sha256(content.as_bytes());
        // 摘要不符 → CONFLICT，消息含当前摘要。
        let (_id, mut receiver) = submit(
            &app,
            Params::ReadResourceSnapshot(ReadResourceSnapshotRequest {
                kind: 1,
                scope: 1,
                name: "op-skill".into(),
                expected_sha256: "e".repeat(64),
                ..Default::default()
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(result.status, OperationStatus::Failed as i32);
        let error = result.error.unwrap();
        assert_eq!(error.code, ErrorCode::Conflict as i32);
        assert!(error.message.contains(&current), "{}", error.message);
        assert!(
            result.result.is_none(),
            "conflict must not return new content"
        );
        // 摘要相符 → 返回内容。
        let (_id, mut receiver) = submit(
            &app,
            Params::ReadResourceSnapshot(ReadResourceSnapshotRequest {
                kind: 1,
                scope: 1,
                name: "op-skill".into(),
                relative_path: "SKILL.md".into(),
                expected_sha256: current.clone(),
                ..Default::default()
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(
            result.status,
            OperationStatus::Succeeded as i32,
            "{:?}",
            result.error
        );
        let Some(ResultPayload::ReadResourceSnapshot(snapshot)) = result.result else {
            panic!("expected snapshot result")
        };
        assert_eq!(snapshot.contents, content.as_bytes());
        assert_eq!(snapshot.sha256, current);
        // 写入操作（全局源根）走同一 Operation/回执管道。
        let (_id, mut receiver) = submit(
            &app,
            Params::WriteResourceFile(WriteResourceFileRequest {
                kind: 2,
                scope: 1,
                name: "op-agent".into(),
                contents: b"---\ndescription: ok\n---\n".to_vec(),
                ..Default::default()
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(
            result.status,
            OperationStatus::Succeeded as i32,
            "{:?}",
            result.error
        );
        let Some(ResultPayload::WriteResourceFile(written)) = result.result else {
            panic!("expected write result")
        };
        assert!(written.created);
        assert!(tree.home.join(".nova/agents/op-agent.md").is_file());
    }

    #[tokio::test]
    async fn read_only_runner_denies_resource_writes_but_allows_reads() {
        let tree = resource_tree("readonly");
        let app = app_with_tree(&tree, true).await;
        let (_id, mut receiver) = submit(
            &app,
            Params::WriteResourceFile(WriteResourceFileRequest {
                kind: 1,
                scope: 1,
                name: "denied".into(),
                contents: b"---\nname: denied\ndescription: x\n---\n".to_vec(),
                ..Default::default()
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(result.status, OperationStatus::Failed as i32);
        assert_eq!(result.error.unwrap().code, ErrorCode::Denied as i32);
        let (_id, mut receiver) = submit(
            &app,
            Params::ReadResourceSnapshot(ReadResourceSnapshotRequest {
                kind: 1,
                scope: 1,
                name: "global-skill".into(),
                expected_sha256: "0".repeat(64),
                ..Default::default()
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        // 只读 Runner 仍可读快照：摘要不符报 CONFLICT 而不是 DENIED。
        let error = result.error.expect("digest mismatch should fail");
        assert_eq!(error.code, ErrorCode::Conflict as i32);
    }

    #[test]
    fn resource_operation_digests_are_stable_and_discriminating() {
        // 协议测试（P0-D1）：新 oneof 分支参与 canonical 摘要，字段变化必须改变摘要。
        let base = Operation {
            operation_id: "op-1".into(),
            target_boot_id: "boot-1".into(),
            workspace_id: "ws-1".into(),
            protocol_version: 2,
            expires_at_unix_ms: 1_800_000_000_000,
            timeout_ms: 10_000,
            params: Some(Params::ReadResourceSnapshot(ReadResourceSnapshotRequest {
                kind: 1,
                scope: 1,
                name: "snap".into(),
                expected_sha256: "a".repeat(64),
                ..Default::default()
            })),
            ..Default::default()
        };
        let digest = operation_digest(&base).unwrap();
        assert_eq!(operation_digest(&base).unwrap(), digest);
        let mut changed = base.clone();
        if let Some(Params::ReadResourceSnapshot(request)) = &mut changed.params {
            request.expected_sha256 = "b".repeat(64);
        }
        assert_ne!(operation_digest(&changed).unwrap(), digest);
        let write = Operation {
            params: Some(Params::WriteResourceFile(WriteResourceFileRequest {
                kind: 1,
                scope: 2,
                workspace_id: "ws-1".into(),
                relative_dir: "sub".into(),
                name: "created".into(),
                contents: b"payload".to_vec(),
                expected_sha256: String::new(),
                ..Default::default()
            })),
            ..base.clone()
        };
        assert_ne!(operation_digest(&write).unwrap(), digest);
        // 固定夹具摘要（与 packages/runner-sdk 的 TS 测试交叉验证，防止双侧漂移）。
        println!("NOVA_READ_SNAPSHOT_DIGEST {}", hex::encode(digest));
        println!(
            "NOVA_WRITE_RESOURCE_DIGEST {}",
            hex::encode(operation_digest(&write).unwrap())
        );
        let delete = Operation {
            params: Some(Params::DeleteWorkspacePaths(DeleteWorkspacePathsRequest {
                relative_paths: vec![".nova/runs/run-1/tmp".into(), ".nova/runs/run-2/tmp".into()],
            })),
            ..base.clone()
        };
        assert_ne!(operation_digest(&delete).unwrap(), digest);
        let mut reordered = delete.clone();
        if let Some(Params::DeleteWorkspacePaths(request)) = &mut reordered.params {
            request.relative_paths.reverse();
        }
        assert_ne!(
            operation_digest(&reordered).unwrap(),
            operation_digest(&delete).unwrap()
        );
        println!(
            "NOVA_DELETE_PATHS_DIGEST {}",
            hex::encode(operation_digest(&delete).unwrap())
        );
    }

    #[cfg(windows)]
    fn symlink_directory(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }
    #[cfg(not(windows))]
    fn symlink_directory(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    fn tmp_layout(root: &Path, run: &str) {
        fs::create_dir_all(root.join(format!(".nova/runs/{run}/tmp/nested"))).unwrap();
        fs::write(root.join(format!(".nova/runs/{run}/tmp/a.txt")), "a").unwrap();
        fs::write(root.join(format!(".nova/runs/{run}/tmp/nested/b.txt")), "b").unwrap();
    }

    #[tokio::test]
    async fn delete_workspace_paths_removes_directories_files_and_missing_idempotently() {
        let workspace = TestWorkspace::new();
        let app = workspace.app();
        tmp_layout(&workspace.0, "run-1");
        fs::create_dir_all(workspace.0.join(".nova/runs/run-2/tmp")).unwrap();
        fs::write(workspace.0.join("keep.txt"), "keep").unwrap();
        let (_id, mut receiver) = submit(
            &app,
            Params::DeleteWorkspacePaths(DeleteWorkspacePathsRequest {
                relative_paths: vec![
                    ".nova/runs/run-1/tmp".into(),
                    ".nova/runs/run-2/tmp".into(),
                    "keep.txt".into(),
                    ".nova/runs/never-existed/tmp".into(),
                ],
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(
            result.status,
            OperationStatus::Succeeded as i32,
            "{:?}",
            result.error
        );
        let Some(ResultPayload::DeleteWorkspacePaths(deleted)) = result.result else {
            panic!("expected delete result")
        };
        assert_eq!(deleted.removed, 3, "不存在的路径幂等成功但不计数");
        assert!(!workspace.0.join(".nova/runs/run-1/tmp").exists());
        assert!(
            !workspace.0.join(".nova/runs/run-1/tmp/nested").exists(),
            "目录整树递归删除"
        );
        assert!(!workspace.0.join("keep.txt").exists());
        assert!(
            workspace.0.join(".nova/runs/run-1").is_dir(),
            "只删除请求的目标，不波及父层"
        );
    }

    #[tokio::test]
    async fn delete_workspace_paths_rejects_whole_batch_without_side_effects() {
        let workspace = TestWorkspace::new();
        let app = workspace.app();
        tmp_layout(&workspace.0, "run-1");
        let mut invalid = vec![
            "../outside".to_string(),
            ".nova/runs/../run-x/tmp".to_string(),
            "/absolute/path".to_string(),
            ".".to_string(),
            String::new(),
            "nul\0segment".to_string(),
        ];
        if cfg!(windows) {
            invalid.push("C:/Windows/tmp".to_string());
        }
        for raw in invalid {
            let (_id, mut receiver) = submit(
                &app,
                Params::DeleteWorkspacePaths(DeleteWorkspacePathsRequest {
                    // 合法 + 非法混合：整笔 INVALID，合法项同样不得被删除。
                    relative_paths: vec![".nova/runs/run-1/tmp".into(), raw.clone()],
                }),
            )
            .await;
            let result = terminal(&mut receiver).await;
            assert_eq!(
                result.status,
                OperationStatus::Failed as i32,
                "{raw:?} must be rejected"
            );
            assert_eq!(
                result.error.unwrap().code,
                ErrorCode::Invalid as i32,
                "{raw:?}"
            );
            assert!(
                workspace.0.join(".nova/runs/run-1/tmp").exists(),
                "{raw:?}: 非法项污染整批时不得有部分执行"
            );
        }
    }

    #[tokio::test]
    async fn delete_workspace_paths_enforces_batch_cap() {
        let workspace = TestWorkspace::new();
        let app = workspace.app();
        let over: Vec<String> = (0..=MAX_DELETE_PATHS)
            .map(|index| format!(".nova/runs/run-{index}/tmp"))
            .collect();
        let (_id, mut receiver) = submit(
            &app,
            Params::DeleteWorkspacePaths(DeleteWorkspacePathsRequest {
                relative_paths: over,
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(result.error.unwrap().code, ErrorCode::Invalid as i32);
        // 空批次同样 INVALID（不做无意义操作）。
        let (_id, mut receiver) = submit(
            &app,
            Params::DeleteWorkspacePaths(DeleteWorkspacePathsRequest {
                relative_paths: Vec::new(),
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(result.error.unwrap().code, ErrorCode::Invalid as i32);
        // 恰好 64 条合法项可执行（目录不存在 → 幂等成功，removed=0）。
        let exact: Vec<String> = (0..MAX_DELETE_PATHS)
            .map(|index| format!(".nova/runs/run-{index}/tmp"))
            .collect();
        let (_id, mut receiver) = submit(
            &app,
            Params::DeleteWorkspacePaths(DeleteWorkspacePathsRequest {
                relative_paths: exact,
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(
            result.status,
            OperationStatus::Succeeded as i32,
            "{:?}",
            result.error
        );
        let Some(ResultPayload::DeleteWorkspacePaths(deleted)) = result.result else {
            panic!("expected delete result")
        };
        assert_eq!(deleted.removed, 0);
    }

    #[tokio::test]
    async fn delete_workspace_paths_unlinks_symlinks_without_entering_targets() {
        let workspace = TestWorkspace::new();
        let app = workspace.app();
        let victim = std::env::temp_dir().join(format!("nova-delete-victim-{}", Uuid::new_v4()));
        fs::create_dir_all(victim.join("inside")).unwrap();
        fs::write(victim.join("inside/precious.txt"), "keep").unwrap();
        fs::create_dir_all(workspace.0.join(".nova/runs/run-9")).unwrap();
        let link = workspace.0.join(".nova/runs/run-9/tmp");
        if symlink_directory(&victim, &link).is_err() {
            eprintln!("symlink creation unsupported on this machine; skipping FS assertion");
            let _ = fs::remove_dir_all(&victim);
            return;
        }
        let (_id, mut receiver) = submit(
            &app,
            Params::DeleteWorkspacePaths(DeleteWorkspacePathsRequest {
                relative_paths: vec![".nova/runs/run-9/tmp".into()],
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(
            result.status,
            OperationStatus::Succeeded as i32,
            "{:?}",
            result.error
        );
        let Some(ResultPayload::DeleteWorkspacePaths(deleted)) = result.result else {
            panic!("expected delete result")
        };
        assert_eq!(deleted.removed, 1);
        assert!(fs::symlink_metadata(&link).is_err(), "符号链接本身已解除");
        assert!(
            victim.join("inside/precious.txt").is_file(),
            "链接目标内容未被进入或删除"
        );
        let _ = fs::remove_dir_all(&victim);
    }

    #[tokio::test]
    async fn delete_workspace_paths_rejects_parent_chain_escaping_the_workspace() {
        let workspace = TestWorkspace::new();
        let app = workspace.app();
        let outside = std::env::temp_dir().join(format!("nova-delete-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("file.txt"), "x").unwrap();
        fs::create_dir_all(workspace.0.join(".nova")).unwrap();
        let link = workspace.0.join(".nova/linked");
        if symlink_directory(&outside, &link).is_err() {
            eprintln!("symlink creation unsupported on this machine; skipping FS assertion");
            let _ = fs::remove_dir_all(&outside);
            return;
        }
        // 父链经符号链接逸出工作区：resolve 拒绝，目标不动。
        let (_id, mut receiver) = submit(
            &app,
            Params::DeleteWorkspacePaths(DeleteWorkspacePathsRequest {
                relative_paths: vec![".nova/linked/file.txt".into()],
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(result.status, OperationStatus::Failed as i32);
        assert_eq!(result.error.unwrap().code, ErrorCode::OutOfWorkspace as i32);
        assert!(outside.join("file.txt").is_file(), "工作区外文件不受影响");
        let _ = fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn read_only_runner_denies_workspace_path_deletes() {
        let workspace = TestWorkspace::new();
        let app = App::new(&Config {
            server: "ws://127.0.0.1:1".into(),
            token: "test".into(),
            workspace: workspace.0.clone(),
            workspace_id: "test".into(),
            display_name: "test".into(),
            runner_id: "test".into(),
            max_concurrency: 1,
            read_only: true,
        })
        .unwrap();
        tmp_layout(&workspace.0, "run-1");
        let (_id, mut receiver) = submit(
            &app,
            Params::DeleteWorkspacePaths(DeleteWorkspacePathsRequest {
                relative_paths: vec![".nova/runs/run-1/tmp".into()],
            }),
        )
        .await;
        let result = terminal(&mut receiver).await;
        assert_eq!(result.status, OperationStatus::Failed as i32);
        assert_eq!(result.error.unwrap().code, ErrorCode::Denied as i32);
        assert!(
            workspace.0.join(".nova/runs/run-1/tmp").exists(),
            "read-only 工作区不得产生删除副作用"
        );
    }
}
