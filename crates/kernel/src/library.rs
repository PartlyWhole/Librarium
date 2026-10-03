//! Opening a library: its ID, lock and app-data folders, the records table, the change source,
//! and the startup check (replay, or a full check), all before the first user action.

use crate::check::CheckReport;
use crate::kinds::Kinds;
use crate::store::{records_view, Durability, Ports, Store, Tx, TMP_MARK};
use crate::writer::{Lane, Writer};
use librarium_contracts::ports::{
    ChangeBatch, ChangeSource, Clock, FileSystem, IdGenerator, IndexEngine, OpenState, ReplayState, StartOutcome,
    VersionStore,
};
use librarium_contracts::{BackendError, ErrorCode, Id, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub type IndexFactory = Arc<dyn Fn(&Path) -> Arc<dyn IndexEngine> + Send + Sync>;

pub struct LibraryPorts {
    pub fs: Arc<dyn FileSystem>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdGenerator>,
    pub versions: Arc<dyn VersionStore>,
    /// Makes the index engine for a library's index folder.
    pub index: IndexFactory,
    pub changes: Arc<dyn ChangeSource>,
}

#[derive(Debug, Clone)]
pub struct OpenOptions {
    /// How often the idle writer runs maintenance.
    pub tick: Duration,
    /// How long to wait for a replay to finish before falling back to a full check.
    pub replay_wait: Duration,
    /// A full check runs this often, as a safety net.
    pub full_check_every_ms: i64,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions {
            tick: Duration::from_secs(1),
            replay_wait: Duration::from_secs(10),
            full_check_every_ms: 30 * 60 * 1000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LibraryJson {
    id: Id,
    created: String,
}

#[derive(Debug, Clone)]
pub struct StartupReport {
    /// "replay" or "full".
    pub mode: &'static str,
    /// Why a full check ran.
    pub reason: Option<String>,
    pub check: CheckReport,
    pub intents_redone: usize,
    pub elapsed: Duration,
}

#[derive(Default)]
struct Pending {
    q: Mutex<PendingQ>,
    history_done: Mutex<bool>,
    cv: Condvar,
}

#[derive(Default)]
struct PendingQ {
    paths: BTreeSet<PathBuf>,
    rescan: bool,
    state: Option<ReplayState>,
}

pub struct Library {
    pub id: Id,
    pub root: PathBuf,
    pub app_dir: PathBuf,
    pub store: Arc<Store>,
    pub writer: Writer,
    pub startup: StartupReport,
    pub drafts: crate::drafts::Drafts,
    source: Arc<dyn ChangeSource>,
    closed: AtomicBool,
}

fn missing(root: &Path) -> BackendError {
    BackendError::new(ErrorCode::NotFound, format!("The library folder {} can't be found.", root.display()))
        .with_data(serde_json::json!({ "library_missing": root.display().to_string() }))
}

fn io(e: std::io::Error, what: &str) -> BackendError {
    BackendError::io(format!("{what}: {e}"))
}

/// Reads or creates `.librarium/library.json`, returning the library's ID.
pub fn library_id(fs: &dyn FileSystem, ids: &dyn IdGenerator, clock: &dyn Clock, root: &Path) -> Result<Id> {
    let meta = root.join(".librarium");
    let p = meta.join("library.json");
    if let Ok(b) = fs.read(&p) {
        if let Ok(j) = serde_json::from_slice::<LibraryJson>(&b) {
            return Ok(j.id);
        }
    }
    fs.create_dir_all(&meta).map_err(|e| io(e, "creating .librarium"))?;
    let j = LibraryJson { id: ids.next_id(), created: crate::time::iso_utc(clock.now_ms()) };
    let mut bytes = serde_json::to_vec_pretty(&j).unwrap();
    bytes.push(b'\n');
    write_new_durably(fs, &p, &bytes)?;
    let gi = meta.join(".gitignore");
    if fs.stat(&gi).ok().flatten().is_none() {
        write_new_durably(fs, &gi, b"lock\n")?;
    }
    Ok(j.id)
}

fn write_new_durably(fs: &dyn FileSystem, p: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = p.with_file_name(format!(".{}{TMP_MARK}0", p.file_name().unwrap().to_string_lossy()));
    let _ = fs.remove_file(&tmp);
    fs.write_new(&tmp, bytes).map_err(|e| io(e, "writing"))?;
    fs.flush_file(&tmp, librarium_contracts::ports::Flush::Full).map_err(|e| io(e, "flushing"))?;
    fs.rename(&tmp, p).map_err(|e| io(e, "renaming"))?;
    fs.flush_dir(p.parent().unwrap(), librarium_contracts::ports::Flush::Full).map_err(|e| io(e, "flushing"))
}

impl Library {
    /// Opens the library at `root`, keeping its derived data and operational state under
    /// `app_support/libraries/<library-id>/`.
    pub fn open(
        root: &Path,
        app_support: &Path,
        ports: LibraryPorts,
        kinds: Kinds,
        opts: OpenOptions,
    ) -> Result<Library> {
        let fs = ports.fs.clone();
        match fs.stat(root) {
            Ok(Some(m)) if m.is_dir => {}
            _ => return Err(missing(root)),
        }
        let id = library_id(&*fs, &*ports.ids, &*ports.clock, root)?;
        let lock = root.join(".librarium/lock");
        // A lock left behind means the app did not close cleanly: the change history and the
        // index may both lag the folder, so the startup check is a full one.
        let unclean = fs.stat(&lock).ok().flatten().is_some();
        let _ = fs.remove_file(&lock);
        let _ = fs.write_new(&lock, format!("{}\n", std::process::id()).as_bytes());
        let _ = fs.flush_file(&lock, librarium_contracts::ports::Flush::Full);
        let _ = fs.flush_dir(&root.join(".librarium"), librarium_contracts::ports::Flush::Full);

        let app_dir = app_support.join("libraries").join(id.to_string());
        for d in ["index", "intents", "drafts", "staging"] {
            fs.create_dir_all(&app_dir.join(d)).map_err(|e| io(e, "creating app data"))?;
        }
        let engine = (ports.index)(&app_dir.join("index"));
        let (table, table_state) = engine.open(&records_view())?;
        let store = Arc::new(Store::new(
            root.to_path_buf(),
            app_dir.clone(),
            Ports {
                fs: fs.clone(),
                clock: ports.clock.clone(),
                ids: ports.ids.clone(),
                versions: ports.versions.clone(),
            },
            Arc::new(kinds),
            table,
        )?);
        if table_state == OpenState::Ready {
            store.load_side_lists();
        }

        let pending = Arc::new(Pending::default());
        let last_full = Arc::new(AtomicI64::new(ports.clock.now_ms()));
        let changes_json = app_dir.join("changes.json");

        // Maintenance on the idle writer: repairs when quiet, and the timed full check.
        let tick = {
            let last_full = last_full.clone();
            let every = opts.full_check_every_ms;
            let changes_json = changes_json.clone();
            let source = ports.changes.clone();
            Box::new(move |tx: &Tx| {
                let s = tx.store;
                if !s.is_ready() {
                    return;
                }
                if !s.pending_repairs().is_empty() && s.quiet() {
                    for r in tx.run_repairs() {
                        if let Err(e) = r {
                            log_warn(&format!("repair failed: {e}"));
                        }
                    }
                }
                let now = s.clock.now_ms();
                if now - last_full.load(Ordering::SeqCst) >= every {
                    last_full.store(now, Ordering::SeqCst);
                    if tx.full_check().is_ok() {
                        if let Ok(st) = source.current(&s.root) {
                            let _ = save_state(s, &changes_json, &st);
                        }
                    }
                }
            })
        };
        let writer = Writer::start(store.clone(), opts.tick, Some(tick));

        let since = if table_state == OpenState::Ready {
            fs.read(&changes_json).ok().and_then(|b| serde_json::from_slice::<ReplayState>(&b).ok())
        } else {
            None
        };
        let had_index = table_state == OpenState::Ready;

        // The change source's sink: collect, then let the writer check.
        let sink = {
            let pending = pending.clone();
            let writer = writer.clone();
            let store = store.clone();
            let changes_json = changes_json.clone();
            Box::new(move |b: ChangeBatch| {
                let meta_dir = store.root.join(".librarium");
                let interesting: Vec<PathBuf> = b
                    .paths
                    .into_iter()
                    .filter(|p| !p.starts_with(&meta_dir) && !p.to_string_lossy().contains(TMP_MARK))
                    .collect();
                {
                    let mut q = pending.q.lock().unwrap();

                    q.paths.extend(interesting);
                    q.rescan |= b.rescan;
                    q.state = Some(b.state);
                }
                if b.history_done {
                    *pending.history_done.lock().unwrap() = true;
                    pending.cv.notify_all();
                }
                if store.is_ready() {
                    let pending = pending.clone();
                    let changes_json = changes_json.clone();
                    writer.submit(Lane::Background, move |tx: &Tx| process_pending(tx, &pending, &changes_json));
                }
            })
        };
        let outcome = ports.changes.start(root, since.clone(), sink)?;

        // The startup check runs first, ahead of any user action.
        let startup = {
            let pending = pending.clone();
            let changes_json = changes_json.clone();
            let source = ports.changes.clone();
            let wait = opts.replay_wait;
            writer.run(Lane::Interactive, move |tx: &Tx| -> Result<StartupReport> {
                let t0 = Instant::now();
                let s = tx.store;
                let mut reason = match (&outcome, had_index) {
                    (_, false) => Some("no index yet".to_string()),
                    _ if unclean => Some("the app did not close cleanly".to_string()),
                    (StartOutcome::Unavailable(r), _) => Some(r.clone()),
                    (StartOutcome::Replaying, _) => None,
                };
                let mut check = None;
                let mut state = None;
                if reason.is_none() {
                    let deadline = Instant::now() + wait;
                    let mut done = pending.history_done.lock().unwrap();
                    while !*done && Instant::now() < deadline {
                        done = pending.cv.wait_timeout(done, deadline - Instant::now()).unwrap().0;
                    }
                    let finished = *done;
                    drop(done);
                    let (paths, rescan, st) = {
                        let mut q = pending.q.lock().unwrap();
                        (std::mem::take(&mut q.paths), std::mem::take(&mut q.rescan), q.state.clone())
                    };
                    if !finished {
                        reason = Some("the replay did not finish in time".into());
                    } else if rescan {
                        reason = Some("events were dropped or merged".into());
                    } else {
                        check = Some(tx.check_paths(&paths.into_iter().collect::<Vec<_>>())?);
                        state = st.or(since);
                    }
                }
                let mode = if check.is_some() { "replay" } else { "full" };
                let check = match check {
                    Some(c) => c,
                    None => {
                        pending.q.lock().unwrap().paths.clear();
                        let c = tx.full_check()?;
                        state = source.current(&s.root).ok();
                        c
                    }
                };
                // Unfinished intents are redone.
                let mut redone = 0;
                for (p, intent) in s.pending_intents() {
                    if let Some(i) = intent {
                        match tx.apply(&i) {
                            Ok(_) => redone += 1,
                            Err(e) => log_warn(&format!("dropping intent {i:?}: {e}")),
                        }
                    }
                    s.clear_intent(&p);
                }
                if let Some(st) = &state {
                    save_state(s, &changes_json, st)?;
                }
                let elapsed = t0.elapsed();
                s.set_ready(mode, elapsed.as_millis() as u64);
                Ok(StartupReport { mode, reason, check, intents_redone: redone, elapsed })
            })?
        };

        Ok(Library {
            id,
            root: root.to_path_buf(),
            app_dir: app_dir.clone(),
            store,
            writer,
            startup,
            drafts: crate::drafts::Drafts::new(fs.clone(), app_dir.join("drafts")),
            source: ports.changes,
            closed: AtomicBool::new(false),
        })
    }

    /// Stops watching, finishes queued writes, releases the lock.
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.source.stop();
        self.writer.stop();
        let _ = self.store.fs.remove_file(&self.root.join(".librarium/lock"));
    }

    /// Runs a closure on the writer and waits.
    pub fn write<R: Send + 'static>(&self, lane: Lane, f: impl FnOnce(&Tx) -> R + Send + 'static) -> R {
        self.writer.run(lane, f)
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        self.close();
    }
}

fn process_pending(tx: &Tx, pending: &Pending, changes_json: &Path) {
    // Paths and the state they lead up to are taken together, so the saved state never runs
    // ahead of what was checked.
    let (paths, rescan, state) = {
        let mut q = pending.q.lock().unwrap();
        (std::mem::take(&mut q.paths), std::mem::take(&mut q.rescan), q.state.clone())
    };
    if paths.is_empty() && !rescan {
        return;
    }
    let r = if rescan { tx.full_check() } else { tx.check_paths(&paths.into_iter().collect::<Vec<_>>()) };
    match r {
        Ok(report) => {
            // Only real outside changes restart the quiet clock (our own writes come back as
            // events too, and are recognised by their hash).
            if report.changed() > 0 || !report.duplicates.is_empty() || report.unidentified > 0 {
                tx.store.note_outside_activity();
            }
            if let Some(st) = state {
                let _ = save_state(tx.store, changes_json, &st);
            }
        }
        Err(e) => log_warn(&format!("check failed: {e}")),
    }
}

fn save_state(s: &Store, p: &Path, st: &ReplayState) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(st).unwrap();
    s.safe_write(p, &bytes, false, Durability::Batch).map_err(|e| io(e, "saving changes.json"))
}

fn log_warn(m: &str) {
    eprintln!("librarium: {m}");
}
