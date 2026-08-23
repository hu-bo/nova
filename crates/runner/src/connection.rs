//! Outbound persistent RunnerConnection client and reconnect lifecycle.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::ReceiverStream;
use tonic::Request;
use tonic::metadata::MetadataValue;
use tonic::transport::Endpoint;

use crate::config::Config;
use crate::execution::Executor;
use crate::pb::runner::runner_connection_client::RunnerConnectionClient;
use crate::pb::runner::{
    Heartbeat, Register, RunnerEnvelope, RunnerState, runner_envelope, server_envelope,
};
use crate::protocol::{self, ConnectionState, SessionEnd};
use crate::workspace::Workspace;

const ENVELOPE_BUFFER: usize = 64;
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(100);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(15);
const KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn run(
    config: Arc<Config>,
    workspace: Arc<Workspace>,
    executor: Arc<Executor>,
    mut shutdown: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let mut delay = INITIAL_RECONNECT_DELAY;
    let mut attempt = 0_u64;
    loop {
        if *shutdown.borrow() {
            executor.cancel_all();
            return Ok(());
        }

        attempt += 1;
        tracing::info!(
            runner_id = %config.runner_id,
            server = %config.server,
            attempt,
            "connecting to agent server"
        );
        let connection = connect_once(config.clone(), workspace.clone(), executor.clone());
        tokio::select! {
            result = connection => {
                executor.cancel_all();
                match result {
                    Ok(SessionEnd::Shutdown) => return Ok(()),
                    Ok(SessionEnd::Disconnected) => {
                        delay = INITIAL_RECONNECT_DELAY;
                        attempt = 0;
                        tracing::warn!(
                            runner_id = %config.runner_id,
                            server = %config.server,
                            retry_in_ms = delay.as_millis(),
                            "runner connection closed; reconnecting"
                        );
                    }
                    Err(error) => tracing::warn!(
                        runner_id = %config.runner_id,
                        server = %config.server,
                        attempt,
                        retry_in_ms = delay.as_millis(),
                        %error,
                        "runner connection failed; reconnecting"
                    ),
                }
            }
            changed = shutdown.changed() => {
                let _ = changed;
                executor.cancel_all();
                return Ok(());
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            changed = shutdown.changed() => {
                let _ = changed;
                executor.cancel_all();
                return Ok(());
            }
        }
        if attempt > 0 {
            delay = (delay * 2).min(MAX_RECONNECT_DELAY);
        }
    }
}

async fn connect_once(
    config: Arc<Config>,
    workspace: Arc<Workspace>,
    executor: Arc<Executor>,
) -> anyhow::Result<SessionEnd> {
    let channel = Endpoint::from_shared(config.server.clone())?
        .connect_timeout(CONNECT_TIMEOUT)
        .tcp_keepalive(Some(KEEP_ALIVE_INTERVAL))
        .http2_keep_alive_interval(KEEP_ALIVE_INTERVAL)
        .keep_alive_timeout(KEEP_ALIVE_TIMEOUT)
        .keep_alive_while_idle(true)
        .connect()
        .await?;
    let mut client = RunnerConnectionClient::new(channel);
    let (outbound, receiver) = mpsc::channel(ENVELOPE_BUFFER);
    outbound
        .send(register_envelope(&config, &workspace))
        .await?;

    let mut request = Request::new(ReceiverStream::new(receiver));
    let authorization: MetadataValue<_> = format!("Bearer {}", config.token).parse()?;
    request
        .metadata_mut()
        .insert("authorization", authorization);
    let mut inbound = client.connect(request).await?.into_inner();
    let accepted = inbound
        .message()
        .await?
        .ok_or_else(|| anyhow::anyhow!("connection closed before Accepted"))?;
    let Some(server_envelope::Payload::Accepted(accepted)) = accepted.payload else {
        anyhow::bail!("first server envelope was not Accepted");
    };
    tracing::info!(
        runner_id = %config.runner_id,
        server = %config.server,
        generation = %accepted.generation,
        heartbeat_interval_ms = accepted.heartbeat_interval_ms,
        "runner registration accepted"
    );

    let state = Arc::new(ConnectionState::default());
    let heartbeat = tokio::spawn(send_heartbeats(
        outbound.clone(),
        config.runner_id.clone(),
        accepted.heartbeat_interval_ms,
        executor.clone(),
        state.clone(),
    ));
    let result = protocol::serve(inbound, outbound, workspace, executor, state).await;
    heartbeat.abort();
    Ok(result?)
}

fn register_envelope(config: &Config, workspace: &Workspace) -> RunnerEnvelope {
    RunnerEnvelope {
        request_id: "register".to_string(),
        payload: Some(runner_envelope::Payload::Register(Register {
            runner_id: config.runner_id.clone(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            capabilities: Vec::new(),
            cpu_count: std::thread::available_parallelism().map_or(1, |count| count.get()) as u32,
            memory_bytes: 0,
            max_concurrency: config.max_concurrency as u32,
            labels: HashMap::new(),
            workspace: workspace.root().to_string_lossy().into_owned(),
        })),
    }
}

async fn send_heartbeats(
    outbound: mpsc::Sender<RunnerEnvelope>,
    runner_id: String,
    interval_ms: u32,
    executor: Arc<Executor>,
    state: Arc<ConnectionState>,
) {
    let mut interval =
        tokio::time::interval(Duration::from_millis(u64::from(interval_ms.max(100))));
    loop {
        interval.tick().await;
        let runner_state = if state.is_draining() {
            RunnerState::Draining
        } else if executor.is_busy() {
            RunnerState::Busy
        } else {
            RunnerState::Ready
        };
        let envelope = RunnerEnvelope {
            request_id: String::new(),
            payload: Some(runner_envelope::Payload::Heartbeat(Heartbeat {
                runner_id: runner_id.clone(),
                state: runner_state as i32,
                running: executor.running_count() as u32,
            })),
        };
        if outbound.send(envelope).await.is_err() {
            return;
        }
        tracing::debug!(%runner_id, running = executor.running_count(), "runner heartbeat sent");
    }
}
