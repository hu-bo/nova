//! Connect-stream message routing. Execution, workspace and scheduling state stay in their
//! owning modules; this file only translates envelopes and applies connection-level control.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tonic::Streaming;

use crate::error::RunnerError;
use crate::execution::{ExecuteParams, Executor};
use crate::pb::execution::{
    CancelResponse, ExecuteRequest, ExecutionEvent, ExecutionStatus, FileChunk, FileOpRequest,
    FileOpResponse, Finished, ListResult, ReadFileRequest, WriteFileRequest, WriteFileResponse,
    execution_event, file_op_request, file_op_response,
};
use crate::pb::runner::{RunnerEnvelope, ServerEnvelope, runner_envelope, server_envelope};
use crate::workspace::{Workspace, file, grep};

const FILE_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub struct ConnectionState {
    draining: AtomicBool,
}

impl ConnectionState {
    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    fn drain(&self) {
        self.draining.store(true, Ordering::SeqCst);
    }
}

pub enum SessionEnd {
    Disconnected,
    Shutdown,
}

pub async fn serve(
    mut inbound: Streaming<ServerEnvelope>,
    outbound: mpsc::Sender<RunnerEnvelope>,
    workspace: Arc<Workspace>,
    executor: Arc<Executor>,
    state: Arc<ConnectionState>,
) -> Result<SessionEnd, tonic::Status> {
    let mut writes: HashMap<String, file::WriteHandle> = HashMap::new();

    while let Some(envelope) = inbound.message().await? {
        let request_id = envelope.request_id;
        match envelope.payload {
            Some(server_envelope::Payload::Execute(request)) => {
                handle_execute(
                    request,
                    outbound.clone(),
                    workspace.clone(),
                    executor.clone(),
                    state.clone(),
                )
                .await;
            }
            Some(server_envelope::Payload::Cancel(request)) => {
                let found = executor.cancel(&request.execution_id);
                send(
                    &outbound,
                    request_id,
                    runner_envelope::Payload::CancelResponse(CancelResponse { found }),
                )
                .await
                .map_err(|_| tonic::Status::unavailable("connection closed"))?;
            }
            Some(server_envelope::Payload::FileOp(request)) => {
                match handle_file_op(&workspace, request) {
                    Ok(response) => send(
                        &outbound,
                        request_id,
                        runner_envelope::Payload::FileOpResponse(response),
                    )
                    .await
                    .map_err(|_| tonic::Status::unavailable("connection closed"))?,
                    Err(error) => send_error(&outbound, request_id, error).await?,
                }
            }
            Some(server_envelope::Payload::ReadFile(request)) => {
                if let Err(error) =
                    handle_read_file(&outbound, &workspace, &request_id, request).await
                {
                    send_error(&outbound, request_id, error).await?;
                }
            }
            Some(server_envelope::Payload::WriteFile(request)) => {
                if let Err(error) =
                    handle_write_file(&outbound, &workspace, &request_id, request, &mut writes)
                        .await
                {
                    writes.remove(&request_id);
                    send_error(&outbound, request_id, error).await?;
                }
            }
            Some(server_envelope::Payload::Drain(_)) => state.drain(),
            Some(server_envelope::Payload::Shutdown(_)) => {
                state.drain();
                executor.cancel_all();
                return Ok(SessionEnd::Shutdown);
            }
            Some(server_envelope::Payload::Accepted(_)) | None => {
                send_error(
                    &outbound,
                    request_id,
                    RunnerError::invalid("unexpected server envelope"),
                )
                .await?;
            }
        }
    }

    Ok(SessionEnd::Disconnected)
}

async fn handle_execute(
    request: ExecuteRequest,
    outbound: mpsc::Sender<RunnerEnvelope>,
    workspace: Arc<Workspace>,
    executor: Arc<Executor>,
    state: Arc<ConnectionState>,
) {
    let execution_id = request.execution_id.clone();
    let result =
        prepare_execute(&workspace, &request, &state).and_then(|params| executor.execute(params));
    match result {
        Ok(events) => {
            tokio::spawn(async move {
                tokio::pin!(events);
                while let Some(event) = events.next().await {
                    if send(
                        &outbound,
                        String::new(),
                        runner_envelope::Payload::ExecutionEvent(event),
                    )
                    .await
                    .is_err()
                    {
                        break;
                    }
                }
            });
        }
        Err(error) => {
            let event = rejected_event(execution_id, error);
            let _ = send(
                &outbound,
                String::new(),
                runner_envelope::Payload::ExecutionEvent(event),
            )
            .await;
        }
    }
}

fn prepare_execute(
    workspace: &Workspace,
    request: &ExecuteRequest,
    state: &ConnectionState,
) -> Result<ExecuteParams, RunnerError> {
    if state.is_draining() {
        return Err(RunnerError::busy("Runner is draining"));
    }
    reject_unsupported(request)?;
    let cwd = if request.cwd.is_empty() {
        workspace.root().to_path_buf()
    } else {
        workspace.resolve(&request.cwd)?
    };
    Ok(ExecuteParams {
        execution_id: request.execution_id.clone(),
        command: request.command.clone(),
        args: request.args.clone(),
        cwd,
        env: request.env.clone(),
        timeout_ms: request.timeout_ms,
        stdin: request.stdin.clone(),
    })
}

fn reject_unsupported(request: &ExecuteRequest) -> Result<(), RunnerError> {
    if request
        .resources
        .as_ref()
        .is_some_and(|r| r.cpu_millis != 0 || r.memory_bytes != 0)
    {
        return Err(RunnerError::unsupported(
            "ResourceLimits is not implemented in Phase 1",
        ));
    }
    if request
        .sandbox
        .as_ref()
        .is_some_and(|s| s.network || s.readonly_fs)
    {
        return Err(RunnerError::unsupported(
            "Sandbox is not implemented in Phase 1",
        ));
    }
    Ok(())
}

fn rejected_event(execution_id: String, error: RunnerError) -> ExecutionEvent {
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    ExecutionEvent {
        execution_id,
        sequence: 1,
        ts: Some(prost_types::Timestamp {
            seconds: duration.as_secs() as i64,
            nanos: duration.subsec_nanos() as i32,
        }),
        event: Some(execution_event::Event::Finished(Finished {
            status: ExecutionStatus::Failed as i32,
            exit_code: -1,
            error: Some(error.into_wire()),
            duration_ms: 0,
        })),
    }
}

fn handle_file_op(
    workspace: &Workspace,
    request: FileOpRequest,
) -> Result<FileOpResponse, RunnerError> {
    let result = match request
        .op
        .ok_or_else(|| RunnerError::invalid("missing file operation"))?
    {
        file_op_request::Op::Stat(op) => {
            file_op_response::Result::Info(file::stat(workspace, &op.path)?)
        }
        file_op_request::Op::List(op) => file_op_response::Result::List(ListResult {
            entries: file::list(workspace, &op.path, op.depth)?,
        }),
        file_op_request::Op::Remove(op) => {
            file::remove(workspace, &op.path, op.recursive)?;
            file_op_response::Result::Ok(())
        }
        file_op_request::Op::Rename(op) => {
            file::rename(workspace, &op.from, &op.to)?;
            file_op_response::Result::Ok(())
        }
        file_op_request::Op::Mkdir(op) => {
            file::mkdir(workspace, &op.path)?;
            file_op_response::Result::Ok(())
        }
        file_op_request::Op::TempDir(op) => {
            file_op_response::Result::Path(file::temp_dir(workspace, &op.prefix)?)
        }
        file_op_request::Op::Grep(op) => {
            let (matches, total, truncated) =
                grep::grep(workspace, &op.pattern, &op.path, &op.glob, op.max_results)?;
            file_op_response::Result::Grep(crate::pb::execution::GrepResult {
                matches,
                total,
                truncated,
            })
        }
    };
    Ok(FileOpResponse {
        result: Some(result),
    })
}

async fn handle_read_file(
    outbound: &mpsc::Sender<RunnerEnvelope>,
    workspace: &Workspace,
    request_id: &str,
    request: ReadFileRequest,
) -> Result<(), RunnerError> {
    let (data, total_size) =
        file::read_range(workspace, &request.path, request.offset, request.limit).await?;
    if data.is_empty() {
        send(
            outbound,
            request_id.to_string(),
            runner_envelope::Payload::FileChunk(FileChunk {
                data: Vec::new(),
                eof: true,
                total_size,
            }),
        )
        .await
        .map_err(|_| RunnerError::io("connection closed"))?;
        return Ok(());
    }
    let count = data.len().div_ceil(FILE_CHUNK_BYTES);
    for (index, chunk) in data.chunks(FILE_CHUNK_BYTES).enumerate() {
        send(
            outbound,
            request_id.to_string(),
            runner_envelope::Payload::FileChunk(FileChunk {
                data: chunk.to_vec(),
                eof: index + 1 == count,
                total_size,
            }),
        )
        .await
        .map_err(|_| RunnerError::io("connection closed"))?;
    }
    Ok(())
}

async fn handle_write_file(
    outbound: &mpsc::Sender<RunnerEnvelope>,
    workspace: &Workspace,
    request_id: &str,
    request: WriteFileRequest,
    writes: &mut HashMap<String, file::WriteHandle>,
) -> Result<(), RunnerError> {
    if !writes.contains_key(request_id) {
        if request.path.is_empty() {
            return Err(RunnerError::invalid("first write chunk must include path"));
        }
        writes.insert(
            request_id.to_string(),
            file::WriteHandle::open(workspace, &request.path, request.append).await?,
        );
    }
    let handle = writes
        .get_mut(request_id)
        .expect("write handle was inserted");
    handle.write_chunk(&request.data).await?;
    if request.eof {
        let handle = writes
            .remove(request_id)
            .expect("write handle exists until eof");
        send(
            outbound,
            request_id.to_string(),
            runner_envelope::Payload::WriteFileResponse(WriteFileResponse {
                bytes_written: handle.bytes_written,
                created: handle.created,
            }),
        )
        .await
        .map_err(|_| RunnerError::io("connection closed"))?;
    }
    Ok(())
}

async fn send(
    outbound: &mpsc::Sender<RunnerEnvelope>,
    request_id: String,
    payload: runner_envelope::Payload,
) -> Result<(), mpsc::error::SendError<RunnerEnvelope>> {
    outbound
        .send(RunnerEnvelope {
            request_id,
            payload: Some(payload),
        })
        .await
}

async fn send_error(
    outbound: &mpsc::Sender<RunnerEnvelope>,
    request_id: String,
    error: RunnerError,
) -> Result<(), tonic::Status> {
    send(
        outbound,
        request_id,
        runner_envelope::Payload::Error(error.into_wire()),
    )
    .await
    .map_err(|_| tonic::Status::unavailable("connection closed"))
}
