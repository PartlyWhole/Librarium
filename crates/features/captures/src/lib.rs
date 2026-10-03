//! Captures: a passage or region kept with your own words, pointing back to its exact place.

use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::registry::DuplicateId;

pub const ID: &str = "captures";
pub const KIND: &str = "capture";

pub fn contribute_kinds(k: &mut Kinds) -> Result<(), DuplicateId> {
    k.add(
        ID,
        RecordKindDef {
            kind: KIND.into(),
            version: 1,
            format: Format::Markdown,
            folder: "captures".into(),
            slugged: false,
            subfolder_field: None,
        },
    )
}
