//! Worker methods beyond `ping`. Each parser registers here.

use librarium_contracts::BackendError;
use serde_json::{json, Value};

fn path(params: &Value) -> Result<std::path::PathBuf, BackendError> {
    params["path"].as_str().map(std::path::PathBuf::from).ok_or_else(|| BackendError::invalid("path is required"))
}

pub fn call(method: &str, params: Value) -> Result<Value, BackendError> {
    match method {
        "pdf.text" => crate::pdf::text(&path(&params)?),
        "epub.parse" => crate::epub::parse(&path(&params)?),
        "image.info" => {
            let p = path(&params)?;
            let size =
                imagesize::size(&p).map_err(|e| BackendError::invalid(format!("not an image we can read: {e}")))?;
            Ok(json!({ "width": size.width, "height": size.height }))
        }
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
        "test.grow" => {
            // Holds memory until killed (for the memory ceiling).
            let mb = params["mb"].as_u64().unwrap_or(100) as usize;
            let mut v: Vec<Vec<u8>> = vec![];
            for _ in 0..mb {
                v.push(vec![1u8; 1 << 20]);
            }
            loop {
                std::thread::sleep(std::time::Duration::from_millis(100));
                std::hint::black_box(&v);
            }
        }
        _ => Err(BackendError::not_found(format!("no worker method {method}")).with_data(json!({ "method": method }))),
    }
}
