//! Background jobs: one thread, a queue kept in `jobs.json` in the library's app data so it
//! survives a restart. A failed job is retried once, then reported. Two requests with the same
//! kind and key while one is waiting are one job.

use crate::error::{Code, Context, Error, Result};
use crate::store::{scan, write::write_json, Library};
use crate::types::{JobInfo, JobState, JobsList};
use crate::util::{new_id, now_ms, Id};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Finished jobs kept for the "Recent" list.
const KEEP_DONE: usize = 30;

/// What a kind of job is, and how it runs.
struct Kind {
    title: &'static str,
    /// For the note after a restart: "Resumed 3 saves".
    noun: &'static str,
    /// Worth resuming after a restart (an interrupted index rebuild just runs again).
    resumable: bool,
    run: fn(&Library, &Value, &JobCtx) -> Result<()>,
}

/// Every kind of job.
fn kind(name: &str) -> Option<Kind> {
    Some(match name {
        "links.repair" => Kind {
            title: "Refreshing link labels",
            noun: "link refreshes",
            resumable: false,
            run: crate::links::repair,
        },
        "index.rebuild" => {
            Kind { title: "Rebuilding the index", noun: "index rebuilds", resumable: false, run: rebuild_index }
        }
        _ => return None,
    })
}

/// Rebuilds the index from the library folder; the files are only read.
fn rebuild_index(lib: &Library, _: &Value, job: &JobCtx) -> Result<()> {
    job.progress(None, Some("Reading every file"));
    let w = lib.write();
    lib.index.clear()?;
    scan::full_scan(&w)?;
    Ok(())
}

/// What a running job sees.
pub struct JobCtx<'a> {
    lib: &'a Library,
    id: Id,
    cancelled: &'a AtomicBool,
}

impl JobCtx<'_> {
    pub fn progress(&self, fraction: Option<f32>, message: Option<&str>) {
        self.lib.jobs.update(self.lib, self.id, |j| {
            j.progress = fraction;
            j.message = message.map(String::from);
        });
    }

    pub fn check_cancelled(&self) -> Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(Error::new(Code::Cancelled, "Cancelled."))
        } else {
            Ok(())
        }
    }
}

pub struct Jobs {
    path: PathBuf,
    jobs: Mutex<Vec<JobInfo>>,
    wake: Condvar,
    running: Mutex<Option<(Id, Arc<AtomicBool>)>>,
    stop: AtomicBool,
    resumed: Option<String>,
}

impl Jobs {
    /// Loads the queue: resumable jobs that were waiting or running go back in the queue, the
    /// others are cancelled.
    pub fn load(path: PathBuf) -> Jobs {
        let mut jobs: Vec<JobInfo> =
            std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut counts: HashMap<&'static str, usize> = HashMap::new();
        for j in jobs.iter_mut().filter(|j| matches!(j.state, JobState::Queued | JobState::Running)) {
            match kind(&j.kind) {
                Some(k) if k.resumable => {
                    *counts.entry(k.noun).or_default() += 1;
                    j.state = JobState::Queued;
                }
                _ => j.state = JobState::Cancelled,
            }
        }
        let mut parts: Vec<String> = counts.into_iter().map(|(noun, n)| format!("{n} {noun}")).collect();
        parts.sort();
        let resumed = (!parts.is_empty()).then(|| format!("Resumed {}", parts.join(" and ")));
        Jobs {
            path,
            jobs: Mutex::new(jobs),
            wake: Condvar::new(),
            running: Mutex::new(None),
            stop: AtomicBool::new(false),
            resumed,
        }
    }

    fn save(&self, jobs: &mut Vec<JobInfo>) {
        // Only the most recent finished jobs are kept.
        let mut done: Vec<(i64, Id)> = jobs
            .iter()
            .filter(|j| matches!(j.state, JobState::Done | JobState::Cancelled))
            .map(|j| (j.updated_ms, j.id))
            .collect();
        if done.len() > KEEP_DONE {
            done.sort_by_key(|d| std::cmp::Reverse(d.0));
            let old: Vec<Id> = done[KEEP_DONE..].iter().map(|d| d.1).collect();
            jobs.retain(|j| !old.contains(&j.id));
        }
        if let Err(e) =
            write_json(&self.path, &serde_json::to_value(&*jobs).unwrap_or_default(), true).ctx("saving jobs")
        {
            log::warn!("{e}");
        }
    }

    fn update(&self, lib: &Library, id: Id, f: impl FnOnce(&mut JobInfo)) -> Option<JobInfo> {
        let mut jobs = self.jobs.lock().unwrap();
        let j = jobs.iter_mut().find(|j| j.id == id)?;
        f(j);
        j.updated_ms = now_ms();
        let j = j.clone();
        self.save(&mut jobs);
        drop(jobs);
        (lib.emit)("jobs.changed", serde_json::to_value(&j).unwrap_or_default());
        Some(j)
    }

    /// Queues a job, or returns the waiting one with the same kind and key.
    pub fn enqueue(&self, lib: &Library, kind_name: &str, key: &str, payload: Value) -> Option<JobInfo> {
        let k = kind(kind_name)?;
        let mut jobs = self.jobs.lock().unwrap();
        if let Some(j) = jobs.iter().find(|j| j.kind == kind_name && j.key == key && j.state == JobState::Queued) {
            return Some(j.clone());
        }
        let now = now_ms();
        let j = JobInfo {
            id: new_id(),
            kind: kind_name.into(),
            key: key.into(),
            state: JobState::Queued,
            title: k.title.into(),
            attempts: 0,
            error: None,
            progress: None,
            message: None,
            payload,
            created_ms: now,
            updated_ms: now,
        };
        jobs.push(j.clone());
        self.save(&mut jobs);
        drop(jobs);
        self.wake.notify_all();
        (lib.emit)("jobs.changed", serde_json::to_value(&j).unwrap_or_default());
        Some(j)
    }

    pub fn list(&self) -> JobsList {
        let mut all = self.jobs.lock().unwrap().clone();
        all.sort_by_key(|j| std::cmp::Reverse(j.updated_ms));
        let of = |states: &[JobState]| all.iter().filter(|j| states.contains(&j.state)).cloned().collect::<Vec<_>>();
        JobsList {
            running: of(&[JobState::Running, JobState::Queued]),
            failed: of(&[JobState::Failed]),
            recent: of(&[JobState::Done, JobState::Cancelled]).into_iter().take(KEEP_DONE).collect(),
            resumed: self.resumed.clone(),
        }
    }

    pub fn retry(&self, lib: &Library, id: Id) -> Result<JobInfo> {
        let j = self.update(lib, id, |j| {
            if matches!(j.state, JobState::Failed | JobState::Cancelled) {
                j.state = JobState::Queued;
                j.attempts = 0;
                j.error = None;
            }
        });
        self.wake.notify_all();
        j.ok_or_else(|| Error::not_found("That job can’t be found."))
    }

    /// Cancels a waiting job, or asks a running one to stop.
    pub fn cancel(&self, lib: &Library, id: Id) -> Result<JobInfo> {
        if let Some((running, flag)) = &*self.running.lock().unwrap() {
            if *running == id {
                flag.store(true, Ordering::SeqCst);
            }
        }
        self.update(lib, id, |j| {
            if j.state == JobState::Queued {
                j.state = JobState::Cancelled;
            }
        })
        .ok_or_else(|| Error::not_found("That job can’t be found."))
    }

    pub fn dismiss(&self, id: Id) -> Result<()> {
        let mut jobs = self.jobs.lock().unwrap();
        let j = jobs.iter().find(|j| j.id == id).ok_or_else(|| Error::not_found("That job can’t be found."))?;
        if matches!(j.state, JobState::Running | JobState::Queued) {
            return Err(Error::invalid("A job that hasn’t finished can be cancelled, not dismissed."));
        }
        jobs.retain(|j| j.id != id);
        self.save(&mut jobs);
        Ok(())
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some((_, flag)) = &*self.running.lock().unwrap() {
            flag.store(true, Ordering::SeqCst);
        }
        self.wake.notify_all();
    }

    /// Takes the oldest waiting job and marks it running.
    fn next(&self) -> Option<JobInfo> {
        let mut jobs = self.jobs.lock().unwrap();
        let j = jobs.iter_mut().filter(|j| j.state == JobState::Queued).min_by_key(|j| (j.created_ms, j.id))?;
        j.state = JobState::Running;
        j.attempts += 1;
        j.updated_ms = now_ms();
        let j = j.clone();
        self.save(&mut jobs);
        Some(j)
    }
}

/// Starts the job thread of an open library.
pub fn start(lib: &Arc<Library>) {
    let weak = Arc::downgrade(lib);
    std::thread::Builder::new()
        .name("librarium-jobs".into())
        .spawn(move || loop {
            let Some(lib) = weak.upgrade() else { return };
            let jobs = &lib.jobs;
            if jobs.stop.load(Ordering::SeqCst) {
                return;
            }
            let Some(job) = jobs.next() else {
                let g = jobs.jobs.lock().unwrap();
                drop(jobs.wake.wait_timeout(g, Duration::from_millis(500)).unwrap());
                continue;
            };
            (lib.emit)("jobs.changed", serde_json::to_value(&job).unwrap_or_default());
            run_one(&lib, job);
        })
        .expect("start the job thread");
}

/// Runs a job, wrapped so a panic fails the job and not the app.
fn run_one(lib: &Library, job: JobInfo) {
    let flag = Arc::new(AtomicBool::new(false));
    *lib.jobs.running.lock().unwrap() = Some((job.id, flag.clone()));
    let ctx = JobCtx { lib, id: job.id, cancelled: &flag };
    let result = match kind(&job.kind) {
        Some(k) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (k.run)(lib, &job.payload, &ctx)))
            .unwrap_or_else(|_| Err(Error::io("The job stopped unexpectedly."))),
        None => Err(Error::invalid(format!("There is no job “{}”.", job.kind))),
    };
    *lib.jobs.running.lock().unwrap() = None;
    if let Err(e) = &result {
        log::warn!("job {} ({}) failed: {e}", job.kind, job.id);
    }
    lib.jobs.update(lib, job.id, |j| match result {
        Ok(()) => {
            j.state = JobState::Done;
            j.progress = Some(1.0);
            j.error = None;
        }
        Err(e) if e.code == Code::Cancelled || flag.load(Ordering::SeqCst) => j.state = JobState::Cancelled,
        // Retried once, then reported.
        Err(e) if j.attempts < 2 => {
            j.state = JobState::Queued;
            j.error = Some(e.message);
        }
        Err(e) => {
            j.state = JobState::Failed;
            j.error = Some(e.message);
        }
    });
}
