//! Records: the kinds, reading a record's file, and every write to a record (create, save with
//! a three-way merge, set fields, rename and move, delete, bring back).

use super::frontmatter::{self, FmError, FmValue, Frontmatter};
use super::write::{rename_exclusive, safe_write, sync_dir, writable as file_writable, write_intent, Intent};
use super::{Library, Write};
use crate::error::{Context, Error, Result};
use crate::types::{RecordInfo, RecordText, SaveResult, StoredText, TextSegment};
use crate::util::{clean_title, iso_utc, json_bytes, now_ms, parse_id, sha256, slugify, Id};
use serde_json::{json, Map, Value};
use similar::{capture_diff_slices, Algorithm, DiffOp};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

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

fn newline_of(text: &str) -> &'static str {
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

// ---- writing ---------------------------------------------------------------------------------

/// Indexes a record, and queues a link-label refresh when its title changed or one of its
/// unresolved links could now be filled in.
pub(crate) fn index(w: &Write, e: &Entry, bytes: &[u8]) -> Result<()> {
    let lib = w.lib;
    let text = if e.is_markdown() {
        body(&String::from_utf8_lossy(bytes)).to_string()
    } else {
        stored_text(lib, e, None).map(|t| t.text).unwrap_or_default()
    };
    let old = lib.index.put(e, &text, e.is_markdown())?;
    let renamed = old.as_deref() != Some(e.title.as_str());
    let waiting = renamed && !lib.index.unresolved_sources(&e.title)?.is_empty();
    if (renamed && old.is_some()) || waiting || lib.index.has_resolvable(e.id) {
        lib.jobs.enqueue(lib, "links.repair", &e.id.to_string(), json!({ "id": e.id, "old_title": old }));
    }
    Ok(())
}

/// After the app wrote a record's file: index it, keep a version of it, announce it.
pub(crate) fn commit(w: &Write, rel: &str, bytes: &[u8]) -> Result<Entry> {
    let lib = w.lib;
    let meta = fs::metadata(lib.root.join(rel)).ctx("reading back what was written")?;
    let d = decode(rel, bytes).ok_or_else(|| Error::invalid(format!("{rel} is outside every kind’s folder")))?;
    let id = d.id.ok_or_else(|| Error::invalid("the record written has no ID"))?;
    let e = entry_from(rel, &meta, bytes, &d, id);
    index(w, &e, bytes)?;
    if e.is_markdown() {
        let origin = lib.history.next_origin(id);
        lib.history.take(&e, bytes, origin);
    }
    w.changed(id);
    Ok(e)
}

/// The record, if the app may rewrite it.
pub(crate) fn writable(w: &Write, id: Id) -> Result<Entry> {
    let e = w.lib.index.get(id).ok_or_else(|| Error::not_found("That record can’t be found."))?;
    if let Some(why) = &e.read_only {
        return Err(Error::read_only(why.clone()));
    }
    if !file_writable(&w.lib.root.join(&e.path)) {
        return Err(Error::read_only(format!("“{}” is locked or read-only, so it can’t be saved.", e.title)));
    }
    Ok(e)
}

fn fm_err(e: FmError) -> Error {
    Error::read_only(e.to_string())
}

/// Creates a Markdown record, in a subfolder of its kind's folder when given.
pub fn create(
    w: &Write,
    kind_name: &str,
    title: &str,
    fields: Vec<(String, FmValue)>,
    body: &str,
    sub: Option<&str>,
) -> Result<Entry> {
    create_with_sidecars(w, crate::util::new_id(), kind_name, title, fields, body, sub, &[])
}

/// Creates a Markdown record with its sidecars (`(suffix, bytes)`), written first beside it:
/// the record's own file is the commit point.
#[allow(clippy::too_many_arguments)]
pub fn create_with_sidecars(
    w: &Write,
    id: Id,
    kind_name: &str,
    title: &str,
    mut fields: Vec<(String, FmValue)>,
    body: &str,
    sub: Option<&str>,
    sidecars: &[(String, Vec<u8>)],
) -> Result<Entry> {
    let k = kind(kind_name).ok_or_else(|| Error::invalid(format!("unknown kind “{kind_name}”")))?;
    if k.json {
        return Err(Error::invalid(format!("{kind_name} records are imported, not created")));
    }
    if let Some((key, _)) =
        fields.iter().find(|(key, v)| RESERVED.contains(&key.as_str()) || matches!(v, FmValue::Other(_)))
    {
        return Err(Error::invalid(format!("field “{key}” can’t be set this way")));
    }
    let sub = sub.map(|s| s.trim_matches('/')).filter(|s| !s.is_empty());
    let sub = match sub.map(super::folders::clean_folder).transpose()? {
        Some(s) if k.folder_field.is_some() => Some(s),
        _ => None,
    };
    if let (Some(f), Some(s)) = (k.folder_field, &sub) {
        fields.retain(|(key, _)| key != f);
        fields.push((f.to_string(), FmValue::Str(s.clone())));
    }
    if w.lib.index.get(id).is_some() {
        return Err(Error::conflict("That ID is taken."));
    }
    let title = clean_title(title);
    let fm = new_frontmatter(id, kind_name, &iso_utc(now_ms()), &title, &fields);
    let map: Map<String, Value> = fields.iter().map(|(k, v)| (k.clone(), v.to_json())).collect();
    let rel = record_path(k, id, &slug_for(&title, &map), sub.as_deref());
    let path = w.lib.root.join(&rel);
    let dir = path.parent().unwrap();
    fs::create_dir_all(dir).ctx("making the folder")?;
    for (suffix, bytes) in sidecars {
        super::files::check_suffix(suffix)?;
        safe_write(&dir.join(format!("{id}{suffix}")), bytes, false).ctx("writing a sidecar")?;
    }
    let bytes = frontmatter::join(&fm, body, "\n").into_bytes();
    safe_write(&path, &bytes, true).ctx("writing the new record")?;
    commit(w, &rel, &bytes)
}

/// Saves a new body. The save carries the version it was based on: if the file changed since,
/// the edits are merged three ways with the base body, or both versions are returned. A file
/// that has gone is never re-created.
pub fn save_body(w: &Write, id: Id, base_version: &str, base_body: Option<&str>, new_body: &str) -> Result<SaveResult> {
    let e = writable(w, id)?;
    let path = w.lib.root.join(&e.path);
    let cur = match fs::read(&path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Err(Error::not_found(format!("“{}” can’t be found any more, so it wasn’t saved.", e.title)))
        }
        r => r.ctx("reading before saving")?,
    };
    let cur_version = sha256(&cur);
    let cur_text = String::from_utf8_lossy(&cur).into_owned();
    let (fm, cur_body) = frontmatter::split(&cur_text);
    let (body, merged) = if cur_version == base_version {
        (new_body.to_string(), false)
    } else {
        match base_body.and_then(|b| merge3(b, new_body, cur_body)) {
            Some(m) => (m, true),
            None => return Ok(SaveResult::Conflict { version: cur_version, body: cur_body.to_string() }),
        }
    };
    let text = match fm {
        Some((f, _)) => frontmatter::join(f, &body, newline_of(&cur_text)),
        None => body.clone(),
    };
    let version = if text.as_bytes() == cur.as_slice() {
        cur_version
    } else {
        safe_write(&path, text.as_bytes(), false).ctx("saving")?;
        commit(w, &e.path, text.as_bytes())?.hash
    };
    let seq = w.seq();
    Ok(if merged { SaveResult::Merged { version, body, seq } } else { SaveResult::Saved { version, seq } })
}

/// Rewrites a Markdown body if the file is still at `expected_version` (`f` returns `None`
/// when nothing needs changing). Returns whether it wrote.
pub fn rewrite_body(w: &Write, id: Id, expected_version: &str, f: impl FnOnce(&str) -> Option<String>) -> Result<bool> {
    let e = writable(w, id)?;
    let path = w.lib.root.join(&e.path);
    let cur = fs::read(&path).ctx("reading")?;
    if sha256(&cur) != expected_version {
        return Err(Error::conflict(format!("“{}” changed since; nothing was changed.", e.title)));
    }
    let text = String::from_utf8_lossy(&cur).into_owned();
    let (fm, body) = frontmatter::split(&text);
    let Some(new_body) = f(body) else { return Ok(false) };
    let out = match fm {
        Some((f, _)) => frontmatter::join(f, &new_body, newline_of(&text)),
        None => new_body,
    };
    if out.as_bytes() == cur.as_slice() {
        return Ok(false);
    }
    safe_write(&path, out.as_bytes(), false).ctx("saving")?;
    commit(w, &e.path, out.as_bytes())?;
    Ok(true)
}

/// Sets (or with `None` removes) module fields, changing only their bytes.
pub fn set_fields(w: &Write, id: Id, base_version: Option<&str>, edits: &[(String, Option<FmValue>)]) -> Result<Entry> {
    let e = writable(w, id)?;
    let k = kind(&e.kind).ok_or_else(|| Error::read_only("unknown kind"))?;
    if let Some((key, _)) =
        edits.iter().find(|(key, _)| RESERVED.contains(&key.as_str()) || Some(key.as_str()) == k.folder_field)
    {
        return Err(Error::invalid(format!("field “{key}” can’t be set this way")));
    }
    if base_version.is_some_and(|v| v != e.hash) {
        return Err(Error::conflict(format!("“{}” changed since, so this wasn’t done.", e.title)));
    }
    rewrite_fields(w, &e, edits, false)
}

/// Rewrites fields of a record's frontmatter (or `record.json`), then commits it.
pub(crate) fn rewrite_fields(
    w: &Write,
    e: &Entry,
    edits: &[(String, Option<FmValue>)],
    renamed: bool,
) -> Result<Entry> {
    let path = w.lib.root.join(&e.path);
    let cur = fs::read(&path).ctx("reading")?;
    let out = if e.is_markdown() {
        let text = String::from_utf8_lossy(&cur).into_owned();
        let (fm, body) = frontmatter::split(&text);
        let mut fm = Frontmatter::parse(fm.map(|f| f.0).unwrap_or("")).map_err(fm_err)?;
        for (k, v) in edits {
            match v {
                Some(v) => fm.set(k, v).map_err(fm_err)?,
                None => fm.remove(k).map_err(fm_err)?,
            }
        }
        frontmatter::join(fm.text(), body, newline_of(&text)).into_bytes()
    } else {
        let mut obj: Map<String, Value> = serde_json::from_slice(&cur).map_err(|e| Error::read_only(e.to_string()))?;
        for (k, v) in edits {
            match v {
                Some(v) => obj.insert(k.clone(), v.to_json()),
                None => obj.remove(k),
            };
        }
        json_bytes(&Value::Object(obj), true)
    };
    if out == cur && !renamed {
        return Ok(e.clone());
    }
    if out != cur {
        safe_write(&path, &out, false).ctx("saving")?;
    }
    commit(w, &e.path, &out)
}

/// Runs a multi-file operation under an intent, so it finishes after a crash.
fn with_intent<T>(w: &Write, intent: &Intent, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let p = write_intent(&w.lib.app_dir, intent)?;
    let r = f();
    if r.is_ok() {
        let _ = fs::remove_file(p);
    }
    r
}

/// Carries out an intent left by an operation that didn't finish.
pub fn redo(w: &Write, intent: &Intent) -> Result<()> {
    match intent {
        Intent::Relocate { record, title, subfolder } => {
            apply_relocate(w, *record, title, subfolder.as_deref()).map(drop)
        }
        Intent::Identify { from, id, copied_from } => {
            super::repair::apply_identify(w, from, *id, *copied_from).map(drop)
        }
        Intent::Delete { record, files, folders } => apply_delete(w, *record, files, folders),
        Intent::MoveFolder { kind, from, to } => super::folders::apply_move(w, kind, from, to).map(drop),
    }
}

/// Renames and/or moves a record: the file name follows the title. `subfolder`: absent keeps
/// the folder, `None` is the top. Refuses if the record changed since `base_version` (undo).
pub fn relocate(
    w: &Write,
    id: Id,
    base_version: Option<&str>,
    title: Option<&str>,
    subfolder: Option<Option<&str>>,
) -> Result<Entry> {
    let e = writable(w, id)?;
    if base_version.is_some_and(|v| v != e.hash) {
        return Err(Error::conflict(format!("“{}” changed since, so this can’t be undone.", e.title)));
    }
    let k = kind(&e.kind).ok_or_else(|| Error::read_only("unknown kind"))?;
    let title = title.map(clean_title).unwrap_or_else(|| e.title.clone());
    if title.is_empty() {
        return Err(Error::invalid("A title can’t be empty."));
    }
    let sub = match subfolder {
        Some(s) => {
            s.map(|x| x.trim_matches('/')).filter(|x| !x.is_empty()).map(super::folders::clean_folder).transpose()?
        }
        None => subfolder_of(k, &e.path).filter(|x| !x.is_empty()),
    };
    if sub.is_some() && k.folder_field.is_none() {
        return Err(Error::invalid(format!("“{}” can’t be put in a folder.", e.title)));
    }
    let intent = Intent::Relocate { record: id, title: title.clone(), subfolder: sub.clone() };
    with_intent(w, &intent, || apply_relocate(w, id, &title, sub.as_deref()))
}

/// Renames the file (sidecars first), then rewrites the title and folder field.
fn apply_relocate(w: &Write, id: Id, title: &str, sub: Option<&str>) -> Result<Entry> {
    let lib = w.lib;
    let mut e = lib.index.get(id).ok_or_else(|| Error::not_found("That record can’t be found."))?;
    let k = kind(&e.kind).ok_or_else(|| Error::read_only("unknown kind"))?;
    let mut fields = e.fields.clone();
    if let Some(f) = k.folder_field {
        match sub {
            Some(s) => fields.insert(f.into(), Value::String(s.into())),
            None => fields.remove(f),
        };
    }
    let target = record_path(k, id, &slug_for(title, &fields), sub);
    let renamed = target != e.path;
    if renamed {
        let (from, to) = if k.json {
            (
                lib.root.join(&e.path).parent().unwrap().to_path_buf(),
                lib.root.join(&target).parent().unwrap().to_path_buf(),
            )
        } else {
            (lib.root.join(&e.path), lib.root.join(&target))
        };
        let (from_dir, to_dir) = (from.parent().unwrap(), to.parent().unwrap());
        fs::create_dir_all(to_dir).ctx("making the folder")?;
        if !k.json && from_dir != to_dir {
            move_sidecars(id, from_dir, to_dir)?;
        }
        rename_exclusive(&from, &to).ctx("renaming")?;
        sync_dir(to_dir).ctx("flushing")?;
        if from_dir != to_dir {
            sync_dir(from_dir).ctx("flushing")?;
        }
        // The index follows the file at once, so a crash before the rewrite finds it by ID.
        e.path = target;
        lib.index.set_path(id, &e.path)?;
    }
    let mut edits: Vec<(String, Option<FmValue>)> = vec![];
    if e.title != title {
        edits.push(("title".into(), Some(FmValue::Str(title.into()))));
    }
    if let Some(f) = k.folder_field {
        let want = sub.map(|x| Value::String(x.into()));
        if e.fields.get(f) != want.as_ref() {
            edits.push((f.into(), sub.map(|x| FmValue::Str(x.into()))));
        }
    }
    rewrite_fields(w, &e, &edits, renamed)
}

/// Moves a Markdown record's sidecars (`<id>.<suffix>` beside it) to another folder. A sidecar
/// already moved is skipped, so a redo finishes the move.
fn move_sidecars(id: Id, from: &Path, to: &Path) -> Result<()> {
    let prefix = format!("{id}.");
    for f in fs::read_dir(from).ctx("listing the folder")?.flatten() {
        let name = f.file_name().to_string_lossy().to_string();
        if !name.starts_with(&prefix) || name.ends_with(".md") || !f.path().is_file() || to.join(&name).exists() {
            continue;
        }
        rename_exclusive(&f.path(), &to.join(&name)).ctx("moving a sidecar")?;
    }
    sync_dir(to).ctx("flushing")
}

/// What permanently deleting a record removes: its own file first, then its sidecars (or the
/// rest of its folder), then the folders left empty, deepest first.
pub fn deletion_plan(lib: &Library, e: &Entry) -> (Vec<String>, Vec<String>) {
    let dir = Path::new(&e.path).parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
    let mut files = vec![e.path.clone()];
    let mut folders = vec![];
    if e.is_markdown() {
        let prefix = format!("{}.", e.id);
        let mut sidecars: Vec<String> = fs::read_dir(lib.root.join(&dir))
            .into_iter()
            .flatten()
            .flatten()
            .map(|f| f.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(&prefix) && !n.ends_with(".md"))
            .map(|n| format!("{dir}/{n}"))
            .collect();
        sidecars.sort();
        files.extend(sidecars);
    } else {
        let mut stack = vec![dir];
        while let Some(d) = stack.pop() {
            folders.push(d.clone());
            let mut list: Vec<_> = fs::read_dir(lib.root.join(&d)).into_iter().flatten().flatten().collect();
            list.sort_by_key(|f| f.file_name());
            for f in list {
                let p = format!("{d}/{}", f.file_name().to_string_lossy());
                if f.path().is_dir() {
                    stack.push(p);
                } else if p != e.path {
                    files.push(p);
                }
            }
        }
        folders.reverse();
    }
    (files, folders)
}

/// Permanently deletes a record that is still at `expected_version`, and forgets its history.
/// Only ever after the user's two-step confirmation (see `archive`).
pub fn delete_permanently(w: &Write, id: Id, expected_version: &str) -> Result<()> {
    let e = w.lib.index.get(id).ok_or_else(|| Error::not_found("That record can’t be found."))?;
    if e.hash != expected_version {
        return Err(Error::conflict("It changed since you confirmed; nothing was deleted."));
    }
    let (files, folders) = deletion_plan(w.lib, &e);
    let intent = Intent::Delete { record: id, files: files.clone(), folders: folders.clone() };
    with_intent(w, &intent, || apply_delete(w, id, &files, &folders))?;
    if let Err(err) = w.lib.history.forget(id) {
        log::warn!("the history of {id} wasn’t erased: {err}");
    }
    Ok(())
}

fn apply_delete(w: &Write, id: Id, files: &[String], folders: &[String]) -> Result<()> {
    let root = &w.lib.root;
    for f in files {
        match fs::remove_file(root.join(f)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e).ctx("deleting"),
            _ => {}
        }
        if let Some(dir) = root.join(f).parent() {
            let _ = sync_dir(dir);
        }
    }
    for d in folders {
        let _ = fs::remove_dir(root.join(d));
    }
    w.lib.index.remove(id)?;
    w.changed(id);
    Ok(())
}

/// Writes a deleted Markdown record back from a past version, with its own ID: where it was,
/// or by its canonical name in the same folder if that place is taken.
pub fn bring_back(w: &Write, id: Id, was_at: &str, bytes: &[u8]) -> Result<Entry> {
    let lib = w.lib;
    if lib.index.get(id).is_some() {
        return Err(Error::conflict("It is already in the library."));
    }
    let bad = was_at.split('/').any(|p| p.is_empty() || p == ".." || p.starts_with('.'));
    let k = folder_kind(was_at).filter(|k| !k.json && !bad && was_at.ends_with(".md"));
    let k = k.ok_or_else(|| Error::invalid("Only notes can be brought back."))?;
    let d = decode(was_at, bytes).ok_or_else(|| Error::invalid("That version can’t be read."))?;
    if d.id != Some(id) {
        return Err(Error::invalid("That version belongs to another record."));
    }
    let free = |rel: &str| !lib.root.join(rel).exists();
    let rel = if free(was_at) {
        was_at.to_string()
    } else {
        let alt = record_path(k, id, &slug_for(&d.title, &d.fields), subfolder_of(k, was_at).as_deref());
        if !free(&alt) {
            return Err(Error::conflict("Something else is where it was."));
        }
        alt
    };
    let path = lib.root.join(&rel);
    fs::create_dir_all(path.parent().unwrap()).ctx("making its folder")?;
    safe_write(&path, bytes, true).ctx("writing it back")?;
    commit(w, &rel, bytes)
}

// ---- three-way merge -------------------------------------------------------------------------

/// For each base line range a side changed: (start, end, replacement lines).
fn hunks<'a>(base: &[&'a str], side: &[&'a str]) -> Vec<(usize, usize, Vec<&'a str>)> {
    capture_diff_slices(Algorithm::Myers, base, side)
        .into_iter()
        .filter_map(|op| match op {
            DiffOp::Equal { .. } => None,
            DiffOp::Delete { old_index, old_len, .. } => Some((old_index, old_index + old_len, vec![])),
            DiffOp::Insert { old_index, new_index, new_len } => {
                Some((old_index, old_index, side[new_index..new_index + new_len].to_vec()))
            }
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                Some((old_index, old_index + old_len, side[new_index..new_index + new_len].to_vec()))
            }
        })
        .collect()
}

/// Merges `ours` and `theirs`, both edited from `base`, line by line. `None` when their edits
/// overlap (identical edits merge).
pub fn merge3(base: &str, ours: &str, theirs: &str) -> Option<String> {
    if ours == theirs || theirs == base {
        return Some(ours.to_string());
    }
    if ours == base {
        return Some(theirs.to_string());
    }
    let (b, o, t): (Vec<&str>, Vec<&str>, Vec<&str>) = (
        base.split_inclusive('\n').collect(),
        ours.split_inclusive('\n').collect(),
        theirs.split_inclusive('\n').collect(),
    );
    let (ho, ht) = (hunks(&b, &o), hunks(&b, &t));
    let mut out = String::new();
    let (mut i, mut j, mut pos) = (0, 0, 0);
    loop {
        let (hunk, take_o, take_t) = match (ho.get(i), ht.get(j)) {
            (None, None) => break,
            (Some(a), None) => (a, true, false),
            (None, Some(c)) => (c, false, true),
            (Some(a), Some(c)) => {
                let overlap = (a.0 < c.1.max(c.0 + 1) && c.0 < a.1.max(a.0 + 1)) || a.0 == c.0;
                match (overlap, a == c) {
                    (true, true) => (a, true, true),
                    (true, false) => return None,
                    _ if a.0 < c.0 => (a, true, false),
                    _ => (c, false, true),
                }
            }
        };
        let (start, end, repl) = hunk;
        if *start < pos {
            return None;
        }
        out.extend(b[pos..*start].iter().copied());
        out.extend(repl.iter().copied());
        pos = *end;
        i += take_o as usize;
        j += take_t as usize;
    }
    out.extend(b[pos..].iter().copied());
    Some(out)
}
