//! Port traits. Each port has a real adapter and a test adapter.

use crate::error::Result;
use serde_json::Value;
use std::time::Duration;

/// The system clock, or a fixed one in tests.
pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch, UTC.
    fn now_ms(&self) -> i64;
    /// The local offset from UTC in seconds, at the given instant.
    fn local_offset_s(&self, at_ms: i64) -> i32;
}

/// UUID v7, or a fixed sequence in tests.
pub trait IdGenerator: Send + Sync {
    fn next_id(&self) -> crate::Id;
}

/// Runs parsers in an isolated worker process, speaking JSON-RPC over stdin/stdout.
pub trait WorkerHost: Send + Sync {
    /// Calls a worker method. Times out, restarts the worker after a crash, a hang or the
    /// memory ceiling, and reports a `Worker` error.
    fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value>;
}
