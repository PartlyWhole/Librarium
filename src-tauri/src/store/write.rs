//! Safe writes, and intents for operations that touch several files.
//!
//! A safe write puts the bytes in `.<name>.librarium-tmp-<pid>-<n>` beside the target, flushes
//! it to the disk (`F_FULLFSYNC`), renames it over the target (exclusively for a new file, so
//! nothing is ever overwritten by surprise), then flushes the folder. A crash leaves either the
//! old file or the new one, plus at most a temp file that the next start removes.

use crate::error::{Context, Result};
use crate::util::{json_bytes, new_id, Id};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Marks our temporary files.
pub const TMP_MARK: &str = ".librarium-tmp-";

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn is_temp(name: &str) -> bool {
    name.starts_with('.') && name.contains(TMP_MARK)
}

/// Flushes a file or folder all the way to the disk. File systems without `F_FULLFSYNC`
/// (network, FAT) get a plain `fsync`.
pub fn full_sync(f: &File) -> io::Result<()> {
    // SAFETY: `f` is an open descriptor for the duration of both calls.
    if unsafe { libc::fcntl(f.as_raw_fd(), libc::F_FULLFSYNC) } == 0 || unsafe { libc::fsync(f.as_raw_fd()) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn sync_dir(dir: &Path) -> io::Result<()> {
    full_sync(&File::open(dir)?)
}

/// Renames, failing if the target exists.
pub fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    let c = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(|_| io::ErrorKind::InvalidInput);
    let (a, b) = (c(from)?, c(to)?);
    // SAFETY: two valid NUL-terminated paths.
    if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Writes a file safely. With `create_new`, refuses to replace an existing file.
pub fn safe_write(target: &Path, bytes: &[u8], create_new: bool) -> io::Result<()> {
    let dir = target.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let name = target.file_name().ok_or(io::ErrorKind::InvalidInput)?.to_string_lossy();
    let n = TMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let tmp = dir.join(format!(".{name}{TMP_MARK}{}-{n}", std::process::id()));
    let written = (|| {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        full_sync(&f)?;
        if create_new {
            rename_exclusive(&tmp, target)
        } else {
            fs::rename(&tmp, target)
        }
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written?;
    sync_dir(dir)
}

/// Writes JSON as the app does (sorted keys, 2-space indent).
pub fn write_json(target: &Path, v: &Value, trailing_newline: bool) -> io::Result<()> {
    safe_write(target, &json_bytes(v, trailing_newline), false)
}

/// Whether the user lets this file be replaced: write permission, and not locked in Finder.
pub fn writable(path: &Path) -> bool {
    use std::os::macos::fs::MetadataExt as _;
    fs::metadata(path)
        .map(|m| m.mode() & 0o200 != 0 && m.st_flags() & (libc::UF_IMMUTABLE | libc::SF_IMMUTABLE) == 0)
        .unwrap_or(true)
}

/// A multi-file operation, written before it starts and redone at the next start if it didn't
/// finish. Each is idempotent: redoing a finished one changes nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Intent {
    /// Make the record's file name and fields match a title and subfolder.
    Relocate { record: Id, title: String, subfolder: Option<String> },
    /// Rename `from` to the canonical name for `id` and write the ID in.
    Identify { from: String, id: Id, copied_from: Option<Id> },
    /// Delete a record: its own file first, then these files, then these folders.
    Delete { record: Id, files: Vec<String>, folders: Vec<String> },
    /// Move a folder, then make the records inside follow.
    MoveFolder { kind: String, from: String, to: String },
}

/// Writes an intent into `<app data>/intents/`; remove the file when the operation is done.
pub fn write_intent(app_dir: &Path, intent: &Intent) -> Result<PathBuf> {
    let dir = app_dir.join("intents");
    fs::create_dir_all(&dir).ctx("making the intents folder")?;
    let p = dir.join(format!("{}.json", new_id()));
    let v = serde_json::to_value(intent)?;
    safe_write(&p, &json_bytes(&v, false), true).ctx("writing an intent")?;
    Ok(p)
}

/// Intents left by an operation that didn't finish, oldest first (unreadable ones as `None`).
pub fn pending_intents(app_dir: &Path) -> Vec<(PathBuf, Option<Intent>)> {
    let Ok(list) = fs::read_dir(app_dir.join("intents")) else { return vec![] };
    let mut out: Vec<(PathBuf, Option<Intent>)> = list
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|x| x == "json") && !p.file_name().unwrap().to_string_lossy().starts_with('.')
        })
        .map(|p| {
            let intent = fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok());
            (p, intent)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}
