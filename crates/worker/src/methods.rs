//! Worker methods beyond `ping`. Each parser registers here.

use librarium_contracts::BackendError;
use serde_json::{json, Value};

pub fn call(method: &str, params: Value) -> Result<Value, BackendError> {
    match method {
        // Test hooks for the worker host: crash, hang and grow on request.
        "test.crash" => std::process::abort(),
        "test.hang" => loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        },
        "test.echo" => Ok(json!({ "echo": params })),
        "test.sleep" => {
            std::thread::sleep(std::time::Duration::from_millis(params["ms"].as_u64().unwrap_or(1000)));
            Ok(json!({ "pid": std::process::id() }))
        }
        _ => Err(BackendError::not_found(format!("no worker method {method}")).with_data(json!({ "method": method }))),
    }
}
