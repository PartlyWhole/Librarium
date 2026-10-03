//! A fixed sequence of IDs: valid UUID v7s whose last digits count up.

use librarium_contracts::ports::IdGenerator;
use librarium_contracts::Id;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct SequenceIds {
    next: AtomicU64,
}

impl SequenceIds {
    pub fn new() -> Self {
        SequenceIds { next: AtomicU64::new(1) }
    }
    /// The n-th ID this generator produces (1-based), without consuming it.
    pub fn nth(n: u64) -> Id {
        format!("0192f3a4-7c1e-7b2a-9f00-{n:012x}").parse().unwrap()
    }
}

impl Default for SequenceIds {
    fn default() -> Self {
        Self::new()
    }
}

impl IdGenerator for SequenceIds {
    fn next_id(&self) -> Id {
        Self::nth(self.next.fetch_add(1, Ordering::SeqCst))
    }
}
