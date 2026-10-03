//! The Librarium worker. Parsers of untrusted or heavy input run here, never in the app.
//!
//! Protocol: one JSON-RPC 2.0 request per line on stdin, one response per line on stdout.
//! Nothing else is ever written to stdout; diagnostics go to stderr.

use librarium_contracts::rpc::{RpcRequest, RpcResponse};
use librarium_contracts::BackendError;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

mod methods;

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
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
        if stdout.write_all(&out).and_then(|_| stdout.flush()).is_err() {
            break;
        }
    }
}

fn dispatch(req: RpcRequest) -> RpcResponse {
    let result: Result<Value, BackendError> = match req.method.as_str() {
        "ping" => Ok(json!({ "worker_version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() })),
        other => methods::call(other, req.params),
    };
    match result {
        Ok(v) => RpcResponse::ok(req.id, v),
        Err(e) => RpcResponse::err(req.id, e),
    }
}
