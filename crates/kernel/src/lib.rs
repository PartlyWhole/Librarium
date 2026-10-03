//! The kernel: the writer (two lanes), safe writes, intents, records and codecs, identity,
//! numbered changes, the derived-view host, the job host, registries and the link parser.
//!
//! The kernel knows nothing feature-specific: features contribute through slots.

pub mod registry;
