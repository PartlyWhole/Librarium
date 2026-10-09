//! Operations on several files of one record, each under an intent so it finishes after a
//! crash: renaming and moving a record (with its sidecars), and deleting it permanently. A redo
//! goes ahead only while what the operation was based on still holds.

use super::frontmatter::FmValue;
use super::record::{decode, kind, record_path, slug_for, subfolder_of, Entry, Kind};
use super::save::{read_current, with_fields, writable, write_fields};
use super::write::{rename_exclusive, sync_dir, with_intent, Intent};
use super::{Library, Write};
use crate::error::{Context, Error, Result};
use crate::util::{clean_title, sha256, Id};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::Path;

/// Carries out an intent left by an operation that didn't finish, if what it was based on still
/// holds.
pub fn redo(w: &Write, intent: &Intent) -> Result<()> {
    let changed = &mut false;
    match intent {
        Intent::Relocate { record, from, title, subfolder } => {
            apply_relocate(w, *record, from, title, subfolder.as_deref(), changed).map(drop)
        }
        Intent::Identify { from, hash, id, copied_from } => {
            super::repair::apply_identify(w, from, hash, *id, *copied_from, changed).map(drop)
        }
        Intent::Delete { record, version, files, folders } => {
            apply_delete(w, *record, version, files, folders, changed)
        }
        Intent::MoveFolder { kind, from, to } => super::folders::apply_move(w, kind, from, to, changed).map(drop),
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
    if base_version.is_some_and(|v| v != sha256(&read_current(w.lib, &e).unwrap_or_default())) {
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
    let intent = Intent::Relocate { record: id, from: e.path.clone(), title: title.clone(), subfolder: sub.clone() };
    with_intent(&w.lib.app_dir, &intent, |changed| apply_relocate(w, id, &e.path, &title, sub.as_deref(), changed))
}

/// Renames the file (sidecars first), then rewrites the title and folder field. The new bytes
/// are worked out first, so a refused edit changes nothing; a failure after the rename puts the
/// file back. Only a record still at `from` (or already at its new place) is touched.
fn apply_relocate(w: &Write, id: Id, from: &str, title: &str, sub: Option<&str>, changed: &mut bool) -> Result<Entry> {
    let lib = w.lib;
    let mut e = lib.index.get(id).ok_or_else(|| Error::not_found("That record can’t be found."))?;
    let k = kind(&e.kind).ok_or_else(|| Error::read_only("unknown kind"))?;
    let cur = read_current(lib, &e)?;
    let d = decode(&e.path, &cur).ok_or_else(|| Error::invalid("that file can’t be read"))?;
    let mut fields = d.fields.clone();
    if let Some(f) = k.folder_field {
        match sub {
            Some(s) => fields.insert(f.into(), Value::String(s.into())),
            None => fields.remove(f),
        };
    }
    let target = record_path(k, id, &slug_for(title, &fields), sub);
    if e.path != from && e.path != target {
        return Err(Error::conflict(format!("“{}” moved since, so it was left where it is.", e.title)));
    }
    let mut edits: Vec<(String, Option<FmValue>)> = vec![];
    if d.title != title {
        edits.push(("title".into(), Some(FmValue::Str(title.into()))));
    }
    if let Some(f) = k.folder_field {
        let want = sub.map(|x| Value::String(x.into()));
        if d.fields.get(f) != want.as_ref() {
            edits.push((f.into(), sub.map(|x| FmValue::Str(x.into()))));
        }
    }
    let out = with_fields(&e.path, &cur, &edits)?;
    let was = e.path.clone();
    let renamed = target != e.path;
    if renamed {
        *changed = true;
        move_record(lib, k, id, &was, &target)?;
        e.path = target;
    }
    let written = write_fields(w, &e, &cur, &out, renamed);
    if written.is_err() && renamed && move_record(lib, k, id, &e.path, &was).is_ok() {
        *changed = false;
    }
    written
}

/// Moves a record's file (an item's folder; a Markdown record's sidecars first) from one path
/// to another. The index follows at once, so a crash before the rewrite finds it by ID.
fn move_record(lib: &Library, k: &Kind, id: Id, from_rel: &str, to_rel: &str) -> Result<()> {
    let (from, to) = (lib.root.join(from_rel), lib.root.join(to_rel));
    let (from, to) =
        if k.json { (from.parent().unwrap().to_path_buf(), to.parent().unwrap().to_path_buf()) } else { (from, to) };
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
    lib.index.set_path(id, to_rel)?;
    Ok(())
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
    let intent =
        Intent::Delete { record: id, version: expected_version.into(), files: files.clone(), folders: folders.clone() };
    with_intent(&w.lib.app_dir, &intent, |changed| apply_delete(w, id, expected_version, &files, &folders, changed))
}

/// Deletes the files, then the empty folders, then the history. Goes ahead only while the
/// record's own file is still at the version confirmed, or (finishing one cut short) is gone
/// and nothing else holds the record.
fn apply_delete(
    w: &Write,
    id: Id,
    version: &str,
    files: &[String],
    folders: &[String],
    changed: &mut bool,
) -> Result<()> {
    let root = &w.lib.root;
    let first = files.first().ok_or_else(|| Error::invalid("nothing to delete"))?;
    let still = match fs::read(root.join(first)) {
        Ok(b) => sha256(&b) == version,
        Err(_) => !root.join(first).exists() && w.lib.index.get(id).is_none_or(|e| e.path == *first),
    };
    if !still {
        return Err(Error::conflict("It changed since you confirmed; nothing was deleted."));
    }
    for f in files {
        match fs::remove_file(root.join(f)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e).ctx("deleting"),
            _ => *changed = true,
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
    w.lib.history.forget(id).map_err(|err| {
        Error::io(format!(
            "It was deleted, but its history wasn’t erased yet ({err}); that is retried at the next start."
        ))
    })
}
