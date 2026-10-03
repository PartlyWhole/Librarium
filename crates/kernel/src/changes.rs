//! Numbered changes, in memory only. Subscribers (derived views, the transport) receive every
//! change after the file, the index and memory are updated.

use librarium_contracts::events::{Change, ChangeOp, ChangeOrigin};
use librarium_contracts::Id;
use std::sync::{Arc, Mutex, RwLock};

pub type Subscriber = Arc<dyn Fn(&Change) + Send + Sync>;

#[derive(Default)]
pub struct ChangeLog {
    seq: Mutex<u64>,
    subs: RwLock<Vec<Subscriber>>,
}

impl ChangeLog {
    pub fn subscribe(&self, f: Subscriber) {
        self.subs.write().unwrap().push(f);
    }
    pub fn last_seq(&self) -> u64 {
        *self.seq.lock().unwrap()
    }
    pub fn emit(&self, id: Id, kind: &str, op: ChangeOp, origin: ChangeOrigin) -> u64 {
        // Numbering and delivery happen under one lock so subscribers see changes in order.
        let mut seq = self.seq.lock().unwrap();
        *seq += 1;
        let c = Change { seq: *seq, id, kind: kind.to_string(), op, origin };
        for s in self.subs.read().unwrap().iter() {
            s(&c);
        }
        *seq
    }
}
