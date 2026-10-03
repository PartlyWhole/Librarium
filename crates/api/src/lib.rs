//! The application API: plain Rust, typed methods, one typed error, no transport types.
//!
//! Tests drive [`Api`] directly. A Transport carries it as JSON-RPC through [`RpcHandler`].

use librarium_contracts::api::{methods, AppInfo, WorkerPong};
use librarium_contracts::ports::WorkerHost;
use librarium_contracts::rpc::{RpcHandler, RpcRequest, RpcResponse};
use librarium_contracts::{BackendError, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Built-in API calls, in a fixed order.
pub const METHODS: &[&str] = &[methods::APP_INFO, methods::WORKER_PING];

pub struct Deps {
    pub worker: Arc<dyn WorkerHost>,
}

pub struct Api {
    deps: Deps,
}

impl Api {
    pub fn new(deps: Deps) -> Self {
        Api { deps }
    }

    pub fn app_info(&self) -> AppInfo {
        AppInfo {
            name: "Librarium".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            api_methods: self.method_names(),
        }
    }

    pub fn worker_ping(&self) -> Result<WorkerPong> {
        let t = Instant::now();
        let v = self.deps.worker.call("ping", json!({}), Duration::from_secs(30))?;
        Ok(WorkerPong {
            worker_version: v["worker_version"].as_str().unwrap_or_default().to_string(),
            pid: v["pid"].as_u64().unwrap_or_default() as u32,
            round_trip_us: t.elapsed().as_micros() as u64,
        })
    }

    pub fn method_names(&self) -> Vec<String> {
        METHODS.iter().map(|s| s.to_string()).collect()
    }

    /// Calls a method by name with JSON params: what a Transport does.
    pub fn call(&self, method: &str, _params: Value) -> Result<Value> {
        match method {
            methods::APP_INFO => to_json(self.app_info()),
            methods::WORKER_PING => to_json(self.worker_ping()?),
            _ => Err(BackendError::not_found(format!("no API call {method}")).with_data(json!({ "method": method }))),
        }
    }
}

#[allow(dead_code)]
fn params<T: DeserializeOwned>(v: Value) -> Result<T> {
    serde_json::from_value(v)
        .map_err(|e| BackendError::invalid(format!("bad params: {e}")).with_data(json!({ "params": e.to_string() })))
}

fn to_json<T: Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| BackendError::internal(e.to_string()))
}

impl RpcHandler for Api {
    fn handle(&self, request: RpcRequest) -> RpcResponse {
        match self.call(&request.method, request.params) {
            Ok(v) => RpcResponse::ok(request.id, v),
            Err(e) => RpcResponse::err(request.id, e),
        }
    }
}
