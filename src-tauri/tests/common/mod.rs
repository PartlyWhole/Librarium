//! Helpers for the tests: throwaway folders and an app without a window.

#![allow(dead_code)]

use librarium::app::App;
use librarium::commands::dispatch;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// A new empty folder under the system's temp folder.
pub fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!("librarium-test-{}-{n}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// An app whose data lives in `app_data`, sending events nowhere.
pub fn app(app_data: &Path) -> App {
    App::new(app_data.to_path_buf(), app_data.join("logs"), Arc::new(|_: &str, _: Value| {}))
}

/// An app with the library at `root` open.
pub fn open(root: &Path, app_data: &Path) -> App {
    let a = app(app_data);
    call(&a, "folder.open", serde_json::json!({ "path": root }));
    a
}

pub fn call(app: &App, method: &str, params: Value) -> Value {
    dispatch(app, method, params).unwrap_or_else(|e| panic!("{method}: {e}"))
}

/// Copies a folder tree.
pub fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (a, b) = (e.path(), to.join(e.file_name()));
        if a.is_dir() {
            copy_dir(&a, &b);
        } else {
            std::fs::copy(&a, &b).unwrap();
        }
    }
}

/// Every file under a folder (outside `.librarium`), with its bytes, by relative path.
pub fn files(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().to_string();
            if rel.starts_with(".librarium") {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push((rel, std::fs::read(&p).unwrap()));
            }
        }
    }
    out.sort();
    out
}
