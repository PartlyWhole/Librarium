//! Composition: names the adapters and features and wires them together.

use librarium_api::{Api, Deps, Handler};
use librarium_changes_fsevents::FsEvents;
use librarium_contracts::ports::{ChangeSource, IndexEngine, WorkerHost};
use librarium_fs_macos::MacFs;
use librarium_index_sqlite::SqliteIndex;
use librarium_kernel::kinds::Kinds;
use librarium_kernel::library::OpenOptions;
use librarium_system::{SystemClock, UuidV7};
use librarium_transport_tauri::TauriTransport;
use librarium_versions_none::NoVersions;
use librarium_worker_process::ProcessWorkerHost;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The worker's resident-memory ceiling (BRIEF §4.5).
pub const WORKER_MEMORY_CEILING: u64 = 2 * 1024 * 1024 * 1024;

/// The one value Tauri manages.
pub struct App {
    pub api: Arc<Api>,
    pub transport: Arc<TauriTransport>,
}

/// Record kinds, from each feature's contribution, in a fixed order.
pub fn kinds() -> Kinds {
    let mut k = Kinds::new();
    librarium_feature_notes::contribute_kinds(&mut k).expect("notes kinds");
    librarium_feature_daily::contribute_kinds(&mut k).expect("daily kinds");
    librarium_feature_captures::contribute_kinds(&mut k).expect("captures kinds");
    librarium_feature_library::contribute_kinds(&mut k).expect("library kinds");
    k
}

impl App {
    pub fn compose(worker_binary: PathBuf, app_support: PathBuf) -> App {
        let worker: Arc<dyn WorkerHost> = Arc::new(ProcessWorkerHost::new(worker_binary, WORKER_MEMORY_CEILING));
        let api = Arc::new(Api::new(Deps {
            worker,
            fs: Arc::new(MacFs),
            clock: Arc::new(SystemClock),
            ids: Arc::new(UuidV7),
            versions: Arc::new(NoVersions),
            index: Arc::new(|p: &Path| Arc::new(SqliteIndex::new(p)) as Arc<dyn IndexEngine>),
            changes: Arc::new(|| Arc::new(FsEvents::default()) as Arc<dyn ChangeSource>),
            kinds: Arc::new(kinds),
            app_support,
            open_options: OpenOptions::default(),
        }));
        let transport = Arc::new(TauriTransport::new(Arc::new(Handler(api.clone()))));
        api.set_sink(transport.clone());
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
    let k = kinds();
    vec![
        (k.kinds.slot().to_string(), k.kinds.contributors()),
        (k.slug_fields.slot().to_string(), k.slug_fields.contributors()),
    ]
}
