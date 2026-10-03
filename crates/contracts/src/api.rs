//! API message types: parameters and results of API calls.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Method names of the built-in API calls.
pub mod methods {
    pub const APP_INFO: &str = "app.info";
    pub const WORKER_PING: &str = "worker.ping";
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub api_methods: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct WorkerPong {
    pub worker_version: String,
    #[ts(type = "number")]
    pub pid: u32,
    #[ts(type = "number")]
    pub round_trip_us: u64,
}
