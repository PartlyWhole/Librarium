//! Change events. They carry IDs and a sequence number, never record bodies.

use crate::id::Id;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeOp {
    Created,
    Updated,
    Renamed,
    Removed,
}

/// Where a change came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeOrigin {
    /// Written by this app.
    App,
    /// Found by the change source or the startup check.
    Outside,
}

/// One numbered change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Change {
    #[ts(type = "number")]
    pub seq: u64,
    pub id: Id,
    pub kind: String,
    pub op: ChangeOp,
    pub origin: ChangeOrigin,
}

/// Notification method names.
pub mod methods {
    pub const CHANGE: &str = "event.change";
    pub const INDEXED: &str = "event.indexed";
    pub const STATUS: &str = "event.status";
    pub const JOB: &str = "event.job";
}
