//! Notes: everything the user writes. Named, in folders, linked to each other.

use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::registry::DuplicateId;

pub const ID: &str = "notes";
pub const KIND: &str = "note";
/// Mirrors the note's subfolder inside `notes/`.
pub const FOLDER_FIELD: &str = "notes.folder";

pub fn contribute_kinds(k: &mut Kinds) -> Result<(), DuplicateId> {
    k.add(
        ID,
        RecordKindDef {
            kind: KIND.into(),
            version: 1,
            format: Format::Markdown,
            folder: "notes".into(),
            slugged: true,
            subfolder_field: Some(FOLDER_FIELD.into()),
        },
    )
}
