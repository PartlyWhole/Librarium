//! The one typed error. It crosses the API as `BackendError {code, message, data}`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// No record, file or method with that identity.
    NotFound,
    /// The file changed since the version the caller was based on.
    Conflict,
    /// The caller sent something malformed.
    InvalidInput,
    /// The record is read-only (newer kind-version, unparsable frontmatter).
    ReadOnly,
    /// The operation must wait (e.g. for the startup check).
    NotReady,
    /// A file-system or device error.
    Io,
    /// The worker failed, crashed or timed out.
    Worker,
    /// The operation was cancelled.
    Cancelled,
    /// A bug.
    Internal,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct BackendError {
    pub code: ErrorCode,
    pub message: String,
    #[ts(type = "unknown")]
    pub data: Option<serde_json::Value>,
}

pub type Result<T, E = BackendError> = std::result::Result<T, E>;

impl BackendError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        BackendError { code, message: message.into(), data: None }
    }
    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, m)
    }
    pub fn conflict(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, m)
    }
    pub fn invalid(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, m)
    }
    pub fn internal(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, m)
    }
    pub fn io(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, m)
    }
}

impl From<std::io::Error> for BackendError {
    fn from(e: std::io::Error) -> Self {
        BackendError::io(e.to_string())
    }
}
