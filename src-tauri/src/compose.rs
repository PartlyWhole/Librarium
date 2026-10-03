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

/// Derived views contributed by features.
pub fn views() -> Vec<(String, Arc<dyn librarium_kernel::views::DerivedView>)> {
    let mut v = vec![];
    librarium_feature_search::contribute_views(&mut v);
    librarium_feature_links::contribute_views(&mut v);
    v
}

/// Job kinds contributed by features.
pub fn job_kinds() -> librarium_kernel::registry::Registry<librarium_kernel::jobs::JobKind> {
    let mut r = librarium_kernel::jobs::registry();
    librarium_feature_links::contribute_jobs(&mut r).expect("links jobs");
    r
}

/// API calls contributed by features.
pub fn methods() -> librarium_kernel::registry::Registry<librarium_kernel::methods::ApiMethod> {
    let mut r = librarium_kernel::methods::registry();
    librarium_feature_notes::contribute_methods(&mut r).expect("notes methods");
    librarium_feature_daily::contribute_methods(&mut r).expect("daily methods");
    librarium_feature_search::contribute_methods(&mut r).expect("search methods");
    librarium_feature_links::contribute_methods(&mut r).expect("links methods");
    librarium_feature_library::contribute_methods(&mut r).expect("library methods");
    librarium_feature_captures::contribute_methods(&mut r).expect("captures methods");
    r
}

/// Only for listing contributions (the architecture report).
struct NoRecognizer;

impl librarium_contracts::ports::TextRecognizer for NoRecognizer {
    fn recognize_image(&self, _p: &Path) -> librarium_contracts::Result<librarium_contracts::ports::Recognized> {
        Err(librarium_contracts::BackendError::internal("no recognizer"))
    }
    fn recognize_pdf_pages(
        &self,
        _p: &Path,
        _pages: &[u32],
    ) -> librarium_contracts::Result<librarium_contracts::ports::Recognized> {
        Err(librarium_contracts::BackendError::internal("no recognizer"))
    }
}

/// Where page saving isn't available (tests and tools without Tauri's WebKit).
pub struct NoPageSaver;

impl librarium_contracts::ports::PageSaver for NoPageSaver {
    fn save(
        &self,
        _url: &str,
        _timeout: std::time::Duration,
    ) -> librarium_contracts::Result<librarium_contracts::ports::SavedPage> {
        Err(librarium_contracts::BackendError::new(
            librarium_contracts::ErrorCode::NotReady,
            "Saving web pages isn’t available here.",
        ))
    }
}

impl App {
    /// Composes the app without page saving (for tests and tools).
    pub fn compose(worker_binary: PathBuf, app_support: PathBuf, logs_dir: PathBuf) -> App {
        Self::compose_with(worker_binary, app_support, logs_dir, Arc::new(NoPageSaver))
    }

    pub fn compose_with(
        worker_binary: PathBuf,
        app_support: PathBuf,
        logs_dir: PathBuf,
        page_saver: Arc<dyn librarium_contracts::ports::PageSaver>,
    ) -> App {
        let mut methods = methods();
        librarium_feature_library::contribute_page_methods(&mut methods).expect("page saving");
        let worker: Arc<dyn WorkerHost> = Arc::new(ProcessWorkerHost::new(worker_binary, WORKER_MEMORY_CEILING));
        let recognizer: Arc<dyn librarium_contracts::ports::TextRecognizer> =
            Arc::new(librarium_recognizer_vision::VisionRecognizer::new(worker.clone()));
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
            logs_dir,
            desktop: Arc::new(librarium_system::MacDesktop),
            open_options: OpenOptions::default(),
            methods,
            views: Arc::new(views),
            job_kinds: Arc::new(move || {
                let mut r = job_kinds();
                librarium_feature_library::contribute_jobs(&mut r, recognizer.clone()).expect("library jobs");
                librarium_feature_library::contribute_page_jobs(&mut r, page_saver.clone()).expect("page saving");
                r
            }),
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
        (librarium_contracts::slots::API_METHODS.to_string(), methods().contributors()),
        (
            librarium_contracts::slots::DERIVED_VIEWS.to_string(),
            views().into_iter().map(|(by, v)| (v.spec().name, by)).collect(),
        ),
        (librarium_contracts::slots::JOB_KINDS.to_string(), {
            let mut r = job_kinds();
            librarium_feature_library::contribute_jobs(&mut r, Arc::new(NoRecognizer)).expect("library jobs");
            librarium_feature_library::contribute_page_jobs(&mut r, Arc::new(NoPageSaver)).expect("page jobs");
            librarium_kernel::hosts::kernel_job_kinds(&mut r);
            r.contributors()
        }),
    ]
}
