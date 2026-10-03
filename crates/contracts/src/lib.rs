//! Librarium's contracts: the vocabulary every other crate speaks.
//!
//! Types, IDs, events, errors, port traits, slot definitions and the API message types.
//! This crate depends on nothing of ours; everything else depends on it.

pub mod api;
pub mod error;
pub mod events;
pub mod id;
pub mod ports;
pub mod rpc;
pub mod slots;
pub mod typegen;

pub use error::{BackendError, ErrorCode, Result};
pub use id::Id;
