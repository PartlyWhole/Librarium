//! API calls that modules contribute through the `kernel.api-methods` slot. Each gets a narrow
//! context: the open library and the per-device settings, nothing else.

use crate::library::Library;
use crate::registry::Registry;
use librarium_contracts::{slots, Result};
use serde_json::Value;
use std::sync::Arc;

pub struct MethodCtx<'a> {
    pub library: &'a Arc<Library>,
    pub setting: &'a dyn Fn(&str) -> Option<Value>,
    /// The derived views, once started.
    pub views: Option<&'a crate::views::ViewHost>,
    /// The job host, once started.
    pub jobs: Option<&'a crate::jobs::JobHost>,
}

pub type ApiMethod = Arc<dyn Fn(&MethodCtx, Value) -> Result<Value> + Send + Sync>;

pub fn registry() -> Registry<ApiMethod> {
    Registry::new(slots::API_METHODS)
}
