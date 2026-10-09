//! Version history of Markdown records, kept in the library (`.librarium/history/`) so it
//! travels with it, keyed by ID so it survives renames.
//!
//! - `objects/<2 hex>/<sha256>`: a version's exact bytes, written once.
//! - `log/<device>.jsonl`: one line per version, written only by this Mac and read from all;
//!   `{"forget": id, "ms"}` hides a record's versions everywhere (permanent deletion).
//!
//! A version is taken when the app writes a record (at most every 5 minutes; the latest text
//! is taken later by the ticker), whenever a record changes outside, and around a restore. The
//! same bytes are never taken twice in a row. History never makes a write fail.

use crate::error::{Context, Error, Result};
use crate::store::record::{self, Entry};
use crate::store::write::safe_write;
use crate::store::{save, Library};
use crate::types::{DeletedNote, DiffLine, HistoryVersion, SaveResult, Written};
use crate::util::{new_id, now_ms, sha256, Id};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// At most one version per record this often while it is written in the app.
pub const SPACING_MS: i64 = 5 * 60 * 1000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

const README: &str = "Librarium's version history of your notes.

log/<mac>.jsonl lists versions, one JSON line each: the note's id, where it was (path), its
title, when (ms since 1970), why (app, outside, before-restore, restore) and the sha256 of its
text. objects/<first 2 of the sha256>/<sha256> is that text, exactly as the file was: open it
in any text editor. Each Mac writes only its own log. Deleting a note permanently in
Librarium erases its versions.
";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    App,
    Outside,
    BeforeRestore,
    Restore,
}

/// One past version; its fields are written in this order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Version {
    pub id: Id,
    pub kind: String,
    pub path: String,
    pub title: String,
    pub hash: String,
    pub ms: i64,
    pub origin: Origin,
    pub size: u64,
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
struct Known {
    /// Versions by record, oldest first.
    by_id: HashMap<Id, Vec<Version>>,
    /// The logs as last read: name → (size, mtime).
    seen: BTreeMap<String, (u64, i64)>,
}

pub struct History {
    dir: PathBuf,
    device: String,
    known: Mutex<Known>,
    /// Records written in the app since their last version, taken at a later tick.
    pending: Mutex<HashSet<Id>>,
    /// Why a record's next write happens, when it isn't an edit (a restore).
    next: Mutex<HashMap<Id, Origin>>,
    last_prune_ms: Mutex<i64>,
    /// Held while this Mac's log is read and rewritten, or objects are written or collected:
    /// the ticker takes versions outside the library's write lock.
    log: Mutex<()>,
}

/// This Mac's name in the history: a random ID kept in `device.json` in app data.
fn device_id(app_dir: &Path) -> String {
    let p = app_dir.join("device.json");
    let known = fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if let Some(d) = known.as_ref().and_then(|v| v["device"].as_str()) {
        return d.to_string();
    }
    let d = new_id().to_string();
    let _ = fs::create_dir_all(app_dir);
    let _ = safe_write(&p, json!({ "device": d }).to_string().as_bytes(), false);
    d
}

/// Which versions of one record (oldest first) to keep: everything for a day, then the last
/// per hour for a week, per day for 90 days, per week after that, and always the newest.
pub fn retained(versions: &[Version], now: i64) -> Vec<bool> {
    let mut keep = vec![false; versions.len()];
    let mut last_in_bucket: HashMap<(u8, i64), usize> = HashMap::new();
    for (i, v) in versions.iter().enumerate() {
        let age = now - v.ms;
        let bucket = match age {
            a if a < DAY => {
                keep[i] = true;
                continue;
            }
            a if a < 7 * DAY => (1, v.ms.div_euclid(HOUR)),
            a if a < 90 * DAY => (2, v.ms.div_euclid(DAY)),
            _ => (3, v.ms.div_euclid(7 * DAY)),
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

impl History {
    pub fn new(root: &Path, app_dir: &Path) -> History {
        History {
            dir: root.join(".librarium/history"),
            device: device_id(app_dir),
            known: Mutex::default(),
            pending: Mutex::default(),
            next: Mutex::default(),
            last_prune_ms: Mutex::new(i64::MIN),
            log: Mutex::new(()),
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

    /// Re-reads the logs when any changed (another Mac's, through sync).
    fn refresh(&self) {
        let mut known = self.known.lock().unwrap();
        let mut now = BTreeMap::new();
        for e in fs::read_dir(self.log_dir()).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let (true, Ok(m)) = (name.ends_with(".jsonl"), e.metadata()) {
                use std::os::unix::fs::MetadataExt;
                now.insert(name, (m.len(), m.mtime_nsec() + m.mtime() * 1_000_000_000));
            }
        }
        if now == known.seen && !known.seen.is_empty() {
            return;
        }
        let mut by_id: HashMap<Id, Vec<Version>> = HashMap::new();
        let mut forgets: HashMap<Id, i64> = HashMap::new();
        for name in now.keys() {
            let Ok(bytes) = fs::read(self.log_dir().join(name)) else { continue };
            for line in String::from_utf8_lossy(&bytes).lines() {
                // A line still syncing, or damaged, is skipped.
                match serde_json::from_str::<Line>(line) {
                    Ok(Line::Version(v)) => by_id.entry(v.id).or_default().push(v),
                    Ok(Line::Forget { forget, ms }) => {
                        let e = forgets.entry(forget).or_insert(ms);
                        *e = (*e).max(ms);
                    }
                    Err(_) => {}
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
            vs.sort_by_key(|v| v.ms);
            vs.dedup();
        }
        *known = Known { by_id, seen: now };
    }

    /// Says why the record's next write happens (a restore).
    pub fn expect(&self, id: Id, origin: Origin) {
        self.next.lock().unwrap().insert(id, origin);
    }

    /// Why this write happened: what `expect` said, or an edit in the app.
    pub fn next_origin(&self, id: Id) -> Origin {
        self.next.lock().unwrap().remove(&id).unwrap_or(Origin::App)
    }

    /// A record's past versions, newest first.
    pub fn versions(&self, id: Id) -> Vec<Version> {
        self.refresh();
        let mut v = self.known.lock().unwrap().by_id.get(&id).cloned().unwrap_or_default();
        v.reverse();
        v
    }

    /// The newest version of every record with history.
    pub fn records(&self) -> Vec<Version> {
        self.refresh();
        self.known.lock().unwrap().by_id.values().filter_map(|vs| vs.last().cloned()).collect()
    }

    pub fn read(&self, hash: &str) -> Result<Vec<u8>> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::invalid("That isn’t a version."));
        }
        fs::read(self.object(hash)).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => Error::not_found("That version isn’t on this Mac (it may still be syncing)."),
            _ => Error::io(format!("reading the version: {e}")),
        })
    }

    /// Takes a version of a record's bytes. An edit in the app is taken at most every
    /// [`SPACING_MS`]; until then the record waits for the ticker.
    pub fn take(&self, e: &Entry, bytes: &[u8], origin: Origin) {
        if let Err(err) = self.try_take(e, bytes, origin, origin != Origin::App) {
            log::warn!("a version of {} wasn’t kept: {err}", e.path);
        }
    }

    fn try_take(&self, e: &Entry, bytes: &[u8], origin: Origin, force: bool) -> Result<()> {
        let _log = self.log.lock().unwrap_or_else(|p| p.into_inner());
        self.refresh();
        let hash = sha256(bytes);
        let now = now_ms();
        if let Some(last) = self.known.lock().unwrap().by_id.get(&e.id).and_then(|v| v.last()) {
            if last.hash == hash {
                self.pending.lock().unwrap().remove(&e.id);
                return Ok(());
            }
            if !force && now - last.ms < SPACING_MS {
                self.pending.lock().unwrap().insert(e.id);
                return Ok(());
            }
        }
        // The bytes first: a crash then leaves only an unreferenced object, pruned later.
        let obj = self.object(&hash);
        if !obj.exists() {
            fs::create_dir_all(obj.parent().unwrap()).ctx("making the history folder")?;
            safe_write(&obj, bytes, false).ctx("keeping a version")?;
        }
        let v = Version {
            id: e.id,
            kind: e.kind.clone(),
            path: e.path.clone(),
            title: e.title.clone(),
            hash,
            ms: now,
            origin,
            size: bytes.len() as u64,
            device: self.device.clone(),
        };
        let mut own = self.read_own()?;
        own.push(Line::Version(v.clone()));
        self.write_own(&own)?;
        if !self.dir.join("README.txt").exists() {
            let _ = safe_write(&self.dir.join("README.txt"), README.as_bytes(), true);
        }
        self.known.lock().unwrap().by_id.entry(e.id).or_default().push(v);
        self.pending.lock().unwrap().remove(&e.id);
        Ok(())
    }

    /// Applies retention to this Mac's log, then removes objects no log refers to.
    fn prune(&self, now: i64) -> Result<()> {
        let _log = self.log.lock().unwrap_or_else(|p| p.into_inner());
        let own = self.read_own()?;
        let mut by_id: BTreeMap<Id, Vec<usize>> = BTreeMap::new();
        for (i, l) in own.iter().enumerate() {
            if let Line::Version(v) = l {
                by_id.entry(v.id).or_default().push(i);
            }
        }
        let mut drop_line = vec![false; own.len()];
        for idxs in by_id.values() {
            let vs: Vec<Version> = idxs
                .iter()
                .filter_map(|&i| if let Line::Version(v) = &own[i] { Some(v.clone()) } else { None })
                .collect();
            for (k, keep) in retained(&vs, now).into_iter().enumerate() {
                drop_line[idxs[k]] = !keep;
            }
        }
        if drop_line.iter().any(|d| *d) {
            let kept: Vec<Line> = own.into_iter().zip(drop_line).filter(|(_, d)| !d).map(|(l, _)| l).collect();
            self.write_own(&kept)?;
        }
        self.collect_objects();
        Ok(())
    }

    /// Erases a record's history (permanent deletion): its lines leave this Mac's log, and a
    /// `forget` line hides it in other Macs' logs.
    pub fn forget(&self, id: Id) -> Result<()> {
        let _log = self.log.lock().unwrap_or_else(|p| p.into_inner());
        let mut own = self.read_own()?;
        own.retain(|l| !matches!(l, Line::Version(v) if v.id == id));
        own.push(Line::Forget { forget: id, ms: now_ms() });
        self.write_own(&own)?;
        self.pending.lock().unwrap().remove(&id);
        self.collect_objects();
        Ok(())
    }

    /// Removes objects no log line (of any Mac, not forgotten) refers to.
    fn collect_objects(&self) {
        self.known.lock().unwrap().seen.clear();
        self.refresh();
        let used: HashSet<String> =
            self.known.lock().unwrap().by_id.values().flatten().map(|v| v.hash.clone()).collect();
        for d in fs::read_dir(self.dir.join("objects")).into_iter().flatten().flatten() {
            for f in fs::read_dir(d.path()).into_iter().flatten().flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if name.len() == 64 && !used.contains(&name) {
                    let _ = fs::remove_file(f.path());
                }
            }
        }
    }

    fn read_own(&self) -> Result<Vec<Line>> {
        match fs::read(self.own_log()) {
            Ok(b) => Ok(String::from_utf8_lossy(&b).lines().filter_map(|l| serde_json::from_str(l).ok()).collect()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e).ctx("reading the history log"),
        }
    }

    fn write_own(&self, lines: &[Line]) -> Result<()> {
        fs::create_dir_all(self.log_dir()).ctx("making the history folder")?;
        let mut out = String::new();
        for l in lines {
            out.push_str(&serde_json::to_string(l)?);
            out.push('\n');
        }
        safe_write(&self.own_log(), out.as_bytes(), false).ctx("writing the history log")
    }
}

/// Once a second: takes the latest text of records written since their last version, once
/// their spacing has passed; prunes once a day.
pub fn tick(lib: &Library) {
    let h = &lib.history;
    let now = now_ms();
    let due: Vec<Id> = {
        let known = h.known.lock().unwrap();
        let last = |id: &Id| known.by_id.get(id).and_then(|v| v.last()).map(|v| v.ms);
        h.pending
            .lock()
            .unwrap()
            .iter()
            .filter(|id| last(id).is_none_or(|ms| now - ms >= SPACING_MS))
            .copied()
            .collect()
    };
    for id in due {
        let found = lib.index.get(id).and_then(|e| Some((fs::read(lib.root.join(&e.path)).ok()?, e)));
        match found {
            Some((bytes, e)) => {
                let _ = h.try_take(&e, &bytes, Origin::App, true);
            }
            None => {
                h.pending.lock().unwrap().remove(&id);
            }
        }
    }
    let mut last = h.last_prune_ms.lock().unwrap();
    if now.saturating_sub(*last) >= DAY {
        *last = now;
        drop(last);
        if let Err(e) = h.prune(now) {
            log::warn!("pruning the history failed: {e}");
        }
    }
}

/// A record's past versions, newest first, the one matching the file marked current.
pub fn versions(lib: &Library, id: Id) -> Vec<HistoryVersion> {
    let current = lib.index.get(id).map(|e| e.hash);
    lib.history
        .versions(id)
        .into_iter()
        .map(|v| HistoryVersion {
            current: current.as_deref() == Some(v.hash.as_str()),
            origin: serde_json::to_value(v.origin).ok().and_then(|o| o.as_str().map(String::from)).unwrap_or_default(),
            hash: v.hash,
            ms: v.ms,
            size: v.size,
            title: v.title,
            path: v.path,
        })
        .collect()
}

/// A version's text (only of that record).
pub fn text(lib: &Library, id: Id, hash: &str) -> Result<String> {
    if !lib.history.versions(id).iter().any(|v| v.hash == hash) {
        return Err(Error::not_found("That version isn’t in this note’s history."));
    }
    Ok(String::from_utf8_lossy(&lib.history.read(hash)?).into_owned())
}

/// A version's body against the file's now, line by line.
pub fn diff(lib: &Library, id: Id, hash: &str) -> Result<Vec<DiffLine>> {
    let old = text(lib, id, hash)?;
    let now = record::read_text(lib, id)?.body;
    Ok(similar::TextDiff::from_lines(record::body(&old), now.as_str())
        .iter_all_changes()
        .map(|c| DiffLine {
            op: match c.tag() {
                similar::ChangeTag::Equal => "equal",
                similar::ChangeTag::Delete => "delete",
                similar::ChangeTag::Insert => "insert",
            }
            .into(),
            text: c.value().trim_end_matches(['\n', '\r']).to_string(),
        })
        .collect())
}

/// Puts a version's body back (the title and fields stay as they are). The text just before
/// is kept as a version first, so a restore can be undone.
pub fn restore(lib: &Library, id: Id, hash: &str, base_version: &str) -> Result<SaveResult> {
    let old = text(lib, id, hash)?;
    let w = lib.write();
    let e = lib.index.get(id).ok_or_else(|| Error::not_found("That note can’t be found."))?;
    if e.hash != base_version {
        return Err(Error::conflict("The note changed since; look again before restoring."));
    }
    let now = fs::read(lib.root.join(&e.path)).ctx("reading the note")?;
    lib.history.take(&e, &now, Origin::BeforeRestore);
    lib.history.expect(id, Origin::Restore);
    let r = save::save_body(&w, id, base_version, None, record::body(&old));
    // A save that wrote has used it; one that didn't mustn't leave it for the next edit.
    lib.history.next_origin(id);
    r
}

/// Notes deleted outside the app that their history can bring back, newest first.
pub fn deleted(lib: &Library) -> Vec<DeletedNote> {
    let mut out: Vec<DeletedNote> = lib
        .history
        .records()
        .into_iter()
        .filter(|v| lib.index.get(v.id).is_none())
        .map(|v| DeletedNote { id: v.id, kind: v.kind, title: v.title, path: v.path, ms: v.ms })
        .collect();
    out.sort_by_key(|d| std::cmp::Reverse(d.ms));
    out
}

/// Writes a deleted note back from its newest version, with its own ID.
pub fn bring_back(lib: &Library, id: Id) -> Result<Written> {
    let v = lib
        .history
        .versions(id)
        .into_iter()
        .next()
        .ok_or_else(|| Error::not_found("There is no history of that note."))?;
    let bytes = lib.history.read(&v.hash)?;
    let w = lib.write();
    lib.history.expect(id, Origin::Restore);
    let e = save::bring_back(&w, id, &v.path, &bytes);
    lib.history.next_origin(id);
    let e = e?;
    Ok(Written { info: record::info(lib, &e), seq: w.seq() })
}
