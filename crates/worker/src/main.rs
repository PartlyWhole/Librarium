//! The Librarium worker. Parsers of untrusted or heavy input run here, never in the app.
//!
//! Protocol: one JSON-RPC 2.0 request per line on stdin, one response per line on stdout.
//! Parsers sometimes print; so the worker keeps a private copy of stdout for replies and points
//! file descriptor 1 at stderr. A parser that panics answers with an error.

use librarium_contracts::rpc::{RpcRequest, RpcResponse};
use librarium_contracts::BackendError;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufRead, Write};
use std::os::fd::FromRawFd;

mod epub;
mod methods;
mod pdf;
mod vision;

fn main() {
    // SAFETY: duplicating and redirecting our own standard descriptors at startup.
    let mut replies = unsafe {
        let fd = libc::dup(1);
        assert!(fd >= 0, "dup stdout");
        libc::dup2(2, 1);
        File::from_raw_fd(fd)
    };
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(req) => dispatch(req),
            Err(e) => RpcResponse::err(0, BackendError::invalid(format!("bad request: {e}"))),
        };
        let mut out = serde_json::to_vec(&response).expect("serialize response");
        out.push(b'\n');
        if replies.write_all(&out).and_then(|_| replies.flush()).is_err() {
            break;
        }
    }
}

fn dispatch(req: RpcRequest) -> RpcResponse {
    let id = req.id;
    let result: Result<Value, BackendError> = match req.method.as_str() {
        "ping" => Ok(json!({ "worker_version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() })),
        // Test hooks run outside catch_unwind: they crash and hang on purpose.
        m if m.starts_with("test.") => methods::call(m, req.params),
        m => {
            let m = m.to_string();
            match std::panic::catch_unwind(move || methods::call(&m, req.params)) {
                Ok(r) => r,
                Err(p) => {
                    let msg = p
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_default();
                    Err(BackendError::new(librarium_contracts::ErrorCode::Worker, format!("the parser failed: {msg}"))
                        .with_data(json!({ "reason": "parser" })))
                }
            }
        }
    };
    match result {
        Ok(v) => RpcResponse::ok(id, v),
        Err(e) => RpcResponse::err(id, e),
    }
}
