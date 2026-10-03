//! The derived-view host and the job host of an open library, started together.

use crate::jobs::{JobHost, JobKind};
use crate::library::{IndexFactory, Library};
use crate::registry::Registry;
use crate::views::{DerivedView, ViewHost};
use librarium_contracts::api::JobInfo;
use librarium_contracts::ports::WorkerHost;
use librarium_contracts::Result;
use serde_json::Value;
use std::sync::Arc;

pub struct Hosts {
    pub views: ViewHost,
    pub jobs: JobHost,
}

pub struct HostEvents {
    pub indexed: Box<dyn Fn(u64) + Send + Sync>,
    pub job: Box<dyn Fn(&JobInfo) + Send + Sync>,
}

/// The kernel's own job kinds: rebuilding the index.
pub fn kernel_job_kinds(r: &mut Registry<JobKind>) {
    let _ = r.add(
        "kernel",
        "index.rebuild",
        JobKind {
            kind: "index.rebuild".into(),
            title: "Rebuilding the index".into(),
            noun: "index rebuilds".into(),
            resumable: false,
            one_at_a_time: false,
            run: Arc::new(|ctx, _p: &Value| {
                ctx.views.rebuild_all(&|done, total| {
                    ctx.progress(
                        Some(if total == 0 { 1.0 } else { done as f32 / total as f32 }),
                        Some(&format!("{done} of {total}")),
                    )
                })
            }),
            trigger: None,
        },
    );
}

impl Hosts {
    pub fn start(
        library: Arc<Library>,
        index: &IndexFactory,
        worker: Arc<dyn WorkerHost>,
        views: Vec<Arc<dyn DerivedView>>,
        mut jobs: Registry<JobKind>,
        events: HostEvents,
    ) -> Result<Hosts> {
        kernel_job_kinds(&mut jobs);
        let engine = index(&library.app_dir.join("index"));
        let views = ViewHost::start(library.store.clone(), engine, views, events.indexed)?;
        let jobs_engine = index(&library.app_dir);
        let jobs = JobHost::start(library, views.clone(), worker, jobs, jobs_engine, 2, events.job)?;
        Ok(Hosts { views, jobs })
    }

    pub fn stop(&self) {
        self.jobs.stop();
        self.views.stop();
    }
}
