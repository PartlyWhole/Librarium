//! The kernel: the writer (two lanes), safe writes, intents, records and codecs, identity,
//! numbered changes, the derived-view host, the job host, registries and the link parser.
//!
//! The kernel knows nothing feature-specific: features contribute through slots.

pub mod changes;
pub mod check;
pub mod drafts;
pub mod frontmatter;
pub mod hash;
pub mod hosts;
pub mod jobs;
pub mod kinds;
pub mod library;
pub mod links;
pub mod merge;
pub mod methods;
pub mod record;
pub mod registry;
pub mod settings;
pub mod slug;
pub mod store;
pub mod time;
pub mod views;
pub mod writer;
