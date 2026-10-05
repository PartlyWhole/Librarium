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

/// Gives a non-Markdown kind's text to derived views and anchors (from stored files only).
/// The optional part picks one version of it (a web page's snapshot); `None` is the latest.
pub type TextSource = std::sync::Arc<
    dyn Fn(&crate::store::Store, &crate::store::Entry, Option<&str>) -> Option<librarium_contracts::api::StoredText>
        + Send
        + Sync,
>;

/// Says which parts of a record (e.g. a web page's snapshots) other records use, as
/// `(part, user)` pairs: such parts are never removed.
pub type PartUser = std::sync::Arc<
    dyn Fn(&crate::store::Store, librarium_contracts::Id) -> Vec<(String, librarium_contracts::Id)> + Send + Sync,
>;

pub struct Kinds {
    pub kinds: Registry<RecordKindDef>,
    pub slug_fields: Registry<SlugField>,
    pub text_sources: Registry<TextSource>,
    pub part_users: Registry<PartUser>,
}

impl Default for Kinds {
    fn default() -> Self {
        Self::new()
    }
}

impl Kinds {
    pub fn new() -> Self {
        Kinds {
            kinds: Registry::new(slots::RECORD_KINDS),
            slug_fields: Registry::new("kernel.slug-fields"),
            text_sources: Registry::new("kernel.text-sources"),
            part_users: Registry::new(slots::PART_USERS),
        }
    }
    /// Adds a kind. Kinds may share a top folder (boards beside notes) only if they are stored
    /// the same way there: the same format, slugs and subfolder field. The folder's first kind
    /// is its primary (what a file there is read as when it names no kind).
    pub fn add(&mut self, contributor: &str, def: RecordKindDef) -> Result<(), DuplicateId> {
        if let Some(other) = self.kinds.iter().find(|e| e.value.folder == def.folder) {
            let o = &other.value;
            if o.format != def.format || o.slugged != def.slugged || o.subfolder_field != def.subfolder_field {
                return Err(DuplicateId {
                    slot: slots::RECORD_KINDS,
                    id: format!("{} (folder {} is taken by {}, stored differently)", def.kind, def.folder, other.id),
                });
            }
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
    /// The folder's primary kind (the first added).
    pub fn by_folder(&self, folder: &str) -> Option<&RecordKindDef> {
        self.kinds.iter().map(|e| &e.value).find(|k| k.folder == folder)
    }
    /// Every kind kept in a top folder, the primary first.
    pub fn sharing(&self, folder: &str) -> Vec<&RecordKindDef> {
        self.kinds.iter().map(|e| &e.value).filter(|k| k.folder == folder).collect()
    }
    pub fn all(&self) -> impl Iterator<Item = &RecordKindDef> {
        self.kinds.iter().map(|e| &e.value)
    }
    /// Contributes the text of a kind's records (keyed by kind).
    pub fn add_text_source(&mut self, contributor: &str, kind: &str, f: TextSource) -> Result<(), DuplicateId> {
        self.text_sources.add(contributor, kind, f)
    }

    /// Declares which parts of records this contributor's records use.
    pub fn add_part_user(&mut self, contributor: &str, f: PartUser) -> Result<(), DuplicateId> {
        self.part_users.add(contributor, contributor, f)
    }

    /// The parts of a record in use, with the records using them.
    pub fn parts_in_use(
        &self,
        store: &crate::store::Store,
        id: librarium_contracts::Id,
    ) -> Vec<(String, librarium_contracts::Id)> {
        self.part_users.iter().flat_map(|e| (e.value)(store, id)).collect()
    }

    pub fn slug_fields_for(&self, kind: &str) -> Vec<&str> {
        self.slug_fields.iter().filter(|e| e.value.kind == kind).map(|e| e.value.field.as_str()).collect()
    }
}
