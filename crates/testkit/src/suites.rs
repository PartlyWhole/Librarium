//! Shared port suites: one suite per port, run against both its real and its test adapter.

pub mod worker {
    use librarium_contracts::ports::WorkerHost;
    use std::time::Duration;

    /// Every WorkerHost answers `ping` and reports unknown methods as errors.
    pub fn basic(host: &dyn WorkerHost) {
        let v = host.call("ping", serde_json::json!({}), Duration::from_secs(10)).expect("ping");
        assert!(v.get("worker_version").is_some(), "ping reply has a version: {v}");
        let e = host.call("no.such.method", serde_json::json!({}), Duration::from_secs(10)).unwrap_err();
        assert_eq!(e.code, librarium_contracts::ErrorCode::NotFound);
    }
}
