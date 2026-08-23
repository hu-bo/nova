//! Output chunking and backpressure. docs/runner.md §5: chunk at 8 KB or 50 ms (whichever
//! comes first), stdout/stderr are separate streams (never merged), and — the important one —
//! "gRPC 流写阻塞时暂停读取子进程 pipe,不在内存里堆积". A bounded channel gives us that last
//! property for free: once it's full, `send().await` blocks, so the read loop stops pulling
//! more bytes out of the pipe until the consumer drains it.

use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{ChildStderr, ChildStdout};
use tokio::sync::mpsc;

use crate::pb::execution::OutputStream as Stream;

const CHUNK_BYTES: usize = 8 * 1024;
const CHUNK_INTERVAL: Duration = Duration::from_millis(50);
/// Deliberately small: this is the backpressure knob, not a buffer.
const CHANNEL_CAPACITY: usize = 2;

pub struct OutputChunk {
    pub stream: Stream,
    pub data: Vec<u8>,
}

/// Spawns one reader task per stream; both feed the same channel. The channel closes once
/// both readers hit EOF (or error), which happens only once the process has exited or been
/// killed — callers use that to know output draining is done.
pub fn spawn_readers(stdout: ChildStdout, stderr: ChildStderr) -> mpsc::Receiver<OutputChunk> {
    let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
    tokio::spawn(read_and_chunk(stdout, Stream::Stdout, tx.clone()));
    tokio::spawn(read_and_chunk(stderr, Stream::Stderr, tx));
    rx
}

async fn read_and_chunk(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    stream: Stream,
    tx: mpsc::Sender<OutputChunk>,
) {
    let mut read_buf = [0u8; CHUNK_BYTES];
    let mut pending: Vec<u8> = Vec::with_capacity(CHUNK_BYTES);
    let mut last_flush = tokio::time::Instant::now();

    loop {
        let elapsed = last_flush.elapsed();
        let until_flush = CHUNK_INTERVAL.saturating_sub(elapsed);
        tokio::select! {
            read = reader.read(&mut read_buf) => {
                match read {
                    Ok(0) | Err(_) => break, // EOF or a broken pipe — either way, done.
                    Ok(n) => {
                        pending.extend_from_slice(&read_buf[..n]);
                        if pending.len() >= CHUNK_BYTES {
                            if tx.send(OutputChunk { stream, data: std::mem::take(&mut pending) }).await.is_err() {
                                return; // consumer gone (execution finished/dropped) — stop reading.
                            }
                            last_flush = tokio::time::Instant::now();
                        }
                    }
                }
            }
            _ = tokio::time::sleep(until_flush), if !pending.is_empty() => {
                if tx.send(OutputChunk { stream, data: std::mem::take(&mut pending) }).await.is_err() {
                    return;
                }
                last_flush = tokio::time::Instant::now();
            }
        }
    }

    if !pending.is_empty() {
        let _ = tx
            .send(OutputChunk {
                stream,
                data: pending,
            })
            .await;
    }
}
