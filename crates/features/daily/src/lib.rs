//! Daily: any note can be a day. A daily note is an ordinary note with `daily.date`.

use librarium_kernel::kinds::{Kinds, SlugField};
use librarium_kernel::registry::DuplicateId;

pub const ID: &str = "daily";
pub const DATE_FIELD: &str = "daily.date";

/// A daily note's slug is its date.
pub fn contribute_kinds(k: &mut Kinds) -> Result<(), DuplicateId> {
    k.add_slug_field(ID, SlugField { kind: "note".into(), field: DATE_FIELD.into() })
}
