//! The real worker host against the real worker binary.
use librarium_contracts::ports::WorkerHost;
use librarium_worker_process::ProcessWorkerHost;
use std::time::Duration;

use librarium_testkit::binaries::worker_binary;

#[test]
fn real_worker_passes_the_shared_suite() {
    let host = ProcessWorkerHost::new(worker_binary(), 2 << 30);
    librarium_testkit::suites::worker::basic(&host);
}

#[test]
fn crash_and_hang_are_reported_and_the_worker_restarts() {
    let host = ProcessWorkerHost::new(worker_binary(), 2 << 30);
    host.call("ping", serde_json::json!({}), Duration::from_secs(10)).unwrap();
    let first = host.pid().unwrap();
    let e = host.call("test.crash", serde_json::json!({}), Duration::from_secs(10)).unwrap_err();
    assert_eq!(e.data.unwrap()["reason"], "crash");
    let e = host.call("test.hang", serde_json::json!({}), Duration::from_millis(500)).unwrap_err();
    assert_eq!(e.data.unwrap()["reason"], "timeout");
    host.call("ping", serde_json::json!({}), Duration::from_secs(10)).unwrap();
    assert_ne!(host.pid().unwrap(), first, "a fresh worker process");
}
