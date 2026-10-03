//! WorkerHost port: spawns the worker binary and talks JSON-RPC over its stdin/stdout.
//!
//! One worker process at a time. A crash, a timeout (hang) or the memory ceiling kills it;
//! the next call starts a fresh one.

use librarium_contracts::ports::WorkerHost;
use librarium_contracts::rpc::{RpcRequest, RpcResponse};
use librarium_contracts::{BackendError, ErrorCode, Result};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct ProcessWorkerHost {
    binary: PathBuf,
    memory_ceiling: u64,
    state: Mutex<Option<Running>>,
    next_id: Mutex<u64>,
    /// The running worker's PID (0 when none), readable while a call is in flight.
    pid: std::sync::atomic::AtomicU32,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

impl ProcessWorkerHost {
    /// `memory_ceiling` is in bytes of resident memory (the brief sets 2 GB).
    pub fn new(binary: impl Into<PathBuf>, memory_ceiling: u64) -> Self {
        ProcessWorkerHost {
            binary: binary.into(),
            memory_ceiling,
            state: Mutex::new(None),
            next_id: Mutex::new(1),
            pid: std::sync::atomic::AtomicU32::new(0),
        }
    }

    pub fn pid(&self) -> Option<u32> {
        match self.pid.load(std::sync::atomic::Ordering::SeqCst) {
            0 => None,
            p => Some(p),
        }
    }

    fn spawn(&self) -> Result<Running> {
        let mut child = Command::new(&self.binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| worker_err(format!("cannot start worker {}: {e}", self.binary.display())))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("worker-stdout".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| worker_err(e.to_string()))?;
        Ok(Running { child, stdin, lines: rx })
    }
}

fn worker_err(m: impl Into<String>) -> BackendError {
    BackendError::new(ErrorCode::Worker, m)
}

fn kill(mut r: Running) {
    let _ = r.child.kill();
    let _ = r.child.wait();
}

impl WorkerHost for ProcessWorkerHost {
    fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = {
            let mut n = self.next_id.lock().unwrap();
            *n += 1;
            *n
        };
        let mut state = self.state.lock().unwrap();
        if state.is_none() {
            let r = self.spawn()?;
            self.pid.store(r.child.id(), std::sync::atomic::Ordering::SeqCst);
            *state = Some(r);
        }
        let running = state.as_mut().unwrap();
        let mut line = serde_json::to_vec(&RpcRequest::new(id, method, params)).unwrap();
        line.push(b'\n');
        if running.stdin.write_all(&line).and_then(|_| running.stdin.flush()).is_err() {
            kill(state.take().unwrap());
            return Err(worker_err("the worker stopped before the call"));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                kill(state.take().unwrap());
                return Err(worker_err(format!("the worker timed out after {timeout:?} on {method}"))
                    .with_data(serde_json::json!({ "reason": "timeout" })));
            }
            let slice = (deadline - now).min(Duration::from_millis(250));
            match state.as_ref().unwrap().lines.recv_timeout(slice) {
                Ok(text) => {
                    let resp: RpcResponse =
                        serde_json::from_str(&text).map_err(|e| worker_err(format!("bad worker reply: {e}")))?;
                    if resp.id != id {
                        continue;
                    }
                    return resp.into_result();
                }
                Err(RecvTimeoutError::Timeout) => {
                    let pid = state.as_ref().unwrap().child.id();
                    if let Some(rss) = resident_bytes(pid) {
                        if rss > self.memory_ceiling {
                            kill(state.take().unwrap());
                            return Err(worker_err(format!(
                                "the worker passed its memory ceiling ({} MB) on {method}",
                                rss / 1_000_000
                            ))
                            .with_data(serde_json::json!({ "reason": "memory" })));
                        }
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    kill(state.take().unwrap());
                    return Err(worker_err(format!("the worker crashed on {method}"))
                        .with_data(serde_json::json!({ "reason": "crash" })));
                }
            }
        }
    }
}

impl Drop for ProcessWorkerHost {
    fn drop(&mut self) {
        if let Some(r) = self.state.lock().unwrap().take() {
            kill(r);
        }
    }
}

/// Resident memory of a process, in bytes.
fn resident_bytes(pid: u32) -> Option<u64> {
    let out = Command::new("/bin/ps").args(["-o", "rss=", "-p", &pid.to_string()]).output().ok()?;
    let kb: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(kb * 1024)
}
