//! Composition: names the adapters and features and wires them together.

use librarium_api::{Api, Deps};
use librarium_contracts::ports::WorkerHost;
use librarium_contracts::slots;
use librarium_kernel::registry::Registry;
use librarium_transport_tauri::TauriTransport;
use librarium_worker_process::ProcessWorkerHost;
use std::path::PathBuf;
use std::sync::Arc;

/// The worker's resident-memory ceiling (BRIEF §4.5).
pub const WORKER_MEMORY_CEILING: u64 = 2 * 1024 * 1024 * 1024;

/// The one value Tauri manages.
pub struct App {
    pub api: Arc<Api>,
    pub transport: TauriTransport,
}

impl App {
    pub fn compose(worker_binary: PathBuf) -> App {
        let worker: Arc<dyn WorkerHost> = Arc::new(ProcessWorkerHost::new(worker_binary, WORKER_MEMORY_CEILING));
        let api = Arc::new(Api::new(Deps { worker }));
        let transport = TauriTransport::new(api.clone());
        App { api, transport }
    }
}

/// The worker binary sits next to the app's executable (dev: target/debug; bundle: Contents/MacOS).
pub fn worker_binary() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    Ok(exe.with_file_name("librarium-worker"))
}

/// Backend slot contributions, for the architecture report: (slot, [(id, contributor)]).
pub fn slot_contributors() -> Vec<(String, Vec<(String, String)>)> {
    let kinds: Registry<()> = Registry::new(slots::RECORD_KINDS);
    vec![(kinds.slot().to_string(), kinds.contributors())]
}
