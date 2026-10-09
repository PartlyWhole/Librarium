//! The files a record has besides its own: a Markdown record's sidecars (`<id>.<suffix>`
//! beside it), and what lies inside an item's folder (the original, extracted text,
//! snapshots). They are always written before the record's own file, which is the commit point.
//!
//! New items and snapshots are staged in app data and moved in with one rename, so the
//! library never holds half of one.

use super::record::{decode, kind, record_path, slug_for, Entry};
use super::save::{self, commit};
use super::write::{rename_exclusive, safe_write, sync_dir};
use super::{Library, Write};
use crate::error::{Context, Error, Result};
use crate::util::new_id;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A path inside an item's folder that the app may write: relative, no dot-entries, and not
/// the record itself.
fn check_inner(rel: &str) -> Result<()> {
    if rel.split('/').any(|p| p.is_empty() || p == ".." || p.starts_with('.')) || rel == "record.json" {
        return Err(Error::invalid(format!("not a file of an item: {rel:?}")));
    }
    Ok(())
}

/// A sidecar's suffix: `.anchor.json`, `.region-2.png`, `.excalidraw`.
pub fn check_suffix(suffix: &str) -> Result<()> {
    let ok = suffix.starts_with('.') && suffix.len() > 1 && !suffix.contains(['/', '\\']) && !suffix.ends_with(".md");
    if !ok {
        return Err(Error::invalid(format!("not a sidecar name: {suffix:?}")));
    }
    Ok(())
}

/// Writes a sidecar beside a Markdown record. The record's file itself is unchanged.
pub fn write_sidecar(w: &Write, id: crate::util::Id, suffix: &str, bytes: &[u8]) -> Result<()> {
    check_suffix(suffix)?;
    let e = save::writable(w, id)?;
    let dir = e.dir(w.lib);
    safe_write(&dir.join(format!("{id}{suffix}")), bytes, false).ctx("writing a sidecar")
}

// ---- staging ---------------------------------------------------------------------------------

/// A new, empty staging folder in app data.
pub fn stage_dir(lib: &Library) -> Result<PathBuf> {
    let dir = lib.app_dir.join("staging").join(new_id().to_string());
    fs::create_dir_all(&dir).ctx("staging")?;
    Ok(dir)
}

/// Writes a file into a staging folder, durably.
pub fn stage_file(dir: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let p = dir.join(name);
    fs::create_dir_all(p.parent().unwrap_or(dir)).ctx("staging")?;
    safe_write(&p, bytes, true).ctx("staging")
}

/// Removes what an interrupted import left behind (in app data, or beside the library).
pub fn clear_staging(root: &Path, app_dir: &Path) {
    let _ = fs::remove_dir_all(app_dir.join("staging"));
    let _ = fs::remove_dir_all(root.join(".librarium/staging"));
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)?.flatten() {
        let (a, b) = (e.path(), to.join(e.file_name()));
        if a.is_dir() {
            copy_tree(&a, &b)?;
        } else {
            let mut f = fs::File::create(&b)?;
            io::copy(&mut fs::File::open(&a)?, &mut f)?;
            super::write::full_sync(&f)?;
        }
    }
    Ok(())
}

/// Moves a staged folder to `target` with one rename. When the library is on another volume,
/// the folder is first copied into `<library>/.librarium/staging/`, so the last step is still
/// one rename.
fn move_in(lib: &Library, stage: &Path, target: &Path) -> Result<()> {
    let parent = target.parent().ok_or_else(|| Error::invalid("no folder to move into"))?;
    fs::create_dir_all(parent).ctx("making the folder")?;
    match rename_exclusive(stage, target) {
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            let near = lib.root.join(".librarium/staging").join(new_id().to_string());
            copy_tree(stage, &near).ctx("staging beside the library")?;
            rename_exclusive(&near, target).ctx("moving into place")?;
            let _ = fs::remove_dir_all(stage);
        }
        r => r.ctx("moving into place")?,
    }
    sync_dir(parent).ctx("flushing")
}

/// Moves a staged item folder (holding its `record.json`) into `items/`, in the subfolder its
/// `library.folder` names, and indexes it.
pub fn import_item(w: &Write, stage: &Path) -> Result<Entry> {
    let bytes = fs::read(stage.join("record.json")).ctx("reading the staged record")?;
    let d = decode("items/staged/record.json", &bytes).ok_or_else(|| Error::invalid("not an item"))?;
    let id = d.id.ok_or_else(|| Error::invalid("the staged record has no ID"))?;
    if w.lib.index.get(id).is_some() {
        return Err(Error::conflict("That ID is taken."));
    }
    let k = kind("item").expect("items are a kind");
    let sub = d.fields.get("library.folder").and_then(|v| v.as_str());
    let rel = record_path(k, id, &slug_for(&d.title, &d.fields), sub);
    let target = w.lib.root.join(&rel);
    move_in(w.lib, stage, target.parent().expect("an item has a folder"))?;
    commit(w, &rel, &bytes)
}

/// Moves a staged folder into an item's folder at `rel_dir` (a new snapshot). Update the
/// item's `record.json` after.
pub fn move_into_item(w: &Write, e: &Entry, stage: &Path, rel_dir: &str) -> Result<()> {
    check_inner(rel_dir)?;
    save::writable(w, e.id)?;
    move_in(w.lib, stage, &e.dir(w.lib).join(rel_dir))
}

/// Writes a new file inside an item's folder (its extracted text), never replacing one. Update
/// `record.json` after.
pub fn write_item_file(w: &Write, e: &Entry, rel: &str, bytes: &[u8]) -> Result<()> {
    check_inner(rel)?;
    save::writable(w, e.id)?;
    let p = e.dir(w.lib).join(rel);
    fs::create_dir_all(p.parent().expect("inside the item")).ctx("making the folder")?;
    safe_write(&p, bytes, true).ctx("writing")
}

/// Removes a folder inside an item's folder for good (a snapshot the user chose to remove,
/// after `record.json` stopped listing it).
pub fn remove_item_dir(w: &Write, e: &Entry, rel_dir: &str) -> Result<()> {
    check_inner(rel_dir)?;
    let dir = e.dir(w.lib);
    match fs::remove_dir_all(dir.join(rel_dir)) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err).ctx("removing"),
        _ => sync_dir(&dir).ctx("flushing"),
    }
}
