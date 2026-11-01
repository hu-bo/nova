mod config;
mod digest;
mod engine;
mod workspace;

mod proto {
    #![allow(dead_code)]
    pub mod nova {
        pub mod common {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/nova.common.v1.rs"));
            }
        }
        pub mod execution {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/nova.execution.v1.rs"));
            }
        }
        pub mod runner {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/nova.runner.v1.rs"));
            }
        }
    }
}

use crate::{
    config::{Cli, Config},
    engine::{App, EventQueues},
    proto::nova::runner::v1::{
        self as wire, runner_envelope::Payload as RunnerPayload,
        server_envelope::Payload as ServerPayload,
    },
};
use futures_util::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use std::{sync::Arc, time::Duration};
use tokio::{sync::mpsc, time::Instant};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};
use tracing::{info, warn};
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nova_runner=info".into()),
        )
        .init();
    let config = Config::load(Cli::parse())?;
    info!(runner_id = %config.runner_id, workspace_id = %config.workspace_id, "Runner starting");
    let app = App::new(&config)?;
    run_reconnecting(app, config).await?;
    Ok(())
}

async fn run_reconnecting(app: Arc<App>, config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect_once(app.clone(), &config).await {
            Ok(()) => warn!("Runner WebSocket disconnected"),
            Err(error) => {
                warn!(reason = %error, retry_ms = backoff.as_millis(), "Runner connection failed")
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(600));
    }
}

async fn connect_once(app: Arc<App>, config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    let connect_deadline = Instant::now() + Duration::from_secs(10);
    let mut request = config.server.as_str().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {}", config.token))?,
    );
    let (socket, _) = tokio::time::timeout_at(connect_deadline, connect_async(request)).await??;
    let (mut sink, mut stream) = socket.split();
    let hello = wire::RunnerEnvelope {
        request_id: Uuid::new_v4().to_string(),
        payload: Some(RunnerPayload::Hello(wire::RunnerHello {
            runner_id: config.runner_id.clone(),
            boot_id: app.boot_id.clone(),
            protocol_version: 2,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            platform: std::env::consts::OS.to_owned(),
            workspaces: vec![wire::WorkspaceRegistration {
                workspace_id: config.workspace_id.clone(),
                display_name: config.display_name.clone(),
                permission: if config.read_only {
                    wire::WorkspacePermission::ReadOnly as i32
                } else {
                    wire::WorkspacePermission::ReadWrite as i32
                },
            }],
            capabilities: vec![
                "filesystem".into(),
                "search".into(),
                "exec".into(),
                "reconcile".into(),
            ],
            max_concurrency: config.max_concurrency as u32,
        })),
    };
    sink.send(Message::Binary(hello.encode_to_vec().into()))
        .await?;
    let first = tokio::time::timeout(Duration::from_secs(10), stream.next())
        .await?
        .ok_or("WebSocket closed before ServerWelcome")??;
    let Message::Binary(bytes) = first else {
        return Err("ServerWelcome must be binary Protobuf".into());
    };
    let welcome = wire::ServerEnvelope::decode(bytes)?;
    let Some(ServerPayload::Welcome(welcome)) = welcome.payload else {
        return Err("Runner connection was not admitted by the SDK".into());
    };
    if welcome.protocol_version != 2 {
        return Err("SDK protocol version mismatch".into());
    }
    info!(epoch = %welcome.connection_epoch, "Runner connected and admitted");

    let (control_tx, mut control_rx) = mpsc::unbounded_channel();
    let (output_tx, mut output_rx) = mpsc::channel(512);
    let events = EventQueues {
        control: control_tx.clone(),
        output: output_tx.clone(),
    };
    app.set_events(events.clone()).await;
    app.send_reconcile(&control_tx).await;
    let mut heartbeat = tokio::time::interval(Duration::from_millis(u64::from(
        welcome.heartbeat_interval_ms.max(1_000),
    )));
    let mut heartbeat_seq = 0_u64;
    loop {
        tokio::select! {
            biased;
            Some(envelope) = control_rx.recv() => sink.send(Message::Binary(envelope.encode_to_vec().into())).await?,
            message = stream.next() => {
                let Some(message) = message else { return Ok(()); };
                match message? {
                    Message::Binary(bytes) => {
                        if bytes.len() > 16 * 1024 * 1024 {
                            return Err("SDK message exceeds the 16 MiB Runner frame limit".into());
                        }
                        let envelope = wire::ServerEnvelope::decode(bytes)?;
                        match envelope.payload {
                            Some(ServerPayload::Operation(operation)) => {
                                app.submit(envelope.request_id, operation, &events).await;
                            }
                            Some(ServerPayload::Cancel(cancel)) => app.cancel(&cancel.operation_id).await,
                            Some(ServerPayload::Query(query)) => app.query(envelope.request_id, &query.operation_id, &control_tx).await,
                            Some(ServerPayload::Acknowledge(ack)) => app.ack_result(&ack.operation_id, &ack.boot_id).await,
                            Some(ServerPayload::AcknowledgeOutput(ack)) => app.ack_output(&ack.operation_id, &ack.boot_id, ack.sequence).await,
                            Some(ServerPayload::Rejection(error)) => return Err(format!("SDK rejected connection: {}", error.message).into()),
                            Some(ServerPayload::Welcome(_)) | None => return Err("Unexpected SDK message".into()),
                        }
                    }
                    Message::Ping(bytes) => sink.send(Message::Pong(bytes)).await?,
                    Message::Close(_) => return Ok(()),
                    Message::Pong(_) | Message::Frame(_) | Message::Text(_) => {}
                }
            }
            _ = heartbeat.tick() => {
                heartbeat_seq = heartbeat_seq.saturating_add(1);
                let (active, busy) = app.heartbeat_state().await;
                let frame = wire::RunnerEnvelope {
                    request_id: Uuid::new_v4().to_string(),
                    payload: Some(RunnerPayload::Heartbeat(wire::Heartbeat {
                        boot_id: app.boot_id.clone(),
                        sequence: heartbeat_seq,
                        state: if busy { wire::RunnerState::Busy as i32 } else { wire::RunnerState::Idle as i32 },
                        active_operation_ids: active,
                })),
                };
                sink.send(Message::Binary(frame.encode_to_vec().into())).await?;
            }
            Some(envelope) = output_rx.recv() => {
                let sent = tokio::time::timeout(
                    Duration::from_millis(250),
                    sink.send(Message::Binary(envelope.encode_to_vec().into())),
                ).await;
                match sent {
                    Ok(result) => result?,
                    Err(_) => return Err("Runner output transport was congested".into()),
                }
            }
        }
    }
}
