//! Record kinds, contributed through the `kernel.record-kinds` slot.

use crate::registry::{DuplicateId, Registry};
use librarium_contracts::slots;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// `<folder>/[sub/]<id>[-slug].md`: Markdown with frontmatter.
    Markdown,
    /// `<folder>/<id>[-slug]/record.json`: a folder holding binary files.
    JsonDir,
}

#[derive(Debug, Clone)]
pub struct RecordKindDef {
    pub kind: String,
    /// The current `kind-version`.
    pub version: i64,
    pub format: Format,
    /// The top-level folder in the store.
    pub folder: String,
    /// File names carry a slug after the ID.
    pub slugged: bool,
    /// The field that mirrors the record's subfolder (path wins when they disagree).
    pub subfolder_field: Option<String>,
}

/// A field that, when present, gives the slug instead of the title
/// (e.g. a dated note's slug is its date). Contributed by any module.
#[derive(Debug, Clone)]
pub struct SlugField {
    pub kind: String,
    pub field: String,
}

pub struct Kinds {
    pub kinds: Registry<RecordKindDef>,
    pub slug_fields: Registry<SlugField>,
}

impl Default for Kinds {
    fn default() -> Self {
        Self::new()
    }
}

impl Kinds {
    pub fn new() -> Self {
        Kinds { kinds: Registry::new(slots::RECORD_KINDS), slug_fields: Registry::new("kernel.slug-fields") }
    }
    pub fn add(&mut self, contributor: &str, def: RecordKindDef) -> Result<(), DuplicateId> {
        if let Some(other) = self.kinds.iter().find(|e| e.value.folder == def.folder) {
            return Err(DuplicateId {
                slot: slots::RECORD_KINDS,
                id: format!("{} (folder {} is taken by {})", def.kind, def.folder, other.id),
            });
        }
        let id = def.kind.clone();
        self.kinds.add(contributor, &id, def)
    }
    pub fn add_slug_field(&mut self, contributor: &str, f: SlugField) -> Result<(), DuplicateId> {
        let id = format!("{}:{}", f.kind, f.field);
        self.slug_fields.add(contributor, &id, f)
    }
    pub fn get(&self, kind: &str) -> Option<&RecordKindDef> {
        self.kinds.get(kind)
    }
    pub fn by_folder(&self, folder: &str) -> Option<&RecordKindDef> {
        self.kinds.iter().map(|e| &e.value).find(|k| k.folder == folder)
    }
    pub fn all(&self) -> impl Iterator<Item = &RecordKindDef> {
        self.kinds.iter().map(|e| &e.value)
    }
    pub fn slug_fields_for(&self, kind: &str) -> Vec<&str> {
        self.slug_fields.iter().filter(|e| e.value.kind == kind).map(|e| e.value.field.as_str()).collect()
    }
}
