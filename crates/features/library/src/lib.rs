//! Library: saved web pages, PDFs, images and EPUBs, each a folder with `record.json`.

use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::registry::DuplicateId;

pub const ID: &str = "library";
pub const KIND: &str = "item";

pub fn contribute_kinds(k: &mut Kinds) -> Result<(), DuplicateId> {
    k.add(
        ID,
        RecordKindDef {
            kind: KIND.into(),
            version: 1,
            format: Format::JsonDir,
            folder: "items".into(),
            slugged: true,
            subfolder_field: None,
        },
    )
}
