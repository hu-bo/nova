use crate::{
    config::Config,
    digest::operation_digest,
    proto::nova::{
        common::v1::{Error as WireError, ErrorCode},
        execution::v1::OutputStream,
        runner::v1::{
            ApplyPatchResult, FileEntry, ListFilesResult, Operation, OperationOutput,
            OperationResult, OperationStatus, ReadFileResult, ReadTextFileResult, ReconcileRequest,
            RunnerEnvelope, SearchMatch, SearchResult, WriteFileResult, operation::Params,
            operation_result::Result as ResultPayload, runner_envelope::Payload as RunnerPayload,
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
use uuid::Uuid;

const RECEIPT_LIMIT: usize = 1_024;
const TOMBSTONE_LIMIT: usize = 65_536;
const RETAINED_BYTES_LIMIT: usize = 64 * 1024 * 1024;
const OUTPUT_RING_LIMIT: usize = 256 * 1024;
const COMMAND_OUTPUT_LIMIT: usize = 10 * 1024 * 1024;
const FILE_LIMIT: usize = 20 * 1024 * 1024;
const FILE_CHUNK_LIMIT: usize = 256 * 1024;
const TEXT_LIMIT: usize = 1024 * 1024;

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
        }))
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
        &self,
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
                Params::WriteFile(_) | Params::ApplyPatch(_) | Params::ExecuteCommand(_)
            )
        {
            return Err((
                OperationStatus::Failed,
                ErrorCode::Denied,
                "Workspace is registered read-only.".into(),
            ));
        }
        match params {
            Params::ListFiles(request) => self
                .list_files(
                    &request.path,
                    request.depth,
                    request.max_entries,
                    &cancel,
                    operation.expires_at_unix_ms,
                )
                .map(ResultPayload::ListFiles)
                .map_err(error_to_failure),
            Params::ReadFile(request) => self
                .read_file(
                    &request.path,
                    request.offset,
                    request.max_bytes,
                    &cancel,
                    operation.expires_at_unix_ms,
                )
                .map(ResultPayload::ReadFile)
                .map_err(error_to_failure),
            Params::ReadText(request) => self
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
            Params::Search(request) => self
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
            Params::WriteFile(request) => self
                .write_file(
                    &request.path,
                    &request.contents,
                    &request.expected_sha256,
                    &cancel,
                    operation.expires_at_unix_ms,
                )
                .map(ResultPayload::WriteFile)
                .map_err(error_to_failure),
            Params::ApplyPatch(request) => self
                .apply_patch(
                    &request.path,
                    &request.edits,
                    &request.expected_sha256,
                    &cancel,
                    operation.expires_at_unix_ms,
                )
                .map(ResultPayload::ApplyPatch)
                .map_err(error_to_failure),
            Params::ExecuteCommand(request) => self
                .execute_command(record, request, &mut cancel, events)
                .await
                .map(ResultPayload::ExecuteCommand),
        }
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
            .standard_filters(false)
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
            if error.kind() == ErrorKind::NotFound {
                (
                    OperationStatus::Failed,
                    ErrorCode::SpawnFailed,
                    "Executable could not be found.".into(),
                )
            } else {
                (
                    OperationStatus::Failed,
                    ErrorCode::SpawnFailed,
                    "Executable could not be started.".into(),
                )
            }
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
        if !request.stdin.is_empty() {
            let mut input = child.stdin.take().ok_or((
                OperationStatus::Failed,
                ErrorCode::Io,
                "stdin pipe is unavailable.".into(),
            ))?;
            let bytes = request.stdin.clone();
            tokio::spawn(async move {
                let _ = input.write_all(&bytes).await;
            });
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
                    Err(_) => out_done = true,
                },
                read = stderr.read(&mut err_chunk), if !err_done => match read {
                    Ok(0) => err_done = true,
                    Ok(count) => collect_output(self, record, 1, &err_chunk[..count], &mut buffers[1], &mut captured_bytes, &mut output_truncated).await,
                    Err(_) => err_done = true,
                },
            }
        }
        if let Some(status) = terminal {
            terminate_process_tree(pid);
            let _ = child.start_kill();
            let _ = child.wait().await;
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
            exit_code: status.code().unwrap_or(-1),
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

fn encoded_size(result: &OperationResult) -> usize {
    prost::Message::encoded_len(result)
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
        WorkspaceError::Io(ref io) if io.kind() == ErrorKind::NotFound => ErrorCode::NotFound,
        WorkspaceError::Io(ref io) if io.kind() == ErrorKind::PermissionDenied => {
            ErrorCode::Permission
        }
        WorkspaceError::Io(_) => ErrorCode::Io,
    };
    let message = match code {
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
