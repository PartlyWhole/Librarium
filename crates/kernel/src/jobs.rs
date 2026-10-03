//! The job host: long work in the background, reporting progress (§4.1, §6).
//!
//! - Jobs persist in `jobs.sqlite` (operational state). Resumable kinds resume after a
//!   restart, with a brief note ("Resumed 3 saves").
//! - Each job has an idempotency key; asking again while it's queued or running returns it.
//!   Payloads hold IDs, not content; a job checks for existing output before its final write.
//! - A worker failure (crash, hang, memory ceiling) retries the job once; then it is reported.
//! - Job kinds are contributed through the `kernel.job-kinds` slot, optionally with a trigger
//!   that turns a change into a job.

use crate::library::Library;
use crate::registry::Registry;
use crate::store::Store;
use crate::views::ViewHost;
use librarium_contracts::api::{JobInfo, JobState, JobsList};
use librarium_contracts::events::Change;
use librarium_contracts::ports::{Cell, IndexEngine, TableSpec, ViewIndex, ViewSpec, WorkerHost};
use librarium_contracts::{slots, BackendError, ErrorCode, Id, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub struct JobCtx<'a> {
    pub library: &'a Arc<Library>,
    pub views: &'a ViewHost,
    pub worker: &'a dyn WorkerHost,
    pub job: &'a JobInfo,
    progress: &'a dyn Fn(Option<f32>, Option<&str>),
    cancelled: &'a AtomicBool,
}

impl JobCtx<'_> {
    pub fn progress(&self, fraction: Option<f32>, message: Option<&str>) {
        (self.progress)(fraction, message)
    }
    /// Long jobs check this and stop early.
    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    /// The flag set when the user cancels this job (for waits that check it as they go).
    pub fn cancel_flag(&self) -> &AtomicBool {
        self.cancelled
    }
    pub fn check_cancelled(&self) -> Result<()> {
        if self.cancelled() {
            Err(BackendError::new(ErrorCode::Cancelled, "cancelled"))
        } else {
            Ok(())
        }
    }
}

pub type JobFn = Arc<dyn Fn(&JobCtx, &Value) -> Result<()> + Send + Sync>;
/// Turns a change into a job request: (key, payload).
pub type TriggerFn = Arc<dyn Fn(&Change, &Store) -> Option<(String, Value)> + Send + Sync>;

#[derive(Clone)]
pub struct JobKind {
    pub kind: String,
    /// Shown to the user, e.g. "Saving a page".
    pub title: String,
    /// Plural noun for the resume note, e.g. "saves".
    pub noun: String,
    /// Resumes after a restart (page saves, text recognition).
    pub resumable: bool,
    /// At most one of this kind runs at a time (it waits on a shared resource, such as the one
    /// window pages are saved in), so the other runners stay free for other work.
    pub one_at_a_time: bool,
    pub run: JobFn,
    pub trigger: Option<TriggerFn>,
}

pub fn registry() -> Registry<JobKind> {
    Registry::new(slots::JOB_KINDS)
}

pub fn jobs_view() -> ViewSpec {
    ViewSpec {
        name: "jobs".into(),
        schema_version: 1,
        tables: vec![TableSpec {
            name: "jobs".into(),
            columns: vec!["id".into(), "kind".into(), "key".into(), "state".into(), "json".into()],
            indexed: vec!["key".into()],
        }],
        text: false,
    }
}

struct Inner {
    library: Arc<Library>,
    views: ViewHost,
    worker: Arc<dyn WorkerHost>,
    kinds: Registry<JobKind>,
    table: Mutex<Box<dyn ViewIndex>>,
    jobs: Mutex<HashMap<Id, JobInfo>>,
    cancel: Mutex<HashMap<Id, Arc<AtomicBool>>>,
    cv: Condvar,
    wake: Mutex<()>,
    stop: AtomicBool,
    notify: Box<dyn Fn(&JobInfo) + Send + Sync>,
    resumed: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct JobHost {
    inner: Arc<Inner>,
}

const KEEP_DONE: usize = 30;

impl JobHost {
    pub fn start(
        library: Arc<Library>,
        views: ViewHost,
        worker: Arc<dyn WorkerHost>,
        kinds: Registry<JobKind>,
        engine: Arc<dyn IndexEngine>,
        runners: usize,
        notify: Box<dyn Fn(&JobInfo) + Send + Sync>,
    ) -> Result<JobHost> {
        let (table, _) = engine.open(&jobs_view())?;
        let mut jobs = HashMap::new();
        for row in table.all("jobs")? {
            if let Some(j) = row.get(4).and_then(Cell::text).and_then(|t| serde_json::from_str::<JobInfo>(t).ok()) {
                jobs.insert(j.id, j);
            }
        }
        let inner = Arc::new(Inner {
            library: library.clone(),
            views,
            worker,
            kinds,
            table: Mutex::new(table),
            jobs: Mutex::new(jobs),
            cancel: Mutex::new(HashMap::new()),
            cv: Condvar::new(),
            wake: Mutex::new(()),
            stop: AtomicBool::new(false),
            notify,
            resumed: Mutex::new(None),
        });
        inner.resume();
        let weak = Arc::downgrade(&inner);
        library.store.changes.subscribe(Arc::new(move |c: &Change| {
            if let Some(i) = weak.upgrade() {
                let reqs: Vec<(String, String, Value)> = i
                    .kinds
                    .iter()
                    .filter_map(|e| {
                        e.value.trigger.as_ref().and_then(|t| t(c, &i.library.store)).map(|(k, p)| (e.id.clone(), k, p))
                    })
                    .collect();
                for (kind, key, payload) in reqs {
                    let _ = i.enqueue(&kind, &key, payload);
                }
            }
        }));
        for n in 0..runners.max(1) {
            let i = inner.clone();
            std::thread::Builder::new()
                .name(format!("librarium-jobs-{n}"))
                .spawn(move || i.runner())
                .map_err(|e| BackendError::internal(e.to_string()))?;
        }
        Ok(JobHost { inner })
    }

    /// Queues a job, or returns the queued or running one with the same kind and key.
    pub fn enqueue(&self, kind: &str, key: &str, payload: Value) -> Result<JobInfo> {
        self.inner.enqueue(kind, key, payload)
    }

    pub fn get(&self, id: Id) -> Option<JobInfo> {
        self.inner.jobs.lock().unwrap().get(&id).cloned()
    }

    pub fn list(&self) -> JobsList {
        let jobs = self.inner.jobs.lock().unwrap();
        let mut all: Vec<JobInfo> = jobs.values().cloned().collect();
        all.sort_by_key(|j| std::cmp::Reverse(j.updated_ms));
        JobsList {
            running: all.iter().filter(|j| matches!(j.state, JobState::Running | JobState::Queued)).cloned().collect(),
            failed: all.iter().filter(|j| j.state == JobState::Failed).cloned().collect(),
            recent: all
                .iter()
                .filter(|j| matches!(j.state, JobState::Done | JobState::Cancelled))
                .take(10)
                .cloned()
                .collect(),
            resumed: self.inner.resumed.lock().unwrap().clone(),
        }
    }

    pub fn retry(&self, id: Id) -> Result<JobInfo> {
        self.inner
            .update(id, |j| {
                if j.state == JobState::Failed || j.state == JobState::Cancelled {
                    j.state = JobState::Queued;
                    j.attempts = 0;
                    j.error = None;
                }
            })
            .inspect(|_| self.inner.cv.notify_all())
    }

    pub fn cancel(&self, id: Id) -> Result<JobInfo> {
        if let Some(flag) = self.inner.cancel.lock().unwrap().get(&id) {
            flag.store(true, Ordering::SeqCst);
        }
        self.inner.update(id, |j| {
            if j.state == JobState::Queued {
                j.state = JobState::Cancelled;
            }
        })
    }

    pub fn dismiss(&self, id: Id) -> Result<()> {
        let j = self.get(id).ok_or_else(|| BackendError::not_found("no such job"))?;
        if matches!(j.state, JobState::Running | JobState::Queued) {
            return Err(BackendError::invalid("a running job can be cancelled, not dismissed"));
        }
        self.inner.jobs.lock().unwrap().remove(&id);
        self.inner.table.lock().unwrap().delete("jobs", &id.to_string())
    }

    /// Waits until a job finishes (for tests and synchronous callers).
    pub fn wait(&self, id: Id, timeout: Duration) -> Option<JobInfo> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let j = self.get(id)?;
            if matches!(j.state, JobState::Done | JobState::Failed | JobState::Cancelled) {
                return Some(j);
            }
            if std::time::Instant::now() >= deadline {
                return Some(j);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn kinds(&self) -> Vec<(String, String)> {
        self.inner.kinds.contributors()
    }

    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        for f in self.inner.cancel.lock().unwrap().values() {
            f.store(true, Ordering::SeqCst);
        }
        self.inner.cv.notify_all();
    }
}

impl Inner {
    fn now(&self) -> i64 {
        self.library.store.clock.now_ms()
    }

    fn persist(&self, j: &JobInfo) {
        let row = vec![
            j.id.to_string().into(),
            j.kind.clone().into(),
            j.key.clone().into(),
            format!("{:?}", j.state).into(),
            serde_json::to_string(j).unwrap().into(),
        ];
        let _ = self.table.lock().unwrap().put("jobs", row);
    }

    fn update(&self, id: Id, f: impl FnOnce(&mut JobInfo)) -> Result<JobInfo> {
        let j = {
            let mut jobs = self.jobs.lock().unwrap();
            let j = jobs.get_mut(&id).ok_or_else(|| BackendError::not_found("no such job"))?;
            f(j);
            j.updated_ms = self.now();
            j.clone()
        };
        self.persist(&j);
        (self.notify)(&j);
        Ok(j)
    }

    fn resume(&self) {
        let mut counts: HashMap<String, usize> = HashMap::new();
        let ids: Vec<Id> = self
            .jobs
            .lock()
            .unwrap()
            .values()
            .filter(|j| matches!(j.state, JobState::Queued | JobState::Running))
            .map(|j| j.id)
            .collect();
        for id in ids {
            let kind = self.jobs.lock().unwrap()[&id].kind.clone();
            match self.kinds.get(&kind) {
                Some(k) if k.resumable => {
                    *counts.entry(k.noun.clone()).or_default() += 1;
                    let _ = self.update(id, |j| j.state = JobState::Queued);
                }
                _ => {
                    // Not worth resuming (e.g. an index rebuild that will rerun anyway).
                    let _ = self.update(id, |j| j.state = JobState::Cancelled);
                }
            }
        }
        if !counts.is_empty() {
            let mut parts: Vec<String> = counts.into_iter().map(|(noun, n)| format!("{n} {noun}")).collect();
            parts.sort();
            *self.resumed.lock().unwrap() = Some(format!("Resumed {}", parts.join(" and ")));
        }
        // Keep the list short.
        let mut done: Vec<JobInfo> = self
            .jobs
            .lock()
            .unwrap()
            .values()
            .filter(|j| matches!(j.state, JobState::Done | JobState::Cancelled))
            .cloned()
            .collect();
        done.sort_by_key(|j| std::cmp::Reverse(j.updated_ms));
        for j in done.into_iter().skip(KEEP_DONE) {
            self.jobs.lock().unwrap().remove(&j.id);
            let _ = self.table.lock().unwrap().delete("jobs", &j.id.to_string());
        }
    }

    fn enqueue(&self, kind: &str, key: &str, payload: Value) -> Result<JobInfo> {
        let k = self.kinds.get(kind).ok_or_else(|| BackendError::invalid(format!("no job kind {kind}")))?;
        let j = {
            let mut jobs = self.jobs.lock().unwrap();
            if let Some(existing) = jobs
                .values()
                .find(|j| j.kind == kind && j.key == key && matches!(j.state, JobState::Queued | JobState::Running))
            {
                return Ok(existing.clone());
            }
            let now = self.now();
            let j = JobInfo {
                id: self.library.store.ids.next_id(),
                kind: kind.into(),
                key: key.into(),
                state: JobState::Queued,
                title: k.title.clone(),
                attempts: 0,
                error: None,
                progress: None,
                message: None,
                payload,
                created_ms: now,
                updated_ms: now,
            };
            jobs.insert(j.id, j.clone());
            j
        };
        self.persist(&j);
        (self.notify)(&j);
        self.cv.notify_all();
        Ok(j)
    }

    fn next(&self) -> Option<JobInfo> {
        let mut jobs = self.jobs.lock().unwrap();
        let busy: std::collections::HashSet<String> = jobs
            .values()
            .filter(|j| j.state == JobState::Running && self.kinds.get(&j.kind).is_some_and(|k| k.one_at_a_time))
            .map(|j| j.kind.clone())
            .collect();
        let mut queued: Vec<&mut JobInfo> =
            jobs.values_mut().filter(|j| j.state == JobState::Queued && !busy.contains(&j.kind)).collect();
        // Oldest first; jobs made in the same millisecond keep the order of their IDs.
        queued.sort_by_key(|j| (j.created_ms, j.id));
        let j = queued.into_iter().next()?;
        j.state = JobState::Running;
        j.attempts += 1;
        j.updated_ms = self.library.store.clock.now_ms();
        Some(j.clone())
    }

    fn runner(self: Arc<Self>) {
        loop {
            if self.stop.load(Ordering::SeqCst) {
                return;
            }
            let Some(job) = self.next() else {
                let g = self.wake.lock().unwrap();
                let _ = self.cv.wait_timeout(g, Duration::from_millis(500)).unwrap();
                continue;
            };
            self.persist(&job);
            (self.notify)(&job);
            let flag = Arc::new(AtomicBool::new(false));
            self.cancel.lock().unwrap().insert(job.id, flag.clone());
            let kind = self.kinds.get(&job.kind).cloned();
            let me = self.clone();
            let id = job.id;
            let progress = move |p: Option<f32>, m: Option<&str>| {
                let _ = me.update(id, |j| {
                    j.progress = p;
                    j.message = m.map(str::to_string);
                });
            };
            let result = match &kind {
                None => Err(BackendError::internal(format!("no job kind {}", job.kind))),
                Some(k) => {
                    let ctx = JobCtx {
                        library: &self.library,
                        views: &self.views,
                        worker: &*self.worker,
                        job: &job,
                        progress: &progress,
                        cancelled: &flag,
                    };
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (k.run)(&ctx, &job.payload)))
                        .unwrap_or_else(|_| Err(BackendError::internal("the job panicked")))
                }
            };
            self.cancel.lock().unwrap().remove(&job.id);
            let _ = self.update(job.id, |j| match &result {
                Ok(()) => {
                    j.state = JobState::Done;
                    j.progress = Some(1.0);
                    j.error = None;
                }
                Err(e) if e.code == ErrorCode::Cancelled || flag.load(Ordering::SeqCst) => {
                    j.state = JobState::Cancelled
                }
                // A worker failure is retried once, then reported.
                Err(e) if e.code == ErrorCode::Worker && j.attempts < 2 => {
                    j.state = JobState::Queued;
                    j.error = Some(e.message.clone());
                }
                Err(e) => {
                    j.state = JobState::Failed;
                    j.error = Some(e.message.clone());
                }
            });
            self.cv.notify_all();
        }
    }
}
