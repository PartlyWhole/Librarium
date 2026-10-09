//! The open library: its folder, its app data, the index, and the one write lock through
//! which every write to the folder goes.
//!
//! A write takes the lock ([`Library::write`]), writes the file, updates the index, and when
//! the lock is released the interface is told which records changed (`records.changed`).

pub mod folders;
pub mod frontmatter;
pub mod record;
pub mod repair;
pub mod scan;
pub mod write;

use crate::error::{Error, Result};
use crate::history::History;
use crate::index::Index;
use crate::jobs::Jobs;
use crate::settings::Drafts;
use crate::types::{StorePhase, StoreStatus};
use crate::util::{now_ms, Id};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

/// Sends an event to the interface: (name, payload).
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// How long the folder must be free of outside changes before repairs run.
pub const QUIET_MS: i64 = 3_000;

pub struct Library {
    pub id: Id,
    pub root: PathBuf,
    /// `<app data>/libraries/<library id>/`
    pub app_dir: PathBuf,
    pub index: Index,
    pub history: History,
    pub drafts: Drafts,
    pub jobs: Jobs,
    /// Duplicate IDs and records waiting for repair, as the last scan found them.
    pub problems: Mutex<repair::Problems>,
    /// Permanent deletions the user is being asked to confirm, by token.
    pub confirmations: Mutex<HashMap<String, crate::archive::Confirmation>>,
    pub emit: Emit,
    lock: Mutex<()>,
    seq: AtomicU64,
    last_outside_ms: AtomicI64,
    last_check_ms: AtomicU64,
    closed: AtomicBool,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

/// Holding the write lock. Records written through it are announced when it is dropped.
pub struct Write<'a> {
    pub lib: &'a Library,
    changed: RefCell<Vec<Id>>,
    _guard: MutexGuard<'a, ()>,
}

impl Write<'_> {
    /// Notes that a record changed; returns the change's number.
    pub fn changed(&self, id: Id) -> u64 {
        let mut c = self.changed.borrow_mut();
        if !c.contains(&id) {
            c.push(id);
        }
        self.lib.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn seq(&self) -> u64 {
        self.lib.seq()
    }
}

impl Drop for Write<'_> {
    fn drop(&mut self) {
        let ids = std::mem::take(&mut *self.changed.borrow_mut());
        if !ids.is_empty() {
            (self.lib.emit)("records.changed", json!({ "ids": ids }));
        }
    }
}

impl Library {
    /// Opens the library at `root` and checks it against the index before returning: outside
    /// changes are found, leftover temp files removed and unfinished operations redone.
    pub fn open(root: &Path, app_data: &Path, emit: Emit) -> Result<Arc<Library>> {
        if !root.is_dir() {
            return Err(Error::not_found(format!("The library folder {} can’t be found.", root.display())));
        }
        let id = scan::library_id(root)?;
        scan::take_lock(root);
        let app_dir = app_data.join("libraries").join(id.to_string());
        std::fs::create_dir_all(app_dir.join("drafts"))?;
        let index = Index::open(&app_dir.join("index.sqlite"))?;
        let lib = Arc::new(Library {
            id,
            root: root.to_path_buf(),
            history: History::new(root, &app_dir),
            drafts: Drafts::new(app_dir.join("drafts")),
            jobs: Jobs::load(app_dir.join("jobs.json")),
            app_dir,
            index,
            problems: Mutex::default(),
            confirmations: Mutex::default(),
            emit,
            lock: Mutex::new(()),
            seq: AtomicU64::new(0),
            last_outside_ms: AtomicI64::new(0),
            last_check_ms: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            watcher: Mutex::new(None),
        });
        {
            let w = lib.write();
            let t = std::time::Instant::now();
            let report = scan::full_scan(&w)?;
            lib.last_check_ms.store(t.elapsed().as_millis() as u64, Ordering::SeqCst);
            if report.changed > 0 {
                lib.note_outside_activity();
            }
            for (path, intent) in write::pending_intents(&lib.app_dir) {
                if let Some(i) = intent {
                    if let Err(e) = record::redo(&w, &i) {
                        log::warn!("dropping an unfinished operation {i:?}: {e}");
                    }
                }
                let _ = std::fs::remove_file(path);
            }
        }
        *lib.watcher.lock().unwrap() = scan::watch(&lib);
        start_ticker(Arc::downgrade(&lib));
        crate::jobs::start(&lib);
        Ok(lib)
    }

    /// Stops watching and background work, waits for a write in progress, and releases the
    /// folder's lock file.
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.watcher.lock().unwrap().take();
        self.jobs.stop();
        let _w = self.lock.lock();
        let _ = std::fs::remove_file(self.root.join(".librarium/lock"));
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Takes the write lock.
    pub fn write(&self) -> Write<'_> {
        let guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        Write { lib: self, changed: RefCell::new(vec![]), _guard: guard }
    }

    /// The number of the last change.
    pub fn seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    pub fn note_outside_activity(&self) {
        self.last_outside_ms.store(now_ms(), Ordering::SeqCst);
    }

    /// No outside changes for a while, and no git operation in progress.
    pub fn quiet(&self) -> bool {
        let git = self.root.join(".git");
        let git_busy = ["index.lock", "MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
            .iter()
            .any(|n| git.join(n).exists());
        now_ms() - self.last_outside_ms.load(Ordering::SeqCst) >= QUIET_MS && !git_busy
    }

    pub fn status(&self) -> StoreStatus {
        let p = self.problems.lock().unwrap();
        StoreStatus {
            phase: StorePhase::Ready,
            records: self.index.count(),
            last_check: Some("full".into()),
            last_check_ms: self.last_check_ms.load(Ordering::SeqCst),
            duplicates: p.duplicate_infos(),
            pending_repairs: p.repairs.len() as u64,
        }
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        self.close();
    }
}

/// Once a second: versions of notes written since their last one, and repairs once the folder
/// is quiet.
fn start_ticker(lib: Weak<Library>) {
    std::thread::Builder::new()
        .name("librarium-ticker".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let Some(lib) = lib.upgrade() else { return };
            if lib.is_closed() {
                return;
            }
            crate::history::tick(&lib);
            if lib.problems.lock().unwrap().has_repairs() && lib.quiet() {
                repair::run_repairs(&lib.write());
            }
        })
        .expect("start the ticker thread");
}
