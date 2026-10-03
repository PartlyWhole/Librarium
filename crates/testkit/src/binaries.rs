//! Builds the real worker binary once per test process, into its own target directory so it
//! never races with the workspace build (feature unification can relink the shared one).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub fn worker_binary() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let target = root.join("target/test-worker");
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = std::process::Command::new(cargo)
            .current_dir(&root)
            .args(["build", "-q", "-p", "librarium-worker", "--target-dir"])
            .arg(&target)
            .status()
            .expect("cargo build the worker");
        assert!(status.success(), "building the worker failed");
        target.join("debug/librarium-worker")
    })
    .clone()
}
