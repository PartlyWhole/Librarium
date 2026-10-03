//! A fixed clock that only moves when told to.

use librarium_contracts::ports::Clock;
use std::sync::atomic::{AtomicI64, Ordering};

pub struct FixedClock {
    now: AtomicI64,
    offset_s: i32,
}

impl FixedClock {
    /// 2026-10-02T09:14:00Z, UTC.
    pub fn new() -> Self {
        Self::at(1_790_932_440_000, 0)
    }
    pub fn at(now_ms: i64, offset_s: i32) -> Self {
        FixedClock { now: AtomicI64::new(now_ms), offset_s }
    }
    pub fn advance_ms(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
    pub fn set_ms(&self, ms: i64) {
        self.now.store(ms, Ordering::SeqCst);
    }
}

impl Default for FixedClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn local_offset_s(&self, _at_ms: i64) -> i32 {
        self.offset_s
    }
}
