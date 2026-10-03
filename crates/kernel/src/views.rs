//! The derived-view host. Each derived view (search, references…) has its own index file,
//! stamped with its schema version, and is disposable: a missing or mismatched file is
//! rebuilt from the store, alone, into a new file that replaces the old one when done.
//!
//! The host applies numbered changes in order on its own thread, and at startup checks every
//! view against the files (a per-view `_seen` table of record hashes), so changes made while
//! the app was closed — or before the host started — are applied too. Views never write to the
//! store.

use crate::store::{Entry, Store};
use librarium_contracts::events::{Change, ChangeOp};
use librarium_contracts::ports::{Cell, IndexEngine, OpenState, TableSpec, ViewIndex, ViewSpec};
use librarium_contracts::{BackendError, Id, Result};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// A record as a view sees it: its table entry and its text.
pub struct ViewRecord<'a> {
    pub entry: &'a Entry,
    /// For Markdown, the body; for other kinds, their text source's text (stored files only:
    /// recognition is never re-run to build a view).
    pub text: &'a str,
}

/// A derived view, contributed through the `kernel.derived-views` slot.
pub trait DerivedView: Send + Sync {
    fn spec(&self) -> ViewSpec;
    /// Indexes one record (replacing what was there for it).
    fn apply(&self, idx: &mut dyn ViewIndex, rec: &ViewRecord) -> Result<()>;
    fn remove(&self, idx: &mut dyn ViewIndex, id: Id) -> Result<()>;
}

const SEEN: &str = "_seen";

fn with_seen(mut spec: ViewSpec) -> ViewSpec {
    spec.tables.push(TableSpec { name: SEEN.into(), columns: vec!["id".into(), "hash".into()], indexed: vec![] });
    spec
}

struct Slot {
    view: Arc<dyn DerivedView>,
    spec: ViewSpec,
    idx: Mutex<Box<dyn ViewIndex>>,
}

struct Inner {
    store: Arc<Store>,
    engine: Arc<dyn IndexEngine>,
    slots: Vec<Slot>,
    queue: Mutex<VecDeque<Change>>,
    cv: Condvar,
    applied: AtomicU64,
    applied_cv: (Mutex<()>, Condvar),
    ready: AtomicBool,
    stop: AtomicBool,
    on_indexed: Box<dyn Fn(u64) + Send + Sync>,
    progress: Mutex<Option<(usize, usize)>>,
}

#[derive(Clone)]
pub struct ViewHost {
    inner: Arc<Inner>,
}

impl ViewHost {
    /// Opens every view and starts the host's thread, which first brings each view up to date
    /// with the store (a full rebuild for a missing or mismatched file).
    pub fn start(
        store: Arc<Store>,
        engine: Arc<dyn IndexEngine>,
        views: Vec<Arc<dyn DerivedView>>,
        on_indexed: Box<dyn Fn(u64) + Send + Sync>,
    ) -> Result<ViewHost> {
        let mut slots = vec![];
        let mut empty = vec![];
        for v in views {
            let spec = with_seen(v.spec());
            let (idx, state) = engine.open(&spec)?;
            empty.push(state == OpenState::Empty);
            slots.push(Slot { view: v, spec, idx: Mutex::new(idx) });
        }
        let inner = Arc::new(Inner {
            store: store.clone(),
            engine,
            slots,
            queue: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            applied: AtomicU64::new(0),
            applied_cv: (Mutex::new(()), Condvar::new()),
            ready: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            on_indexed,
            progress: Mutex::new(None),
        });
        // Subscribe before catching up, so nothing falls between the two.
        let weak = Arc::downgrade(&inner);
        store.changes.subscribe(Arc::new(move |c: &Change| {
            if let Some(i) = weak.upgrade() {
                i.queue.lock().unwrap().push_back(c.clone());
                i.cv.notify_one();
            }
        }));
        let i2 = inner.clone();
        std::thread::Builder::new()
            .name("librarium-views".into())
            .spawn(move || {
                i2.store.wait_ready();
                for (n, e) in empty.iter().enumerate() {
                    let r = if *e { i2.rebuild(n) } else { i2.catch_up(n) };
                    if let Err(err) = r {
                        eprintln!("librarium: view {} could not be brought up to date: {err}", i2.slots[n].spec.name);
                    }
                }
                i2.ready.store(true, Ordering::SeqCst);
                i2.mark_applied(i2.store.changes.last_seq());
                i2.run();
            })
            .map_err(|e| BackendError::internal(e.to_string()))?;
        Ok(ViewHost { inner })
    }

    /// Runs a read against a view's index.
    pub fn query<R>(&self, view: &str, f: impl FnOnce(&dyn ViewIndex) -> Result<R>) -> Result<R> {
        let slot = self
            .inner
            .slots
            .iter()
            .find(|s| s.spec.name == view)
            .ok_or_else(|| BackendError::not_found(format!("no view {view}")))?;
        let idx = slot.idx.lock().unwrap();
        f(&**idx)
    }

    /// True once every view has caught up with the store at startup.
    pub fn is_ready(&self) -> bool {
        self.inner.ready.load(Ordering::SeqCst)
    }

    /// (done, total) while a rebuild runs.
    pub fn progress(&self) -> Option<(usize, usize)> {
        *self.inner.progress.lock().unwrap()
    }

    /// The highest change sequence number every view has applied.
    pub fn applied(&self) -> u64 {
        self.inner.applied.load(Ordering::SeqCst)
    }

    /// Waits until every view has applied changes up to `seq` (a window that made a change
    /// waits for it, so it always shows its own edits).
    pub fn wait_applied(&self, seq: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut g = self.inner.applied_cv.0.lock().unwrap();
        while self.applied() < seq || !self.is_ready() {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            g = self.inner.applied_cv.1.wait_timeout(g, deadline - now).unwrap().0;
        }
        true
    }

    /// Rebuilds every view from the store (the visible "Rebuild index" command).
    pub fn rebuild_all(&self, progress: &dyn Fn(usize, usize)) -> Result<()> {
        for n in 0..self.inner.slots.len() {
            self.inner.rebuild_with(n, progress)?;
        }
        Ok(())
    }

    pub fn view_names(&self) -> Vec<String> {
        self.inner.slots.iter().map(|s| s.spec.name.clone()).collect()
    }

    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        self.inner.cv.notify_all();
    }
}

impl Inner {
    fn mark_applied(&self, seq: u64) {
        if seq > self.applied.load(Ordering::SeqCst) {
            self.applied.store(seq, Ordering::SeqCst);
        }
        let _g = self.applied_cv.0.lock().unwrap();
        self.applied_cv.1.notify_all();
        (self.on_indexed)(self.applied.load(Ordering::SeqCst));
    }

    fn run(&self) {
        loop {
            let batch: Vec<Change> = {
                let mut q = self.queue.lock().unwrap();
                while q.is_empty() && !self.stop.load(Ordering::SeqCst) {
                    q = self.cv.wait_timeout(q, Duration::from_millis(500)).unwrap().0;
                }
                if self.stop.load(Ordering::SeqCst) {
                    return;
                }
                q.drain(..).collect()
            };
            let last = batch.iter().map(|c| c.seq).max().unwrap_or(0);
            // Later changes to the same record supersede earlier ones in a batch.
            let mut latest: HashMap<Id, &Change> = HashMap::new();
            for c in &batch {
                latest.insert(c.id, c);
            }
            for n in 0..self.slots.len() {
                let mut idx = self.slots[n].idx.lock().unwrap();
                let _ = idx.begin();
                for c in latest.values() {
                    let r = if c.op == ChangeOp::Removed {
                        self.remove_one(n, &mut **idx, c.id)
                    } else {
                        self.apply_id(n, &mut **idx, c.id)
                    };
                    if let Err(e) = r {
                        eprintln!("librarium: view {} could not apply {}: {e}", self.slots[n].spec.name, c.id);
                    }
                }
                let _ = idx.commit();
            }
            self.mark_applied(last);
        }
    }

    fn text_of(&self, e: &Entry) -> String {
        self.store.record_text(e).unwrap_or_default()
    }

    fn apply_entry(&self, n: usize, idx: &mut dyn ViewIndex, e: &Entry) -> Result<()> {
        let text = self.text_of(e);
        self.slots[n].view.apply(idx, &ViewRecord { entry: e, text: &text })?;
        idx.put(SEEN, vec![e.id.to_string().into(), e.hash.clone().into()])
    }

    fn apply_id(&self, n: usize, idx: &mut dyn ViewIndex, id: Id) -> Result<()> {
        match self.store.get(id) {
            Some(e) => self.apply_entry(n, idx, &e),
            None => self.remove_one(n, idx, id),
        }
    }

    fn remove_one(&self, n: usize, idx: &mut dyn ViewIndex, id: Id) -> Result<()> {
        self.slots[n].view.remove(idx, id)?;
        idx.delete(SEEN, &id.to_string())
    }

    /// Applies what changed since the view last saw each record.
    fn catch_up(&self, n: usize) -> Result<()> {
        let mut idx = self.slots[n].idx.lock().unwrap();
        let seen: HashMap<String, String> = idx
            .all(SEEN)?
            .into_iter()
            .filter_map(|r| Some((r.first()?.text()?.to_string(), r.get(1)?.text()?.to_string())))
            .collect();
        let entries = self.store.list(None);
        idx.begin()?;
        for e in &entries {
            if seen.get(&e.id.to_string()) != Some(&e.hash) {
                self.apply_entry(n, &mut **idx, e)?;
            }
        }
        let live: std::collections::HashSet<String> = entries.iter().map(|e| e.id.to_string()).collect();
        for id in seen.keys().filter(|k| !live.contains(*k)) {
            if let Ok(id) = id.parse() {
                self.remove_one(n, &mut **idx, id)?;
            }
        }
        idx.commit()
    }

    fn rebuild(&self, n: usize) -> Result<()> {
        self.rebuild_with(n, &|_, _| {})
    }

    /// Rebuilds one view into a new file, which replaces the old one when done.
    fn rebuild_with(&self, n: usize, progress: &dyn Fn(usize, usize)) -> Result<()> {
        let mut fresh = self.engine.rebuild(&self.slots[n].spec)?;
        let entries = self.store.list(None);
        let total = entries.len();
        fresh.begin()?;
        for (i, e) in entries.iter().enumerate() {
            self.apply_entry(n, &mut *fresh, e)?;
            if i % 500 == 0 {
                *self.progress.lock().unwrap() = Some((i, total));
                progress(i, total);
                fresh.commit()?;
                fresh.begin()?;
            }
        }
        fresh.commit()?;
        let done = fresh.finish_rebuild()?;
        *self.slots[n].idx.lock().unwrap() = done;
        *self.progress.lock().unwrap() = None;
        progress(total, total);
        // Changes applied to the old file meanwhile are caught up by their hashes.
        self.catch_up(n)
    }
}

/// Text of a record, used by views (and its passage offsets).
pub fn cell_text(c: &Cell) -> &str {
    c.text().unwrap_or("")
}
