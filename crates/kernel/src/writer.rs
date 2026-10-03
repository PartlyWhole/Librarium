//! The writer: one thread, two lanes. The interactive lane (editor saves, user actions) always
//! goes before the background lane (repairs, imports, checks). Background work runs in batches
//! that flush each file and end with one `F_FULLFSYNC`; their results are delivered only after
//! it.
//!
//! The writer never waits on anything that waits on it: a job may not submit to the writer and
//! wait (that panics in debug builds).

use crate::store::{Durability, Store, Tx};
use std::cell::Cell;
use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Interactive,
    Background,
}

type Deliver = Box<dyn FnOnce() + Send>;
type Job = Box<dyn FnOnce(&Tx) -> Deliver + Send>;
type Tick = Box<dyn FnMut(&Tx) + Send>;

/// Background jobs per batch before the batch's single full flush.
const BATCH: usize = 32;

#[derive(Default)]
struct Queues {
    interactive: VecDeque<Job>,
    background: VecDeque<Job>,
    stop: bool,
}

struct Inner {
    q: Mutex<Queues>,
    cv: Condvar,
}

#[derive(Clone)]
pub struct Writer {
    inner: Arc<Inner>,
    thread: Arc<Mutex<Option<JoinHandle<()>>>>,
}

thread_local! {
    static ON_WRITER: Cell<bool> = const { Cell::new(false) };
}

/// True on the writer's own thread.
pub fn on_writer_thread() -> bool {
    ON_WRITER.with(|c| c.get())
}

impl Writer {
    /// Starts the writer. `tick` runs on the writer's thread when it has been idle for
    /// `tick_every` (maintenance: repairs, timed checks).
    pub fn start(store: Arc<Store>, tick_every: Duration, mut tick: Option<Tick>) -> Writer {
        let inner = Arc::new(Inner { q: Mutex::new(Queues::default()), cv: Condvar::new() });
        let i2 = inner.clone();
        let handle = std::thread::Builder::new()
            .name("librarium-writer".into())
            .spawn(move || {
                ON_WRITER.with(|c| c.set(true));
                loop {
                    let mut q = i2.q.lock().unwrap();
                    while q.interactive.is_empty() && q.background.is_empty() && !q.stop {
                        let (g, to) = i2.cv.wait_timeout(q, tick_every).unwrap();
                        q = g;
                        if to.timed_out() && q.interactive.is_empty() && q.background.is_empty() && !q.stop {
                            drop(q);
                            if let Some(t) = tick.as_mut() {
                                let tx = Tx::new(&store, Durability::Batch);
                                t(&tx);
                                let _ = store.fs.barrier(&store.root);
                            }
                            q = i2.q.lock().unwrap();
                        }
                    }
                    if let Some(job) = q.interactive.pop_front() {
                        drop(q);
                        let tx = Tx::new(&store, Durability::Full);
                        let deliver = job(&tx);
                        deliver();
                        continue;
                    }
                    if !q.background.is_empty() {
                        let mut delivers = vec![];
                        let mut n = 0;
                        while n < BATCH {
                            let Some(job) = q.background.pop_front() else { break };
                            drop(q);
                            let tx = Tx::new(&store, Durability::Batch);
                            delivers.push(job(&tx));
                            n += 1;
                            q = i2.q.lock().unwrap();
                            if !q.interactive.is_empty() {
                                break;
                            }
                        }
                        drop(q);
                        // One full flush makes the whole batch durable.
                        let _ = store.fs.barrier(&store.root);
                        for d in delivers {
                            d();
                        }
                        continue;
                    }
                    if q.stop {
                        break;
                    }
                }
            })
            .expect("start the writer thread");
        Writer { inner, thread: Arc::new(Mutex::new(Some(handle))) }
    }

    /// Queues a job; its result arrives on the returned channel.
    pub fn submit<R: Send + 'static>(
        &self,
        lane: Lane,
        f: impl FnOnce(&Tx) -> R + Send + 'static,
    ) -> mpsc::Receiver<R> {
        let (tx, rx) = mpsc::channel();
        let job: Job = Box::new(move |t: &Tx| {
            // A panicking job must not stop the writer: its caller sees the channel close.
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(t))) {
                Ok(r) => Box::new(move || {
                    let _ = tx.send(r);
                }),
                Err(_) => Box::new(|| {}),
            }
        });
        {
            let mut q = self.inner.q.lock().unwrap();
            match lane {
                Lane::Interactive => q.interactive.push_back(job),
                Lane::Background => q.background.push_back(job),
            }
        }
        self.inner.cv.notify_one();
        rx
    }

    /// Runs a job and waits for its result.
    pub fn run<R: Send + 'static>(&self, lane: Lane, f: impl FnOnce(&Tx) -> R + Send + 'static) -> R {
        debug_assert!(!on_writer_thread(), "the writer must never wait on itself");
        self.submit(lane, f).recv().expect("the writer stopped")
    }

    /// Finishes queued work and stops the thread.
    pub fn stop(&self) {
        self.inner.q.lock().unwrap().stop = true;
        self.inner.cv.notify_all();
        if let Some(h) = self.thread.lock().unwrap().take() {
            if std::thread::current().id() != h.thread().id() {
                let _ = h.join();
            }
        }
    }
}
