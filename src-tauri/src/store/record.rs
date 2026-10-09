//! Records: the kinds, reading a record's file, and where a record lives. Writes are in
//! `save` (create, save, set fields), `relocate` (rename and move, delete) and `merge`.

use super::frontmatter::{self, FmError, FmValue, Frontmatter};
use super::Library;
use crate::error::{Context, Error, Result};
use crate::types::{RecordInfo, RecordText, StoredText, TextSegment};
use crate::util::{now_ms, parse_id, sha256, slugify, Id};
use serde_json::{json, Map, Value};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

/// How a kind is stored.
#[derive(Debug, PartialEq, Eq)]
pub struct Kind {
    pub name: &'static str,
    /// Its top folder in the library.
    pub folder: &'static str,
    /// `<folder>/<id>[-slug]/record.json` rather than `<folder>/<id>[-slug].md`.
    pub json: bool,
    /// File names carry a slug after the ID.
    pub slugged: bool,
    /// The field mirroring the record's subfolder, for kinds kept in the user's folders.
    pub folder_field: Option<&'static str>,
}

/// Every kind the app knows. The first kind of a folder is what a file there is read as when it
/// names none.
pub const KINDS: &[Kind] = &[
    Kind { name: "note", folder: "notes", json: false, slugged: true, folder_field: Some("notes.folder") },
    Kind { name: "board", folder: "notes", json: false, slugged: true, folder_field: Some("notes.folder") },
    Kind { name: "capture", folder: "captures", json: false, slugged: false, folder_field: None },
    Kind { name: "item", folder: "items", json: true, slugged: true, folder_field: Some("library.folder") },
];

/// The keys every record has; fields are `<module>.<name>`.
pub const RESERVED: &[&str] = &["id", "kind", "kind-version", "created", "title", "copied-from"];
/// The highest `kind-version` this app knows.
const KIND_VERSION: i64 = 1;

pub fn kind(name: &str) -> Option<&'static Kind> {
    KINDS.iter().find(|k| k.name == name)
}

/// The kind owning the top folder a library-relative path is in.
pub fn folder_kind(rel: &str) -> Option<&'static Kind> {
    let top = rel.split('/').next()?;
    KINDS.iter().find(|k| k.folder == top)
}

/// A record as the index knows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: Id,
    pub kind: String,
    pub title: String,
    pub path: String,
    pub size: u64,
    pub mtime_ns: i64,
    pub inode: u64,
    /// When the file was last looked at (ns): a file modified since must be read again.
    pub checked_ns: i64,
    pub hash: String,
    pub created: Option<String>,
    pub read_only: Option<String>,
    pub fields: Map<String, Value>,
}

impl Entry {
    pub fn field_str(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(Value::as_str)
    }

    /// Stored as Markdown (unknown kinds found in Markdown folders too).
    pub fn is_markdown(&self) -> bool {
        self.path.ends_with(".md")
    }

    /// The folder holding the record's file (an item's own folder).
    pub fn dir(&self, lib: &Library) -> PathBuf {
        lib.root.join(&self.path).parent().unwrap_or(&lib.root).to_path_buf()
    }
}

pub fn info(lib: &Library, e: &Entry) -> RecordInfo {
    RecordInfo {
        id: e.id,
        kind: e.kind.clone(),
        title: e.title.clone(),
        path: e.path.clone(),
        version: e.hash.clone(),
        created: e.created.clone(),
        read_only: e.read_only.clone(),
        fields: e.fields.clone(),
        conflicts: lib.problems.lock().unwrap().conflicts_of(e.id),
    }
}

// ---- reading ---------------------------------------------------------------------------------

/// A record's file, decoded.
#[derive(Debug, Clone)]
pub struct Decoded {
    pub id: Option<Id>,
    /// The ID text when present but not canonical.
    pub damaged_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub created: Option<String>,
    pub fields: Map<String, Value>,
    pub read_only: Option<String>,
}

/// Decodes a file found at a library-relative path; `None` outside every kind's folder.
pub fn decode(rel: &str, bytes: &[u8]) -> Option<Decoded> {
    let k = folder_kind(rel)?;
    let text = String::from_utf8_lossy(bytes);
    let mut d = Decoded {
        id: None,
        damaged_id: None,
        kind: k.name.to_string(),
        title: String::new(),
        created: None,
        fields: Map::new(),
        read_only: None,
    };
    let mut kind_version = 1;
    if k.json {
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => {
                kind_version = fill_envelope(&mut d, |key| m.get(key).and_then(FmValue::from_json));
                d.fields = m;
            }
            Ok(_) => d.read_only = Some(unparsable("record.json is not an object")),
            Err(e) => {
                d.read_only = Some(unparsable(&e.to_string()));
                d.id = text.find("\"id\"").and_then(|i| {
                    let rest = &text[i + 4..];
                    rest.find('"').and_then(|q| rest.get(q + 1..q + 37)).and_then(parse_id)
                });
            }
        }
    } else {
        match frontmatter::split(&text).0 {
            None => d.title = first_heading(&text).unwrap_or_default(),
            Some((fm, _)) => match Frontmatter::parse(fm) {
                Ok(fm) => {
                    d.fields = fm.to_json();
                    kind_version = fill_envelope(&mut d, |key| fm.get(key).cloned());
                    if fm.get("title").is_none() {
                        d.title = first_heading(body(&text)).unwrap_or_default();
                    }
                }
                Err(FmError::Invalid(m) | FmError::Complex(m)) => {
                    // The ID is still found, line by line.
                    d.id = fm
                        .lines()
                        .find_map(|l| l.strip_prefix("id:"))
                        .and_then(|v| parse_id(v.trim().trim_matches(['"', '\''])));
                    d.read_only = Some(unparsable(&m));
                }
            },
        }
    }
    if d.read_only.is_none() {
        if kind(&d.kind).is_none() {
            d.read_only = Some(format!("No part of this app knows the kind “{}”.", d.kind));
        } else if kind_version > KIND_VERSION {
            d.read_only = Some(format!(
                "It was written by a newer version (kind-version {kind_version}; this app knows {KIND_VERSION})."
            ));
        }
    }
    Some(d)
}

fn unparsable(m: &str) -> String {
    format!("Its frontmatter doesn’t parse ({m}), so it is shown but never rewritten.")
}

fn first_heading(text: &str) -> Option<String> {
    text.lines().find_map(|l| l.strip_prefix("# ").map(|t| t.trim().to_string()))
}

/// Reads the envelope; returns the `kind-version`.
fn fill_envelope(d: &mut Decoded, get: impl Fn(&str) -> Option<FmValue>) -> i64 {
    match get("id") {
        Some(FmValue::Str(s)) => match parse_id(&s) {
            Some(id) => d.id = Some(id),
            None => d.damaged_id = Some(s),
        },
        Some(other) if other != FmValue::Null => d.damaged_id = Some(other.emit()),
        _ => {}
    }
    if let Some(FmValue::Str(k)) = get("kind") {
        d.kind = k;
    }
    match get("title") {
        Some(FmValue::Str(t)) => d.title = t,
        Some(v) if v != FmValue::Null => d.title = v.emit(),
        _ => {}
    }
    if let Some(FmValue::Str(c)) = get("created") {
        d.created = Some(c);
    }
    get("kind-version").and_then(|v| v.as_i64()).unwrap_or(1)
}

/// The frontmatter of a new record: the envelope, then its fields in order.
pub fn new_frontmatter(id: Id, kind: &str, created: &str, title: &str, fields: &[(String, FmValue)]) -> String {
    let s = |v: &str| FmValue::Str(v.into()).emit();
    let mut out =
        format!("id: \"{id}\"\nkind: {}\nkind-version: 1\ncreated: {}\ntitle: {}\n", s(kind), s(created), s(title));
    for (k, v) in fields {
        out.push_str(&format!("{k}: {}\n", v.emit()));
    }
    out
}

/// The Markdown body of a file's text.
pub fn body(text: &str) -> &str {
    frontmatter::split(text).1
}

pub(super) fn newline_of(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

pub fn read_text(lib: &Library, id: Id) -> Result<RecordText> {
    let e = lib.index.get(id).ok_or_else(|| Error::not_found("That record can’t be found."))?;
    let bytes = fs::read(lib.root.join(&e.path)).ctx("reading the record")?;
    let text = String::from_utf8_lossy(&bytes);
    let (fm, body) = frontmatter::split(&text);
    let mut info = info(lib, &e);
    info.version = sha256(&bytes);
    Ok(RecordText { info, frontmatter: fm.map(|f| f.0.to_string()).unwrap_or_default(), body: body.to_string() })
}

/// A record's text as search and anchors see it: a Markdown body, or an item's stored text
/// (pages or chapters joined by blank lines; a web page's snapshot). Stored files only.
pub fn stored_text(lib: &Library, e: &Entry, part: Option<&str>) -> Option<StoredText> {
    let one = |text: String, origin: Option<Value>| {
        let end = text.chars().count() as u64;
        StoredText { text, segments: vec![TextSegment { label: String::new(), start: 0, end }], origin }
    };
    if e.is_markdown() {
        let bytes = fs::read(lib.root.join(&e.path)).ok()?;
        return Some(one(body(&String::from_utf8_lossy(&bytes)).to_string(), None));
    }
    let read = |rel: &str| -> Option<Value> { serde_json::from_slice(&fs::read(e.dir(lib).join(rel)).ok()?).ok() };
    if e.field_str("library.format") == Some("web") {
        let at = part.or(e.field_str("library.snapshot"))?;
        if at.contains(['/', '.']) {
            return None;
        }
        let file = format!("snapshots/{at}/text.json");
        let v = read(&file)?;
        let origin = json!({ "file": file, "extractor": v["extractor"], "version": v["version"], "snapshot": at });
        return Some(one(v["text"].as_str().unwrap_or("").to_string(), Some(origin)));
    }
    let file = e.field_str("library.text")?;
    let v = read(file)?;
    let (parts, pages) = match v["pages"].as_array() {
        Some(p) => (p, true),
        None => (v["chapters"].as_array()?, false),
    };
    let mut text = String::new();
    let mut segments = vec![];
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            text.push_str("\n\n");
        }
        let start = text.chars().count() as u64;
        text.push_str(p["text"].as_str().unwrap_or(""));
        let label = if pages {
            format!("p. {}", p["page"].as_u64().unwrap_or(i as u64 + 1))
        } else {
            p["title"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or(format!("chapter {}", i + 1))
        };
        segments.push(TextSegment { label, start, end: text.chars().count() as u64 });
    }
    let origin = json!({ "file": file, "extractor": v["extractor"], "version": v["version"] });
    Some(StoredText { text, segments, origin: Some(origin) })
}

// ---- names -----------------------------------------------------------------------------------

/// A record's slug: from `daily.date` when present, otherwise from its title.
pub fn slug_for(title: &str, fields: &Map<String, Value>) -> String {
    match fields.get("daily.date").and_then(Value::as_str).map(slugify) {
        Some(s) if !s.is_empty() => s,
        _ => slugify(title),
    }
}

/// Where a record of this kind lives.
pub fn record_path(k: &Kind, id: Id, slug: &str, sub: Option<&str>) -> String {
    let base = if k.slugged && !slug.is_empty() { format!("{id}-{slug}") } else { id.to_string() };
    let sub = sub.filter(|s| !s.is_empty()).map(|s| format!("{s}/")).unwrap_or_default();
    if k.json {
        format!("{}/{sub}{base}/record.json", k.folder)
    } else {
        format!("{}/{sub}{base}.md", k.folder)
    }
}

/// The subfolder a record's path is in, inside its kind's folder ("" at the top).
pub fn subfolder_of(k: &Kind, rel: &str) -> Option<String> {
    let inner = rel.strip_prefix(&format!("{}/", k.folder))?;
    let inner = if k.json { inner.strip_suffix("/record.json")? } else { inner };
    Some(inner.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default())
}

/// The entry for a file's bytes as just read or written.
pub fn entry_from(rel: &str, meta: &fs::Metadata, bytes: &[u8], d: &Decoded, id: Id) -> Entry {
    Entry {
        id,
        kind: d.kind.clone(),
        title: d.title.clone(),
        path: rel.to_string(),
        size: meta.len(),
        mtime_ns: meta.mtime().saturating_mul(1_000_000_000).saturating_add(meta.mtime_nsec()),
        inode: meta.ino(),
        checked_ns: now_ms().saturating_mul(1_000_000),
        hash: sha256(bytes),
        created: d.created.clone(),
        read_only: d.read_only.clone(),
        fields: d.fields.clone(),
    }
}
