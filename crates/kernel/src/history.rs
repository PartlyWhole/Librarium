//! Version history (decision 0038): past versions of Markdown records (notes, daily notes,
//! captures), kept with the user's files in `.librarium/history/`, so they travel with the
//! library and survive renames (keyed by ID).
//!
//! - `objects/<2 hex>/<sha256>`: a version's bytes, exactly as the file was. Written once and
//!   never changed (safe with iCloud).
//! - `log/<device>.jsonl`: one line per version, written only by this Mac; other Macs' logs
//!   are read, never written. `{"forget": id, "ms"}` lines hide a record's versions everywhere
//!   (permanent deletion).
//!
//! Versions are taken after the app writes a record (at most once per [`SPACING_MS`] per
//! record; the latest text is taken later by [`History::tick`]), whenever a record changes
//! outside the app, and around a restore. The same bytes are never taken twice in a row.
//! Retention keeps everything for a day, then one per hour for a week, per day for 90 days and
//! per week after that; the newest version of a record is always kept.
//!
//! History never makes a write fail: its own errors are logged and skipped.

use crate::hash::version_of as sha256_hex;
use librarium_contracts::ports::FileSystem;
use librarium_contracts::{BackendError, Id, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Where history lives, inside the library.
pub const DIR: &str = ".librarium/history";
/// At most one version per record this often while it is being written in the app.
pub const SPACING_MS: i64 = 5 * 60 * 1000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

/// Why a version was taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    /// Written in the app.
    App,
    /// Changed outside the app (another editor, sync).
    Outside,
    /// The text just before a restore (so a restore can be undone).
    BeforeRestore,
    /// The text a restore put back.
    Restore,
}

/// One past version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Version {
    pub id: Id,
    pub kind: String,
    /// Where the record was then (store-relative).
    pub path: String,
    pub title: String,
    /// sha256 of the bytes.
    pub hash: String,
    pub ms: i64,
    pub origin: Origin,
    pub size: u64,
    /// The Mac that took it.
    #[serde(default)]
    pub device: String,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum Line {
    Forget { forget: Id, ms: i64 },
    Version(Version),
}

#[derive(Default)]
struct Index {
    /// Versions by record, oldest first.
    by_id: HashMap<Id, Vec<Version>>,
    /// The log files as last read: name → (size, mtime).
    seen: BTreeMap<String, (u64, i64)>,
}

/// What to keep, given versions of one record (oldest first) and the time now.
pub fn retained(versions: &[Version], now: i64) -> Vec<bool> {
    let mut keep = vec![false; versions.len()];
    // The last version in each bucket survives; buckets grow with age.
    let mut last_in_bucket: HashMap<(u8, i64), usize> = HashMap::new();
    for (i, v) in versions.iter().enumerate() {
        let age = now - v.ms;
        let bucket = if age < DAY {
            keep[i] = true;
            continue;
        } else if age < 7 * DAY {
            (1, v.ms.div_euclid(HOUR))
        } else if age < 90 * DAY {
            (2, v.ms.div_euclid(DAY))
        } else {
            (3, v.ms.div_euclid(7 * DAY))
        };
        last_in_bucket.insert(bucket, i);
    }
    for i in last_in_bucket.into_values() {
        keep[i] = true;
    }
    if let Some(k) = keep.last_mut() {
        *k = true;
    }
    keep
}

pub struct History {
    fs: Arc<dyn FileSystem>,
    dir: PathBuf,
    device: String,
    index: Mutex<Index>,
    /// Records written in the app since their last version (taken at the next tick).
    pending: Mutex<HashSet<Id>>,
    /// Why the next write of a record happens, when it isn't a plain edit (a restore).
    next: Mutex<HashMap<Id, Origin>>,
    last_prune_ms: Mutex<i64>,
}

fn io_err(e: io::Error, what: &str) -> BackendError {
    BackendError::io(format!("{what}: {e}"))
}

impl History {
    /// `root` is the library; `device` names this Mac (kept in Application Support).
    pub fn new(fs: Arc<dyn FileSystem>, root: &Path, device: String) -> Self {
        History {
            fs,
            dir: root.join(DIR),
            device,
            index: Mutex::new(Index::default()),
            pending: Mutex::new(HashSet::new()),
            next: Mutex::new(HashMap::new()),
            last_prune_ms: Mutex::new(i64::MIN),
        }
    }

    fn log_dir(&self) -> PathBuf {
        self.dir.join("log")
    }

    fn own_log(&self) -> PathBuf {
        self.log_dir().join(format!("{}.jsonl", self.device))
    }

    fn object(&self, hash: &str) -> PathBuf {
        self.dir.join("objects").join(&hash[..2.min(hash.len())]).join(hash)
    }

    /// Re-reads the logs if any changed (another Mac's, through sync), or on first use.
    fn refresh(&self) {
        let mut idx = self.index.lock().unwrap();
        let mut now = BTreeMap::new();
        for e in self.fs.list(&self.log_dir()).unwrap_or_default() {
            if e.is_dir || !e.name.ends_with(".jsonl") {
                continue;
            }
            if let Ok(Some(m)) = self.fs.stat(&self.log_dir().join(&e.name)) {
                now.insert(e.name.clone(), (m.len, m.mtime_ns));
            }
        }
        if now == idx.seen && !idx.seen.is_empty() {
            return;
        }
        let mut by_id: HashMap<Id, Vec<Version>> = HashMap::new();
        let mut forgets: HashMap<Id, i64> = HashMap::new();
        for name in now.keys() {
            let Ok(bytes) = self.fs.read(&self.log_dir().join(name)) else { continue };
            for line in String::from_utf8_lossy(&bytes).lines() {
                match serde_json::from_str::<Line>(line) {
                    Ok(Line::Version(v)) => by_id.entry(v.id).or_default().push(v),
                    Ok(Line::Forget { forget, ms }) => {
                        let e = forgets.entry(forget).or_insert(ms);
                        *e = (*e).max(ms);
                    }
                    Err(_) => {} // a line being synced, or damaged: skipped
                }
            }
        }
        for (id, ms) in forgets {
            if let Some(vs) = by_id.get_mut(&id) {
                vs.retain(|v| v.ms > ms);
            }
        }
        by_id.retain(|_, vs| !vs.is_empty());
        for vs in by_id.values_mut() {
            // By time; within one moment, as written (a stable sort). Only exact repeats go.
            vs.sort_by_key(|v| v.ms);
            vs.dedup();
        }
        *idx = Index { by_id, seen: now };
    }

    /// Says why the record's next write happens (a restore), for the version it makes.
    pub fn expect(&self, id: Id, origin: Origin) {
        self.next.lock().unwrap().insert(id, origin);
    }

    /// Why this write happened: what [`History::expect`] said, or an edit in the app.
    pub fn next_origin(&self, id: Id) -> Origin {
        self.next.lock().unwrap().remove(&id).unwrap_or(Origin::App)
    }

    /// Past versions of a record, newest first.
    pub fn versions(&self, id: Id) -> Vec<Version> {
        self.refresh();
        let idx = self.index.lock().unwrap();
        let mut v = idx.by_id.get(&id).cloned().unwrap_or_default();
        v.reverse();
        v
    }

    /// Records that have history, with their newest version.
    pub fn records(&self) -> Vec<Version> {
        self.refresh();
        let idx = self.index.lock().unwrap();
        idx.by_id.values().filter_map(|vs| vs.last().cloned()).collect()
    }

    /// A version's bytes.
    pub fn read(&self, hash: &str) -> Result<Vec<u8>> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(BackendError::invalid("not a version"));
        }
        self.fs.read(&self.object(hash)).map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                BackendError::not_found("That version isn’t on this Mac (it may still be syncing).")
            } else {
                io_err(e, "reading the version")
            }
        })
    }

    /// Takes a version of a record's bytes. Without `force`, an app write is taken at most once
    /// per [`SPACING_MS`] (otherwise the record waits for [`History::tick`]). Returns whether a
    /// version was taken.
    #[allow(clippy::too_many_arguments)]
    pub fn take(&self, id: Id, kind: &str, path: &str, title: &str, bytes: &[u8], origin: Origin, now: i64) -> bool {
        let force = origin != Origin::App;
        match self.try_take(id, kind, path, title, bytes, origin, now, force) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("librarium: history: a version of {path} wasn't kept: {e}");
                false
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn try_take(
        &self,
        id: Id,
        kind: &str,
        path: &str,
        title: &str,
        bytes: &[u8],
        origin: Origin,
        now: i64,
        force: bool,
    ) -> Result<bool> {
        self.refresh();
        let hash = sha256_hex(bytes);
        {
            let idx = self.index.lock().unwrap();
            if let Some(last) = idx.by_id.get(&id).and_then(|v| v.last()) {
                if last.hash == hash {
                    self.pending.lock().unwrap().remove(&id);
                    return Ok(false);
                }
                if !force && now - last.ms < SPACING_MS {
                    self.pending.lock().unwrap().insert(id);
                    return Ok(false);
                }
            }
        }
        // The bytes first: a crash then leaves an unreferenced object, removed by pruning.
        let obj = self.object(&hash);
        if self.fs.stat(&obj).map_err(|e| io_err(e, "history"))?.is_none() {
            self.fs.create_dir_all(obj.parent().unwrap()).map_err(|e| io_err(e, "history folder"))?;
            write_file(&*self.fs, &obj, bytes)?;
        }
        let v = Version {
            id,
            kind: kind.into(),
            path: path.into(),
            title: title.into(),
            hash,
            ms: now,
            origin,
            size: bytes.len() as u64,
            device: self.device.clone(),
        };
        self.append(&[Line::Version(v.clone())])?;
        self.ensure_readme();
        let mut idx = self.index.lock().unwrap();
        idx.by_id.entry(id).or_default().push(v);
        self.pending.lock().unwrap().remove(&id);
        Ok(true)
    }

    /// Records written since their last version, whose spacing has passed: their files' bytes
    /// are taken now. `read` gives a record's (kind, path, title, bytes) if it still exists.
    pub fn tick(&self, now: i64, read: impl Fn(Id) -> Option<(String, String, String, Vec<u8>)>) {
        let due: Vec<Id> = {
            let idx = self.index.lock().unwrap();
            let pending = self.pending.lock().unwrap();
            pending
                .iter()
                .filter(|id| idx.by_id.get(id).and_then(|v| v.last()).is_none_or(|l| now - l.ms >= SPACING_MS))
                .copied()
                .collect()
        };
        for id in due {
            match read(id) {
                Some((kind, path, title, bytes)) => {
                    let _ = self.try_take(id, &kind, &path, &title, &bytes, Origin::App, now, true);
                }
                None => {
                    self.pending.lock().unwrap().remove(&id);
                }
            }
        }
        // Pruning, at most once a day.
        let mut last = self.last_prune_ms.lock().unwrap();
        if now.saturating_sub(*last) >= DAY {
            *last = now;
            drop(last);
            if let Err(e) = self.prune(now) {
                eprintln!("librarium: history: pruning failed: {e}");
            }
        }
    }

    /// Applies retention to this Mac's log, then removes objects no log refers to.
    pub fn prune(&self, now: i64) -> Result<()> {
        let own = self.read_own()?;
        let mut by_id: BTreeMap<Id, Vec<usize>> = BTreeMap::new();
        let versions: Vec<Option<Version>> = own
            .iter()
            .map(|l| match l {
                Line::Version(v) => Some(v.clone()),
                Line::Forget { .. } => None,
            })
            .collect();
        for (i, v) in versions.iter().enumerate() {
            if let Some(v) = v {
                by_id.entry(v.id).or_default().push(i);
            }
        }
        let mut drop_line = vec![false; own.len()];
        for idxs in by_id.values() {
            let vs: Vec<Version> = idxs.iter().map(|&i| versions[i].clone().unwrap()).collect();
            for (k, keep) in retained(&vs, now).into_iter().enumerate() {
                if !keep {
                    drop_line[idxs[k]] = true;
                }
            }
        }
        if drop_line.iter().any(|d| *d) {
            let kept: Vec<Line> = own.into_iter().zip(drop_line).filter(|(_, d)| !d).map(|(l, _)| l).collect();
            self.write_own(&kept)?;
        }
        self.collect_objects()
    }

    /// Erases a record's history (permanent deletion): its lines leave this Mac's log, a
    /// `forget` line hides it in other Macs' logs, and its objects go once nothing refers to
    /// them.
    pub fn forget(&self, id: Id, now: i64) -> Result<()> {
        let mut own = self.read_own()?;
        own.retain(|l| !matches!(l, Line::Version(v) if v.id == id));
        own.push(Line::Forget { forget: id, ms: now });
        self.write_own(&own)?;
        self.pending.lock().unwrap().remove(&id);
        self.index.lock().unwrap().seen.clear();
        self.collect_objects()
    }

    /// Removes objects that no log line (of any Mac, not forgotten) refers to.
    fn collect_objects(&self) -> Result<()> {
        self.index.lock().unwrap().seen.clear();
        self.refresh();
        let used: HashSet<String> = {
            let idx = self.index.lock().unwrap();
            idx.by_id.values().flatten().map(|v| v.hash.clone()).collect()
        };
        let objects = self.dir.join("objects");
        for d in self.fs.list(&objects).unwrap_or_default() {
            if !d.is_dir {
                continue;
            }
            let sub = objects.join(&d.name);
            for f in self.fs.list(&sub).unwrap_or_default() {
                if !f.is_dir && !used.contains(&f.name) && f.name.len() == 64 {
                    let _ = self.fs.remove_file(&sub.join(&f.name));
                }
            }
        }
        Ok(())
    }

    fn read_own(&self) -> Result<Vec<Line>> {
        match self.fs.read(&self.own_log()) {
            Ok(b) => Ok(String::from_utf8_lossy(&b).lines().filter_map(|l| serde_json::from_str(l).ok()).collect()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(io_err(e, "reading the history log")),
        }
    }

    fn write_own(&self, lines: &[Line]) -> Result<()> {
        self.fs.create_dir_all(&self.log_dir()).map_err(|e| io_err(e, "history folder"))?;
        let mut out = String::new();
        for l in lines {
            out.push_str(&serde_json::to_string(l).unwrap());
            out.push('\n');
        }
        write_file(&*self.fs, &self.own_log(), out.as_bytes())
    }

    fn append(&self, lines: &[Line]) -> Result<()> {
        let mut own = self.read_own()?;
        for l in lines {
            own.push(match l {
                Line::Version(v) => Line::Version(v.clone()),
                Line::Forget { forget, ms } => Line::Forget { forget: *forget, ms: *ms },
            });
        }
        self.write_own(&own)
    }

    fn ensure_readme(&self) {
        let p = self.dir.join("README.txt");
        if matches!(self.fs.stat(&p), Ok(Some(_))) {
            return;
        }
        let _ = write_file(
            &*self.fs,
            &p,
            b"Librarium's version history of your notes.\n\n\
log/<mac>.jsonl lists versions, one JSON line each: the note's id, where it was (path), its\n\
title, when (ms since 1970), why (app, outside, before-restore, restore) and the sha256 of its\n\
text. objects/<first 2 of the sha256>/<sha256> is that text, exactly as the file was: open it\n\
in any text editor. Each Mac writes only its own log. Deleting a note permanently in\n\
Librarium erases its versions.\n",
        );
    }
}

/// Two texts compared line by line: (`equal` | `delete` | `insert`, the line).
pub fn line_diff(old: &str, new: &str) -> Vec<(&'static str, String)> {
    similar::TextDiff::from_lines(old, new)
        .iter_all_changes()
        .map(|c| {
            let op = match c.tag() {
                similar::ChangeTag::Equal => "equal",
                similar::ChangeTag::Delete => "delete",
                similar::ChangeTag::Insert => "insert",
            };
            (op, c.value().trim_end_matches(['\n', '\r']).to_string())
        })
        .collect()
}

/// Writes a whole file safely: a temporary file, flushed, then renamed over the old one.
fn write_file(fs: &dyn FileSystem, path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_file_name(format!(
        ".{}.librarium-tmp-{}",
        path.file_name().unwrap().to_string_lossy(),
        std::process::id()
    ));
    let _ = fs.remove_file(&tmp);
    fs.write_new(&tmp, bytes).map_err(|e| io_err(e, "history"))?;
    fs.flush_file(&tmp, librarium_contracts::ports::Flush::Data).map_err(|e| io_err(e, "history"))?;
    fs.rename(&tmp, path).map_err(|e| io_err(e, "history"))?;
    Ok(())
}
