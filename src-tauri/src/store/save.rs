//! Writing a record: creating it, saving its body (merging three ways when the file changed
//! since), setting its fields, and writing a deleted one back. Each write is checked against
//! the file as it is now, and a file that has gone is never re-created.

use super::frontmatter::{self, FmError, FmValue, Frontmatter};
use super::merge::merge3;
use super::record::{
    body, decode, entry_from, folder_kind, kind, new_frontmatter, newline_of, record_path, slug_for, stored_text,
    subfolder_of, Entry, RESERVED,
};
use super::write::{safe_write, writable as file_writable};
use super::{Library, Write};
use crate::error::{Context, Error, Result};
use crate::types::SaveResult;
use crate::util::{clean_title, iso_utc, json_bytes, now_ms, sha256, Id};
use serde_json::{json, Map, Value};
use std::fs;
use std::io;

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

/// The record, if the app may rewrite it. Its own file must still be there: nothing of a
/// record that has gone (its sidecars, its item folder) is ever written again.
pub(crate) fn writable(w: &Write, id: Id) -> Result<Entry> {
    let e = w.lib.index.get(id).ok_or_else(|| Error::not_found("That record can’t be found."))?;
    if let Some(why) = &e.read_only {
        return Err(Error::read_only(why.clone()));
    }
    let path = w.lib.root.join(&e.path);
    if !path.is_file() {
        return Err(gone(&e));
    }
    if !file_writable(&path) {
        return Err(Error::read_only(format!("“{}” is locked or read-only, so it can’t be saved.", e.title)));
    }
    Ok(e)
}

fn gone(e: &Entry) -> Error {
    Error::not_found(format!("“{}” can’t be found any more, so it wasn’t saved.", e.title))
}

/// A record's file as it is now.
pub(super) fn read_current(lib: &Library, e: &Entry) -> Result<Vec<u8>> {
    match fs::read(lib.root.join(&e.path)) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Err(gone(e)),
        r => r.ctx("reading"),
    }
}

/// Refuses bytes that are read-only as they are now (the index may not have seen them yet).
fn check_writable(rel: &str, bytes: &[u8]) -> Result<()> {
    match decode(rel, bytes).and_then(|d| d.read_only) {
        Some(why) => Err(Error::read_only(why)),
        None => Ok(()),
    }
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
    let cur = read_current(w.lib, &e)?;
    check_writable(&e.path, &cur)?;
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
    let cur = read_current(w.lib, &e)?;
    if base_version.is_some_and(|v| v != sha256(&cur)) {
        return Err(Error::conflict(format!("“{}” changed since, so this wasn’t done.", e.title)));
    }
    let out = with_fields(&e.path, &cur, edits)?;
    write_fields(w, &e, &cur, &out, false)
}

/// Rewrites fields of a record's frontmatter (or `record.json`), then commits it.
pub(crate) fn rewrite_fields(
    w: &Write,
    e: &Entry,
    edits: &[(String, Option<FmValue>)],
    renamed: bool,
) -> Result<Entry> {
    let cur = read_current(w.lib, e)?;
    let out = with_fields(&e.path, &cur, edits)?;
    write_fields(w, e, &cur, &out, renamed)
}

/// A record file's bytes with fields set (or with `None` removed). Nothing changes when there
/// are no edits, so a block closed by `...` is left as it is.
pub(super) fn with_fields(rel: &str, cur: &[u8], edits: &[(String, Option<FmValue>)]) -> Result<Vec<u8>> {
    check_writable(rel, cur)?;
    if edits.is_empty() {
        return Ok(cur.to_vec());
    }
    Ok(if rel.ends_with(".md") {
        let text = String::from_utf8_lossy(cur).into_owned();
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
        let mut obj: Map<String, Value> = serde_json::from_slice(cur).map_err(|e| Error::read_only(e.to_string()))?;
        for (k, v) in edits {
            match v {
                Some(v) => obj.insert(k.clone(), v.to_json()),
                None => obj.remove(k),
            };
        }
        json_bytes(&Value::Object(obj), true)
    })
}

/// Writes a record's new bytes (unless they are the same) and commits them.
pub(super) fn write_fields(w: &Write, e: &Entry, cur: &[u8], out: &[u8], renamed: bool) -> Result<Entry> {
    if out == cur && !renamed {
        return Ok(e.clone());
    }
    if out != cur {
        safe_write(&w.lib.root.join(&e.path), out, false).ctx("saving")?;
    }
    commit(w, &e.path, out)
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
