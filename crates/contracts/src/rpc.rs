//! JSON-RPC 2.0 message shapes, so any transport carries API messages unchanged.

use crate::error::{BackendError, ErrorCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// JSON-RPC 2.0 server-error code used for every `BackendError`; the typed code is in `data`.
pub const BACKEND_ERROR: i32 = -32000;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub params: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RpcErrorObject {
    pub code: i32,
    pub message: String,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<BackendError>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[ts(optional, type = "unknown")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcErrorObject>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[ts(type = "unknown")]
    pub params: Value,
}

impl RpcRequest {
    pub fn new(id: u64, method: impl Into<String>, params: Value) -> Self {
        RpcRequest { jsonrpc: "2.0".into(), id, method: method.into(), params }
    }
}

impl RpcResponse {
    pub fn ok(id: u64, result: Value) -> Self {
        RpcResponse { jsonrpc: "2.0".into(), id, result: Some(result), error: None }
    }
    pub fn err(id: u64, e: BackendError) -> Self {
        let code = match e.code {
            ErrorCode::NotFound if e.data.as_ref().is_some_and(|d| d.get("method").is_some()) => METHOD_NOT_FOUND,
            ErrorCode::InvalidInput if e.data.as_ref().is_some_and(|d| d.get("params").is_some()) => INVALID_PARAMS,
            _ => BACKEND_ERROR,
        };
        RpcResponse {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(RpcErrorObject { code, message: e.message.clone(), data: Some(e) }),
        }
    }
    pub fn into_result(self) -> Result<Value, BackendError> {
        match (self.result, self.error) {
            (_, Some(e)) => Err(e.data.unwrap_or_else(|| BackendError::internal(e.message))),
            (Some(v), None) => Ok(v),
            (None, None) => Ok(Value::Null),
        }
    }
}

impl RpcNotification {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        RpcNotification { jsonrpc: "2.0".into(), method: method.into(), params }
    }
}

/// Anything that answers JSON-RPC requests: implemented by the API, carried by a Transport.
pub trait RpcHandler: Send + Sync {
    fn handle(&self, request: RpcRequest) -> RpcResponse;
}

/// Where notifications go (events, job progress). A Transport provides one.
pub trait NotificationSink: Send + Sync {
    fn notify(&self, n: RpcNotification);
}
