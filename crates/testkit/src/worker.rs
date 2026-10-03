//! An in-process WorkerHost: methods are closures, and crashes and hangs are scripted.

use librarium_contracts::ports::WorkerHost;
use librarium_contracts::{BackendError, ErrorCode, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

type Method = Box<dyn Fn(Value) -> Result<Value> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    Crash,
    Hang,
}

pub struct FakeWorkerHost {
    methods: HashMap<String, Method>,
    faults: Mutex<VecDeque<Fault>>,
    pub starts: Mutex<u32>,
    pub calls: Mutex<Vec<String>>,
}

impl FakeWorkerHost {
    pub fn new() -> Self {
        let mut m: HashMap<String, Method> = HashMap::new();
        m.insert("ping".into(), Box::new(|_| Ok(json!({ "worker_version": "fake", "pid": 0 }))));
        FakeWorkerHost {
            methods: m,
            faults: Mutex::new(VecDeque::new()),
            starts: Mutex::new(0),
            calls: Mutex::new(vec![]),
        }
    }
    pub fn with(mut self, method: &str, f: impl Fn(Value) -> Result<Value> + Send + Sync + 'static) -> Self {
        self.methods.insert(method.into(), Box::new(f));
        self
    }
    /// The next calls fail with these faults, in order.
    pub fn script(&self, faults: &[Fault]) {
        self.faults.lock().unwrap().extend(faults.iter().copied());
    }
}

impl Default for FakeWorkerHost {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkerHost for FakeWorkerHost {
    fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        self.calls.lock().unwrap().push(method.to_string());
        if let Some(f) = self.faults.lock().unwrap().pop_front() {
            *self.starts.lock().unwrap() += 1;
            let (reason, msg) = match f {
                Fault::Crash => ("crash", format!("the worker crashed on {method}")),
                Fault::Hang => ("timeout", format!("the worker timed out after {timeout:?} on {method}")),
            };
            return Err(BackendError::new(ErrorCode::Worker, msg).with_data(json!({ "reason": reason })));
        }
        match self.methods.get(method) {
            Some(f) => f(params),
            None => Err(BackendError::not_found(format!("no worker method {method}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn fake_passes_the_shared_suite() {
        crate::suites::worker::basic(&super::FakeWorkerHost::new());
    }
}
