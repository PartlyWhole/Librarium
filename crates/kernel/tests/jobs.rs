//! The job host on the fakes: retries after worker failures, idempotency, resuming.
mod common;

use common::*;
use librarium_contracts::api::JobState;
use librarium_kernel::hosts::{HostEvents, Hosts};
use librarium_kernel::jobs::{registry, JobKind};
use librarium_kernel::library::Library;
use librarium_testkit::memindex::MemIndex;
use librarium_testkit::worker::{FakeWorkerHost, Fault};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn hosts(lib: Arc<Library>, worker: Arc<FakeWorkerHost>, index: MemIndex, runs: Arc<AtomicUsize>) -> Hosts {
    let mut r = registry();
    let r2 = runs.clone();
    r.add(
        "test",
        "test.parse",
        JobKind {
            kind: "test.parse".into(),
            title: "Parsing".into(),
            noun: "parses".into(),
            resumable: true,
            one_at_a_time: false,
            run: Arc::new(move |ctx, p: &Value| {
                r2.fetch_add(1, Ordering::SeqCst);
                ctx.worker.call("ping", p.clone(), Duration::from_secs(1))?;
                Ok(())
            }),
            trigger: None,
        },
    )
    .unwrap();
    Hosts::start(
        lib,
        &(Arc::new(move |_p: &Path| Arc::new(index.clone()) as Arc<dyn librarium_contracts::ports::IndexEngine>)
            as librarium_kernel::library::IndexFactory),
        worker,
        vec![],
        r,
        HostEvents { indexed: Box::new(|_| {}), job: Box::new(|_| {}) },
    )
    .unwrap()
}

#[test]
fn a_worker_failure_is_retried_once_then_reported() {
    let h = H::new();
    let lib = Arc::new(h.open());
    let worker = Arc::new(FakeWorkerHost::new());
    let runs = Arc::new(AtomicUsize::new(0));
    let hs = hosts(lib, worker.clone(), MemIndex::new(), runs.clone());

    worker.script(&[Fault::Crash]);
    let j = hs.jobs.enqueue("test.parse", "a", json!({})).unwrap();
    let j = hs.jobs.wait(j.id, Duration::from_secs(5)).unwrap();
    assert_eq!(j.state, JobState::Done, "retried once after a crash: {j:?}");
    assert_eq!(j.attempts, 2);

    worker.script(&[Fault::Hang, Fault::Crash]);
    let j = hs.jobs.enqueue("test.parse", "b", json!({})).unwrap();
    let j = hs.jobs.wait(j.id, Duration::from_secs(5)).unwrap();
    assert_eq!(j.state, JobState::Failed, "{j:?}");
    assert!(j.error.unwrap().contains("crashed"));
    assert_eq!(hs.jobs.list().failed.len(), 1);

    // Retry from the Jobs view.
    let j = hs.jobs.retry(j.id).unwrap();
    assert_eq!(hs.jobs.wait(j.id, Duration::from_secs(5)).unwrap().state, JobState::Done);
    hs.stop();
}

#[test]
fn one_key_is_one_job() {
    let h = H::new();
    let lib = Arc::new(h.open());
    let worker = Arc::new(FakeWorkerHost::new().with("ping", |_| {
        std::thread::sleep(Duration::from_millis(200));
        Ok(json!({}))
    }));
    let runs = Arc::new(AtomicUsize::new(0));
    let hs = hosts(lib, worker, MemIndex::new(), runs.clone());
    let a = hs.jobs.enqueue("test.parse", "same", json!({})).unwrap();
    let b = hs.jobs.enqueue("test.parse", "same", json!({})).unwrap();
    assert_eq!(a.id, b.id);
    hs.jobs.wait(a.id, Duration::from_secs(5));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    hs.stop();
}

#[test]
fn unfinished_jobs_resume_after_a_restart() {
    let h = H::new();
    let index = MemIndex::new();
    let runs = Arc::new(AtomicUsize::new(0));
    {
        let lib = Arc::new(h.open());
        // A worker that never answers keeps the jobs queued or running.
        let stuck = Arc::new(FakeWorkerHost::new().with("ping", |_| {
            std::thread::sleep(Duration::from_secs(3600));
            Ok(json!({}))
        }));
        let hs = hosts(lib.clone(), stuck, index.clone(), runs.clone());
        for k in ["1", "2", "3"] {
            hs.jobs.enqueue("test.parse", k, json!({})).unwrap();
        }
        std::thread::sleep(Duration::from_millis(100));
        hs.stop();
        lib.close();
    }
    let lib = Arc::new(h.open());
    let hs = hosts(lib, Arc::new(FakeWorkerHost::new()), index, runs);
    assert_eq!(hs.jobs.list().resumed.as_deref(), Some("Resumed 3 parses"));
    std::thread::sleep(Duration::from_millis(300));
    let l = hs.jobs.list();
    assert!(l.running.is_empty() && l.failed.is_empty(), "{l:?}");
    hs.stop();
}

#[test]
fn a_one_at_a_time_kind_leaves_the_other_runner_free() {
    let h = H::new();
    let lib = Arc::new(h.open());
    let release = Arc::new(std::sync::Mutex::new(false));
    let mut r = registry();
    let rel = release.clone();
    r.add(
        "test",
        "test.slow",
        JobKind {
            kind: "test.slow".into(),
            title: "Slow".into(),
            noun: "slow jobs".into(),
            resumable: false,
            one_at_a_time: true,
            run: Arc::new(move |_ctx, _p: &Value| {
                while !*rel.lock().unwrap() {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(())
            }),
            trigger: None,
        },
    )
    .unwrap();
    r.add(
        "test",
        "test.quick",
        JobKind {
            kind: "test.quick".into(),
            title: "Quick".into(),
            noun: "quick jobs".into(),
            resumable: false,
            one_at_a_time: false,
            run: Arc::new(|_ctx, _p: &Value| Ok(())),
            trigger: None,
        },
    )
    .unwrap();
    let index = MemIndex::new();
    let hs = Hosts::start(
        lib,
        &(Arc::new(move |_p: &Path| Arc::new(index.clone()) as Arc<dyn librarium_contracts::ports::IndexEngine>)
            as librarium_kernel::library::IndexFactory),
        Arc::new(FakeWorkerHost::new()),
        vec![],
        r,
        HostEvents { indexed: Box::new(|_| {}), job: Box::new(|_| {}) },
    )
    .unwrap();
    // Two slow jobs first: only one may run, so the second runner takes the quick job.
    let s1 = hs.jobs.enqueue("test.slow", "1", json!({})).unwrap();
    let s2 = hs.jobs.enqueue("test.slow", "2", json!({})).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let q = hs.jobs.enqueue("test.quick", "q", json!({})).unwrap();
    assert_eq!(hs.jobs.wait(q.id, Duration::from_secs(2)).unwrap().state, JobState::Done, "the quick job didn't wait");
    assert_eq!(hs.jobs.get(s2.id).unwrap().state, JobState::Queued, "the second slow job waits its turn");
    *release.lock().unwrap() = true;
    for s in [s1, s2] {
        assert_eq!(hs.jobs.wait(s.id, Duration::from_secs(5)).unwrap().state, JobState::Done);
    }
}
