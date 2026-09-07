//! Outbound persistent RunnerConnection client and reconnect lifecycle.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use hyper_util::client::legacy::connect::HttpConnector;
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::ReceiverStream;
use tonic::Request;
use tonic::metadata::MetadataValue;
use tonic::transport::{Channel, Endpoint};
use tower::{Service, service_fn};

use crate::config::Config;
use crate::execution::Executor;
use crate::pb::runner::runner_connection_client::RunnerConnectionClient;
use crate::pb::runner::{
    Heartbeat, Register, RunnerEnvelope, RunnerState, runner_envelope, server_envelope,
};
use crate::protocol::{self, ConnectionState, SessionEnd};
use crate::workspace::Workspace;

const ENVELOPE_BUFFER: usize = 64;
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(10 * 60);
const MAX_CONNECT_ATTEMPTS: u64 = 1_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
// Keep transport probes slower than the application heartbeat. A short PING timeout can
// turn transient proxy/backpressure delay into a full h2 stream reset.
const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(60);
const KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(20);

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
                        // A completed connect_once means registration succeeded. Do not carry
                        // failures from an older server outage into the next outage.
                        attempt = 0;
                        delay = INITIAL_RECONNECT_DELAY;
                        tracing::warn!(
                            runner_id = %config.runner_id,
                            server = %config.server,
                            retry_in_ms = delay.as_millis(),
                            "runner connection closed; reconnecting"
                        );
                    }
                    Err(error) => {
                        tracing::warn!(
                            runner_id = %config.runner_id,
                            server = %config.server,
                            attempt,
                            retry_in_ms = delay.as_millis(),
                            category = classify_connection_error(&error),
                            error_chain = %error_chain(&error),
                            error_debug = ?error,
                            %error,
                            "runner connection failed; reconnecting"
                        );
                    }
                }
            }
            changed = shutdown.changed() => {
                let _ = changed;
                executor.cancel_all();
                return Ok(());
            }
        }

        if attempt >= MAX_CONNECT_ATTEMPTS {
            return Err(anyhow::anyhow!(
                "runner connection failed after {MAX_CONNECT_ATTEMPTS} attempts"
            ));
        }

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            changed = shutdown.changed() => {
                let _ = changed;
                executor.cancel_all();
                return Ok(());
            }
        }
        delay = next_reconnect_delay(delay);
    }
}

fn error_chain(error: &anyhow::Error) -> String {
    error
        .chain()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(" -> ")
}

fn classify_connection_error(error: &anyhow::Error) -> &'static str {
    let text = error_chain(error).to_ascii_lowercase();
    if text.contains("dns error")
        || text.contains("failed to lookup address information")
        || text.contains("name or service not known")
    {
        "dns_resolution_error"
    } else if text.contains("h2") || text.contains("http/2") || text.contains("transport") {
        "transport_h2_error"
    } else if text.contains("connection closed") || text.contains("senderror") {
        "stream_send_error"
    } else {
        "connect_or_protocol_error"
    }
}

fn next_reconnect_delay(current: Duration) -> Duration {
    current
        .checked_mul(2)
        .unwrap_or(MAX_RECONNECT_DELAY)
        .min(MAX_RECONNECT_DELAY)
}

async fn connect_channel(server: &str, connect_ip: Option<IpAddr>) -> anyhow::Result<Channel> {
    let endpoint = Endpoint::from_shared(server.to_owned())?
        .connect_timeout(CONNECT_TIMEOUT)
        .tcp_keepalive(Some(KEEP_ALIVE_INTERVAL))
        .http2_keep_alive_interval(KEEP_ALIVE_INTERVAL)
        .keep_alive_timeout(KEEP_ALIVE_TIMEOUT)
        .keep_alive_while_idle(true);
    let Some(ip) = connect_ip else {
        return Ok(endpoint.connect().await?);
    };

    let mut http = HttpConnector::new();
    http.enforce_http(false);
    http.set_nodelay(true);
    http.set_keepalive(Some(KEEP_ALIVE_INTERVAL));
    http.set_connect_timeout(Some(CONNECT_TIMEOUT));
    // Rewrite only the TCP connector URI. Tonic keeps the original URI for
    // HTTP/2 authority and TLS hostname verification.
    let connector = service_fn(move |uri: tonic::codegen::http::Uri| {
        let mut http = http.clone();
        async move {
            let port = uri
                .port_u16()
                .unwrap_or(if uri.scheme_str() == Some("https") {
                    443
                } else {
                    80
                });
            let mut parts = uri.into_parts();
            parts.authority = Some(SocketAddr::new(ip, port).to_string().parse()?);
            let target = tonic::codegen::http::Uri::from_parts(parts)?;
            http.call(target)
                .await
                .map_err(Into::<Box<dyn std::error::Error + Send + Sync>>::into)
        }
    });
    Ok(endpoint.connect_with_connector(connector).await?)
}

async fn connect_once(
    config: Arc<Config>,
    workspace: Arc<Workspace>,
    executor: Arc<Executor>,
) -> anyhow::Result<SessionEnd> {
    let channel = connect_channel(&config.server, config.connect_ip).await?;
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

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn connection_preserves_authority_with_and_without_ip_override() {
        use hyper_util::rt::{TokioExecutor, TokioIo};
        use tokio::net::TcpListener;
        use tonic::codegen::http::{Response, uri::PathAndQuery};

        for (host, ip) in [
            ("unresolvable.invalid", Some("127.0.0.1".parse().unwrap())),
            ("127.0.0.1", None),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let authority = format!("{host}:{}", listener.local_addr().unwrap().port());
            let expected = authority.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let tx = std::sync::Mutex::new(Some(tx));
                let service = hyper::service::service_fn(
                    move |request: hyper::Request<hyper::body::Incoming>| {
                        assert_eq!(request.uri().authority().unwrap().as_str(), expected);
                        assert_eq!(request.uri().path(), "/test.Service/Call");
                        tx.lock().unwrap().take().unwrap().send(()).unwrap();
                        async {
                            Ok::<_, std::convert::Infallible>(
                                Response::builder()
                                    .header("content-type", "application/grpc")
                                    .header("grpc-status", "12")
                                    .body(tonic::body::empty_body())
                                    .unwrap(),
                            )
                        }
                    },
                );
                let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                let channel = super::connect_channel(&format!("http://{authority}"), ip)
                    .await
                    .unwrap();
                let mut grpc = tonic::client::Grpc::new(channel);
                grpc.ready().await.unwrap();
                let result: Result<tonic::Response<crate::pb::runner::Heartbeat>, _> = grpc
                    .unary(
                        tonic::Request::new(crate::pb::runner::Heartbeat::default()),
                        PathAndQuery::from_static("/test.Service/Call"),
                        tonic::codec::ProstCodec::default(),
                    )
                    .await;
                assert_eq!(result.unwrap_err().code(), tonic::Code::Unimplemented);
                rx.await.unwrap();
            })
            .await
            .unwrap();
            server.abort();
        }
    }

    use super::{
        INITIAL_RECONNECT_DELAY, MAX_RECONNECT_DELAY, classify_connection_error,
        next_reconnect_delay,
    };
    use std::time::Duration;

    #[test]
    fn reconnect_delay_grows_from_one_second_to_ten_minutes() {
        let delays = [
            INITIAL_RECONNECT_DELAY,
            next_reconnect_delay(INITIAL_RECONNECT_DELAY),
            next_reconnect_delay(Duration::from_secs(2)),
            next_reconnect_delay(Duration::from_secs(4)),
            next_reconnect_delay(Duration::from_secs(8 * 60)),
            next_reconnect_delay(MAX_RECONNECT_DELAY),
        ];

        assert_eq!(delays[0], Duration::from_secs(1));
        assert_eq!(delays[1], Duration::from_secs(2));
        assert_eq!(delays[2], Duration::from_secs(4));
        assert_eq!(delays[3], Duration::from_secs(8));
        assert_eq!(delays[4], Duration::from_secs(10 * 60));
        assert_eq!(delays[5], MAX_RECONNECT_DELAY);
    }

    #[test]
    fn classifies_dns_failure_before_the_outer_transport_error() {
        let error = anyhow::anyhow!("failed to lookup address information: Try again")
            .context("dns error")
            .context("transport error");

        assert_eq!(classify_connection_error(&error), "dns_resolution_error");
    }

    #[test]
    fn keeps_http2_failures_in_the_transport_category() {
        let error = anyhow::anyhow!("connection error detected: frame with invalid size")
            .context("http2 error")
            .context("transport error");

        assert_eq!(classify_connection_error(&error), "transport_h2_error");
    }
}
