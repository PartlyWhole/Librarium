//! The store: the user's folder, the records table, and every write to the folder.
//!
//! Writes happen only on the writer's thread (see [`crate::writer`]), through [`Tx`]. The order
//! is always: write the file, then update the index, then update memory, then announce.

use crate::changes::ChangeLog;
use crate::frontmatter::{self, FmError, FmValue, Frontmatter};
use crate::hash::version_of;
use crate::kinds::{Format, Kinds, RecordKindDef};
use crate::merge::merge3;
use crate::record::{self, Decoded, ReadOnly, RESERVED};
use crate::slug::slugify;
use crate::time::iso_utc;
use librarium_contracts::api::{DuplicateInfo, RecordInfo, RecordText, SaveResult, StorePhase, StoreStatus};
use librarium_contracts::events::{ChangeOp, ChangeOrigin};
use librarium_contracts::ports::{
    Cell, Clock, FileMeta, FileSystem, Flush, IdGenerator, TableSpec, VersionStore, ViewIndex, ViewSpec,
};
use librarium_contracts::{BackendError, ErrorCode, Id, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};

/// How long the folder must be quiet before IDs are rewritten.
pub const QUIET_MS: i64 = 3_000;
/// Marks our temporary files: `.<name>.librarium-tmp-<n>`.
pub const TMP_MARK: &str = ".librarium-tmp-";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Durability {
    /// Interactive lane: every write is fully flushed before it returns.
    Full,
    /// Background lane: data flushes now, one `F_FULLFSYNC` at the end of the batch.
    Batch,
}

impl Durability {
    fn flush(self) -> Flush {
        match self {
            Durability::Full => Flush::Full,
            Durability::Batch => Flush::Data,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fingerprint {
    pub len: u64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
    pub inode: u64,
}

impl From<&FileMeta> for Fingerprint {
    fn from(m: &FileMeta) -> Self {
        Fingerprint { len: m.len, mtime_ns: m.mtime_ns, ctime_ns: m.ctime_ns, inode: m.inode }
    }
}

/// One record, as the records table knows it.
#[derive(Debug, Clone)]
pub struct Entry {
    pub id: Id,
    pub kind: String,
    pub title: String,
    pub path: String,
    pub fp: Fingerprint,
    pub hash: String,
    pub created: Option<String>,
    pub read_only: Option<ReadOnly>,
    pub fields: Map<String, Value>,
    pub conflicts: Vec<String>,
    /// When the file was last stat-ed (ns), for git's "racy" rule.
    pub checked_ns: i64,
}

impl Entry {
    pub fn info(&self) -> RecordInfo {
        RecordInfo {
            id: self.id,
            kind: self.kind.clone(),
            title: self.title.clone(),
            path: self.path.clone(),
            version: self.hash.clone(),
            created: self.created.clone(),
            read_only: self.read_only.as_ref().map(ReadOnly::describe),
            fields: self.fields.clone(),
            conflicts: self.conflicts.clone(),
        }
    }
    pub fn field_str(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(Value::as_str)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DupClass {
    Conflict,
    Copy,
}

#[derive(Debug, Clone)]
pub struct Duplicate {
    pub id: Id,
    pub path: String,
    pub class: DupClass,
}

/// Writes the store makes on its own, only when the folder is quiet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Repair {
    /// Give a file without a (canonical) ID one; `id` keeps a damaged-but-readable ID.
    AssignId { path: String, hash: String, id: Option<Id> },
    /// Give a copy its own ID, recording where it was copied from.
    RewriteCopy { path: String, hash: String, original: Id },
}

impl Repair {
    pub fn path(&self) -> &str {
        match self {
            Repair::AssignId { path, .. } | Repair::RewriteCopy { path, .. } => path,
        }
    }
}

/// An operation touching several files: written before, redone at startup if unfinished.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Intent {
    /// Make the record's file name and frontmatter match a title and subfolder.
    Relocate { record: Id, title: String, subfolder: Option<String> },
    /// Rename `from` to the canonical name for `id` and write the ID (and `copied-from`).
    Identify { from: String, id: Id, copied_from: Option<Id> },
}

#[derive(Default)]
pub(crate) struct State {
    pub by_id: HashMap<Id, Entry>,
    pub by_path: HashMap<String, Id>,
    pub duplicates: BTreeMap<String, Duplicate>,
    pub repairs: BTreeMap<String, Repair>,
    /// Files that could not be identified at all (unparsable, no ID).
    pub unreadable: BTreeMap<String, String>,
}

pub struct Ports {
    pub fs: Arc<dyn FileSystem>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdGenerator>,
    pub versions: Arc<dyn VersionStore>,
}

pub struct Store {
    pub root: PathBuf,
    pub app_dir: PathBuf,
    pub fs: Arc<dyn FileSystem>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdGenerator>,
    pub versions: Arc<dyn VersionStore>,
    pub kinds: Arc<Kinds>,
    pub changes: ChangeLog,
    pub(crate) state: RwLock<State>,
    table: Mutex<Box<dyn ViewIndex>>,
    status: Mutex<StoreStatus>,
    ready: (Mutex<bool>, Condvar),
    tmp_counter: AtomicU64,
    pub(crate) last_outside_ms: AtomicI64,
}

pub fn records_view() -> ViewSpec {
    ViewSpec {
        name: "records".into(),
        schema_version: 1,
        tables: vec![TableSpec {
            name: "records".into(),
            columns: [
                "id",
                "kind",
                "title",
                "path",
                "len",
                "mtime_ns",
                "ctime_ns",
                "inode",
                "hash",
                "created",
                "checked_ns",
                "fields",
                "read_only",
            ]
            .map(String::from)
            .to_vec(),
            indexed: vec!["path".into(), "kind".into()],
        }],
        text: false,
    }
}

fn io_err(e: io::Error, what: &str) -> BackendError {
    let code = match e.kind() {
        io::ErrorKind::NotFound => ErrorCode::NotFound,
        io::ErrorKind::PermissionDenied => ErrorCode::Io,
        _ => ErrorCode::Io,
    };
    BackendError::new(code, format!("{what}: {e}")).with_data(serde_json::json!({ "io": format!("{:?}", e.kind()) }))
}

pub(crate) fn rel_str(p: &Path) -> String {
    p.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

fn entry_row(e: &Entry) -> Vec<Cell> {
    vec![
        e.id.to_string().into(),
        e.kind.clone().into(),
        e.title.clone().into(),
        e.path.clone().into(),
        Cell::Int(e.fp.len as i64),
        Cell::Int(e.fp.mtime_ns),
        Cell::Int(e.fp.ctime_ns),
        Cell::Int(e.fp.inode as i64),
        e.hash.clone().into(),
        e.created.clone().into(),
        Cell::Int(e.checked_ns),
        Value::Object(e.fields.clone()).to_string().into(),
        e.read_only.as_ref().map(|r| serde_json::to_string(r).unwrap()).into(),
    ]
}

fn row_entry(r: &[Cell]) -> Option<Entry> {
    let t = |i: usize| r.get(i).and_then(Cell::text).map(str::to_string);
    let n = |i: usize| r.get(i).and_then(Cell::int).unwrap_or(0);
    Some(Entry {
        id: t(0)?.parse().ok()?,
        kind: t(1)?,
        title: t(2).unwrap_or_default(),
        path: t(3)?,
        fp: Fingerprint { len: n(4) as u64, mtime_ns: n(5), ctime_ns: n(6), inode: n(7) as u64 },
        hash: t(8)?,
        created: t(9),
        checked_ns: n(10),
        fields: t(11).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
        read_only: t(12).and_then(|s| serde_json::from_str(&s).ok()),
        conflicts: vec![],
    })
}

impl Store {
    pub fn new(
        root: PathBuf,
        app_dir: PathBuf,
        ports: Ports,
        kinds: Arc<Kinds>,
        table: Box<dyn ViewIndex>,
    ) -> Result<Store> {
        let mut state = State::default();
        for row in table.all("records")? {
            if let Some(e) = row_entry(&row) {
                state.by_path.insert(e.path.clone(), e.id);
                state.by_id.insert(e.id, e);
            }
        }
        let records = state.by_id.len() as u64;
        Ok(Store {
            root,
            app_dir,
            fs: ports.fs,
            clock: ports.clock,
            ids: ports.ids,
            versions: ports.versions,
            kinds,
            changes: ChangeLog::default(),
            state: RwLock::new(state),
            table: Mutex::new(table),
            status: Mutex::new(StoreStatus {
                phase: StorePhase::Checking,
                records,
                last_check: None,
                last_check_ms: 0,
                duplicates: vec![],
                pending_repairs: 0,
            }),
            ready: (Mutex::new(false), Condvar::new()),
            tmp_counter: AtomicU64::new(0),
            last_outside_ms: AtomicI64::new(i64::MIN / 2),
        })
    }

    // ---- reading --------------------------------------------------------------------------

    pub fn abs(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    pub fn get(&self, id: Id) -> Option<Entry> {
        self.state.read().unwrap().by_id.get(&id).cloned()
    }

    pub fn id_at(&self, rel: &str) -> Option<Id> {
        self.state.read().unwrap().by_path.get(rel).copied()
    }

    pub fn len(&self) -> usize {
        self.state.read().unwrap().by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Every record, optionally of one kind, in no particular order.
    pub fn list(&self, kind: Option<&str>) -> Vec<Entry> {
        self.state.read().unwrap().by_id.values().filter(|e| kind.is_none_or(|k| e.kind == k)).cloned().collect()
    }

    /// Records whose field `key` equals `value`.
    pub fn find_by_field(&self, kind: Option<&str>, key: &str, value: &Value) -> Vec<Entry> {
        self.state
            .read()
            .unwrap()
            .by_id
            .values()
            .filter(|e| kind.is_none_or(|k| e.kind == k) && e.fields.get(key) == Some(value))
            .cloned()
            .collect()
    }

    /// Records titled exactly `title` (used to restore a link's missing ID).
    pub fn find_by_title(&self, title: &str) -> Vec<Entry> {
        self.state.read().unwrap().by_id.values().filter(|e| e.title == title).cloned().collect()
    }

    pub fn read_text(&self, id: Id) -> Result<RecordText> {
        let e = self.get(id).ok_or_else(|| BackendError::not_found(format!("no record {id}")))?;
        let bytes = self.fs.read(&self.abs(&e.path)).map_err(|err| io_err(err, "reading the record"))?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let (fm, body) = frontmatter::split(&text);
        let mut info = e.info();
        info.version = version_of(&bytes);
        Ok(RecordText { info, frontmatter: fm.map(|f| f.0.to_string()).unwrap_or_default(), body: body.to_string() })
    }

    /// A record's text for derived views: a Markdown body, or its kind's text source.
    pub fn record_text(&self, e: &Entry) -> Option<String> {
        if let Some(src) = self.kinds.text_sources.get(&e.kind) {
            return src(self, e);
        }
        let def = self.kinds.get(&e.kind)?;
        if def.format != Format::Markdown {
            return None;
        }
        let bytes = self.fs.read(&self.abs(&e.path)).ok()?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        Some(frontmatter::split(&text).1.to_string())
    }

    pub fn read_bytes(&self, rel: &str) -> Result<Vec<u8>> {
        self.fs.read(&self.abs(rel)).map_err(|e| io_err(e, rel))
    }

    pub fn status(&self) -> StoreStatus {
        let mut s = self.status.lock().unwrap().clone();
        let st = self.state.read().unwrap();
        s.records = st.by_id.len() as u64;
        s.duplicates = st
            .duplicates
            .values()
            .map(|d| DuplicateInfo {
                path: d.path.clone(),
                id: d.id,
                class: match d.class {
                    DupClass::Conflict => "conflict".into(),
                    DupClass::Copy => "copy".into(),
                },
            })
            .collect();
        s.pending_repairs = st.repairs.len() as u64;
        s
    }

    pub fn duplicates(&self) -> Vec<Duplicate> {
        self.state.read().unwrap().duplicates.values().cloned().collect()
    }

    pub fn pending_repairs(&self) -> Vec<Repair> {
        self.state.read().unwrap().repairs.values().cloned().collect()
    }

    pub fn is_ready(&self) -> bool {
        *self.ready.0.lock().unwrap()
    }

    /// Blocks until the startup check has finished.
    pub fn wait_ready(&self) {
        let mut r = self.ready.0.lock().unwrap();
        while !*r {
            r = self.ready.1.wait(r).unwrap();
        }
    }

    pub(crate) fn set_ready(&self, check: &str, ms: u64) {
        {
            let mut s = self.status.lock().unwrap();
            s.phase = StorePhase::Ready;
            s.last_check = Some(check.to_string());
            s.last_check_ms = ms;
        }
        *self.ready.0.lock().unwrap() = true;
        self.ready.1.notify_all();
    }

    pub fn note_outside_activity(&self) {
        self.last_outside_ms.store(self.clock.now_ms(), Ordering::SeqCst);
    }

    /// The folder has been quiet long enough, and no git operation is in progress.
    pub fn quiet(&self) -> bool {
        let quiet = self.clock.now_ms() - self.last_outside_ms.load(Ordering::SeqCst) >= QUIET_MS;
        quiet && !self.git_busy()
    }

    fn git_busy(&self) -> bool {
        let git = self.root.join(".git");
        ["index.lock", "MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
            .iter()
            .any(|n| self.fs.stat(&git.join(n)).ok().flatten().is_some())
    }

    // ---- internal state updates (writer thread only) ---------------------------------------

    pub(crate) fn kind_def(&self, kind: &str) -> Result<&RecordKindDef> {
        self.kinds.get(kind).ok_or_else(|| BackendError::invalid(format!("unknown record kind {kind:?}")))
    }

    /// The folder kind a store-relative path belongs to.
    pub(crate) fn kind_for_path(&self, rel: &str) -> Option<&RecordKindDef> {
        let top = rel.split('/').next()?;
        self.kinds.by_folder(top)
    }

    pub(crate) fn decode(&self, rel: &str, bytes: &[u8]) -> Option<Decoded> {
        let def = self.kind_for_path(rel)?;
        let text = String::from_utf8_lossy(bytes);
        Some(match def.format {
            Format::Markdown => record::decode_markdown(&text, &def.kind, &self.kinds),
            Format::JsonDir => record::decode_json(&text, &def.kind, &self.kinds),
        })
    }

    pub(crate) fn upsert(&self, e: Entry) -> Result<()> {
        {
            let mut t = self.table.lock().unwrap();
            t.put("records", entry_row(&e))?;
        }
        let mut st = self.state.write().unwrap();
        if let Some(old) = st.by_id.get(&e.id) {
            if old.path != e.path {
                let p = old.path.clone();
                st.by_path.remove(&p);
            }
        }
        st.by_path.insert(e.path.clone(), e.id);
        st.by_id.insert(e.id, e);
        Ok(())
    }

    pub(crate) fn forget(&self, id: Id) -> Result<Option<Entry>> {
        self.table.lock().unwrap().delete("records", &id.to_string())?;
        let mut st = self.state.write().unwrap();
        let e = st.by_id.remove(&id);
        if let Some(e) = &e {
            st.by_path.remove(&e.path);
        }
        Ok(e)
    }

    pub(crate) fn with_state<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.write().unwrap())
    }

    pub(crate) fn table_meta(&self, key: &str) -> Option<String> {
        self.table.lock().unwrap().meta_get(key).ok().flatten()
    }

    pub(crate) fn set_table_meta(&self, key: &str, value: &str) -> Result<()> {
        self.table.lock().unwrap().meta_put(key, value)
    }

    pub(crate) fn table_begin(&self) {
        let _ = self.table.lock().unwrap().begin();
    }

    pub(crate) fn table_commit(&self) {
        let _ = self.table.lock().unwrap().commit();
    }

    pub(crate) fn now_ns(&self) -> i64 {
        self.clock.now_ms().saturating_mul(1_000_000)
    }

    /// Builds an entry from a file's bytes, keeping conflicts already known for that ID.
    pub(crate) fn entry_from(&self, rel: &str, meta: &FileMeta, bytes: &[u8], d: &Decoded, id: Id) -> Entry {
        let conflicts = self.get(id).map(|e| e.conflicts).unwrap_or_default();
        Entry {
            id,
            kind: d.kind.clone(),
            title: d.title.clone(),
            path: rel.to_string(),
            fp: meta.into(),
            hash: version_of(bytes),
            created: d.created.clone(),
            read_only: d.read_only.clone(),
            fields: d.fields.clone(),
            conflicts,
            checked_ns: self.now_ns(),
        }
    }

    // ---- file helpers ---------------------------------------------------------------------

    fn tmp_path(&self, target: &Path) -> PathBuf {
        let n = self.tmp_counter.fetch_add(1, Ordering::SeqCst);
        let name = target.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        target.with_file_name(format!(".{name}{TMP_MARK}{}-{n}", std::process::id()))
    }

    /// The safe-write algorithm (§6): temp file in the same folder, flush, rename (or
    /// exclusive rename for new files), flush the folder.
    pub fn safe_write(&self, target: &Path, bytes: &[u8], create_new: bool, dur: Durability) -> io::Result<()> {
        let dir = target.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent folder"))?;
        let tmp = self.tmp_path(target);
        self.fs.write_new(&tmp, bytes)?;
        let r = self.fs.flush_file(&tmp, dur.flush()).and_then(|_| {
            if create_new {
                self.fs.rename_exclusive(&tmp, target)
            } else {
                self.fs.rename(&tmp, target)
            }
        });
        if let Err(e) = r {
            let _ = self.fs.remove_file(&tmp);
            return Err(e);
        }
        self.fs.flush_dir(dir, dur.flush())
    }

    fn intents_dir(&self) -> PathBuf {
        self.app_dir.join("intents")
    }

    pub(crate) fn write_intent(&self, intent: &Intent) -> Result<PathBuf> {
        let dir = self.intents_dir();
        self.fs.create_dir_all(&dir).map_err(|e| io_err(e, "intents folder"))?;
        let p = dir.join(format!("{}.json", self.ids.next_id()));
        let bytes = serde_json::to_vec_pretty(intent).unwrap();
        self.safe_write(&p, &bytes, true, Durability::Full).map_err(|e| io_err(e, "writing an intent"))?;
        Ok(p)
    }

    pub(crate) fn clear_intent(&self, p: &Path) {
        let _ = self.fs.remove_file(p);
    }

    pub(crate) fn pending_intents(&self) -> Vec<(PathBuf, Option<Intent>)> {
        let dir = self.intents_dir();
        let Ok(list) = self.fs.list(&dir) else { return vec![] };
        let mut out = vec![];
        for e in list {
            if e.is_dir || !e.name.ends_with(".json") || e.name.starts_with('.') {
                continue;
            }
            let p = dir.join(&e.name);
            let intent = self.fs.read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok());
            out.push((p, intent));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Where a record of this kind lives, given its ID, slug and subfolder.
    pub fn record_path(&self, def: &RecordKindDef, id: Id, slug: &str, subfolder: Option<&str>) -> String {
        let base = if def.slugged && !slug.is_empty() { format!("{id}-{slug}") } else { id.to_string() };
        let sub = subfolder.filter(|s| !s.is_empty()).map(|s| format!("{s}/")).unwrap_or_default();
        match def.format {
            Format::Markdown => format!("{}/{sub}{base}.md", def.folder),
            Format::JsonDir => format!("{}/{base}/record.json", def.folder),
        }
    }

    /// The slug a record should have: the first slug field present, else its title.
    pub fn slug_for(&self, kind: &str, title: &str, fields: &Map<String, Value>) -> String {
        for f in self.kinds.slug_fields_for(kind) {
            if let Some(Value::String(s)) = fields.get(f) {
                let slug = slugify(s);
                if !slug.is_empty() {
                    return slug;
                }
            }
        }
        slugify(title)
    }

    /// The subfolder of a record's path inside its kind's folder.
    pub fn subfolder_of(&self, def: &RecordKindDef, rel: &str) -> Option<String> {
        let inner = rel.strip_prefix(&format!("{}/", def.folder))?;
        let (dir, _) = inner.rsplit_once('/')?;
        (def.format == Format::Markdown).then(|| dir.to_string())
    }
}

/// A write transaction on the writer's thread.
pub struct Tx<'a> {
    pub store: &'a Store,
    pub dur: Durability,
}

pub fn clean_title(t: &str) -> String {
    t.split(['\n', '\r']).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

impl<'a> Tx<'a> {
    pub fn new(store: &'a Store, dur: Durability) -> Self {
        Tx { store, dur }
    }

    fn writable(&self, id: Id) -> Result<Entry> {
        let e = self.store.get(id).ok_or_else(|| BackendError::not_found(format!("no record {id}")))?;
        if let Some(ro) = &e.read_only {
            return Err(BackendError::new(ErrorCode::ReadOnly, ro.describe()));
        }
        // The user's own permissions are respected: a read-only or locked file isn't replaced.
        if let Ok(Some(m)) = self.store.fs.stat(&self.store.abs(&e.path)) {
            if !m.writable {
                return Err(BackendError::io(format!("“{}” is read-only, so it can’t be saved.", e.title))
                    .with_data(serde_json::json!({ "read_only_file": true })));
            }
        }
        Ok(e)
    }

    /// Indexes a file the app has just written, then announces it.
    fn indexed(&self, rel: &str, bytes: &[u8], op: ChangeOp) -> Result<(Entry, u64)> {
        let s = self.store;
        let meta =
            s.fs.stat(&s.abs(rel))
                .map_err(|e| io_err(e, rel))?
                .ok_or_else(|| BackendError::internal(format!("{rel} vanished after writing")))?;
        let d = s
            .decode(rel, bytes)
            .ok_or_else(|| BackendError::internal(format!("{rel} is outside every kind's folder")))?;
        let id = d.id.ok_or_else(|| BackendError::internal("written record has no ID"))?;
        let e = s.entry_from(rel, &meta, bytes, &d, id);
        s.upsert(e.clone())?;
        let _ = s.versions.recorded(rel, bytes);
        let seq = s.changes.emit(id, &e.kind, op, ChangeOrigin::App);
        Ok((e, seq))
    }

    /// Creates a Markdown record. `fields` may not use reserved keys.
    pub fn create(
        &self,
        kind: &str,
        title: &str,
        fields: Vec<(String, FmValue)>,
        body: &str,
        subfolder: Option<&str>,
    ) -> Result<(Entry, u64)> {
        let s = self.store;
        let def = s.kind_def(kind)?.clone();
        if def.format != Format::Markdown {
            return Err(BackendError::invalid(format!("{kind} records are imported, not created")));
        }
        for (k, v) in &fields {
            if RESERVED.contains(&k.as_str()) || matches!(v, FmValue::Other(_)) {
                return Err(BackendError::invalid(format!("field {k:?} can't be set this way")));
            }
        }
        let title = clean_title(title);
        let id = s.ids.next_id();
        let created = iso_utc(s.clock.now_ms());
        let mut fields = fields;
        if let (Some(f), Some(sub)) = (&def.subfolder_field, subfolder) {
            fields.retain(|(k, _)| k != f);
            fields.push((f.clone(), FmValue::Str(sub.to_string())));
        }
        let fm = record::new_frontmatter(id, kind, def.version, &created, &title, &fields);
        let field_map: Map<String, Value> = fields.iter().map(|(k, v)| (k.clone(), v.to_json())).collect();
        let slug = s.slug_for(kind, &title, &field_map);
        let rel = s.record_path(&def, id, &slug, subfolder);
        let abs = s.abs(&rel);
        s.fs.create_dir_all(abs.parent().unwrap()).map_err(|e| io_err(e, "creating the folder"))?;
        let bytes = frontmatter::join(&fm, body, "\n").into_bytes();
        s.safe_write(&abs, &bytes, true, self.dur).map_err(|e| io_err(e, "writing the new record"))?;
        self.indexed(&rel, &bytes, ChangeOp::Created)
    }

    /// Saves a new body. The save carries the version it was based on (and, for a merge, the
    /// base body). A file that is gone is never re-created; a changed file is never overwritten.
    pub fn save_body(&self, id: Id, base_version: &str, base_body: Option<&str>, new_body: &str) -> Result<SaveResult> {
        let s = self.store;
        let e = self.writable(id)?;
        let abs = s.abs(&e.path);
        let cur = match s.fs.read(&abs) {
            Ok(b) => b,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                return Err(BackendError::not_found(format!("{} is gone; the save was refused", e.path))
                    .with_data(serde_json::json!({ "gone": true })));
            }
            Err(err) => return Err(io_err(err, "reading before saving")),
        };
        let cur_version = version_of(&cur);
        let cur_text = String::from_utf8_lossy(&cur).into_owned();
        let (fm, cur_body) = frontmatter::split(&cur_text);
        let newline = if cur_text.contains("\r\n") { "\r\n" } else { "\n" };
        let compose = |body: &str| match fm {
            Some((f, _)) => frontmatter::join(f, body, newline),
            None => body.to_string(),
        };
        let (body, merged) = if cur_version == base_version {
            (new_body.to_string(), false)
        } else {
            match base_body.and_then(|b| merge3(b, new_body, cur_body)) {
                Some(m) => (m, true),
                None => return Ok(SaveResult::Conflict { version: cur_version, body: cur_body.to_string() }),
            }
        };
        let text = compose(&body);
        if text.as_bytes() == cur.as_slice() {
            let seq = s.changes.last_seq();
            return Ok(if merged {
                SaveResult::Merged { version: cur_version, body, seq }
            } else {
                SaveResult::Saved { version: cur_version, seq }
            });
        }
        s.safe_write(&abs, text.as_bytes(), false, self.dur).map_err(|err| io_err(err, "saving"))?;
        let (entry, seq) = self.indexed(&e.path, text.as_bytes(), ChangeOp::Updated)?;
        Ok(if merged {
            SaveResult::Merged { version: entry.hash, body, seq }
        } else {
            SaveResult::Saved { version: entry.hash, seq }
        })
    }

    /// A repair: rewrites a Markdown body if the file is still at `expected_version`
    /// (`f` returns `None` when nothing needs changing). Returns whether it wrote.
    pub fn repair_body(&self, id: Id, expected_version: &str, f: impl FnOnce(&str) -> Option<String>) -> Result<bool> {
        let s = self.store;
        let e = self.writable(id)?;
        let abs = s.abs(&e.path);
        let cur = s.fs.read(&abs).map_err(|err| io_err(err, "reading"))?;
        if version_of(&cur) != expected_version {
            return Err(BackendError::conflict("the record changed since the repair was planned"));
        }
        let text = String::from_utf8_lossy(&cur).into_owned();
        let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let (fm, body) = frontmatter::split(&text);
        let Some(new_body) = f(body) else { return Ok(false) };
        let out = match fm {
            Some((f, _)) => frontmatter::join(f, &new_body, newline),
            None => new_body,
        };
        if out.as_bytes() == cur.as_slice() {
            return Ok(false);
        }
        s.safe_write(&abs, out.as_bytes(), false, self.dur).map_err(|err| io_err(err, "repairing"))?;
        self.indexed(&e.path, out.as_bytes(), ChangeOp::Updated)?;
        Ok(true)
    }

    /// Sets or removes module fields (`module.key`), changing only their bytes.
    pub fn set_fields(
        &self,
        id: Id,
        base_version: Option<&str>,
        edits: &[(String, Option<FmValue>)],
    ) -> Result<(Entry, u64)> {
        let s = self.store;
        let e = self.writable(id)?;
        let def = s.kind_def(&e.kind)?.clone();
        for (k, _) in edits {
            if RESERVED.contains(&k.as_str()) || def.subfolder_field.as_deref() == Some(k) {
                return Err(BackendError::invalid(format!("field {k:?} can't be set this way")));
            }
        }
        if def.format != Format::Markdown {
            return self.set_json_fields(&e, base_version, edits);
        }
        let abs = s.abs(&e.path);
        let cur = s.fs.read(&abs).map_err(|err| io_err(err, "reading"))?;
        if let Some(v) = base_version {
            if version_of(&cur) != v {
                return Err(BackendError::conflict("the record changed since it was read"));
            }
        }
        let text = String::from_utf8_lossy(&cur).into_owned();
        let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let (fm, body) = frontmatter::split(&text);
        let mut fm = Frontmatter::parse(fm.map(|f| f.0).unwrap_or("")).map_err(fm_err)?;
        for (k, v) in edits {
            match v {
                Some(v) => fm.set(k, v).map_err(fm_err)?,
                None => fm.remove(k).map_err(fm_err)?,
            }
        }
        let out = frontmatter::join(fm.text(), body, newline);
        if out.as_bytes() == cur.as_slice() {
            return Ok((e, s.changes.last_seq()));
        }
        s.safe_write(&abs, out.as_bytes(), false, self.dur).map_err(|err| io_err(err, "saving fields"))?;
        self.indexed(&e.path, out.as_bytes(), ChangeOp::Updated)
    }

    fn set_json_fields(
        &self,
        e: &Entry,
        base_version: Option<&str>,
        edits: &[(String, Option<FmValue>)],
    ) -> Result<(Entry, u64)> {
        let s = self.store;
        let abs = s.abs(&e.path);
        let cur = s.fs.read(&abs).map_err(|err| io_err(err, "reading"))?;
        if let Some(v) = base_version {
            if version_of(&cur) != v {
                return Err(BackendError::conflict("the record changed since it was read"));
            }
        }
        let mut obj: Map<String, Value> =
            serde_json::from_slice(&cur).map_err(|err| BackendError::new(ErrorCode::ReadOnly, err.to_string()))?;
        for (k, v) in edits {
            match v {
                Some(v) => {
                    obj.insert(k.clone(), v.to_json());
                }
                None => {
                    obj.remove(k);
                }
            }
        }
        let mut out = serde_json::to_vec_pretty(&Value::Object(obj)).unwrap();
        out.push(b'\n');
        s.safe_write(&abs, &out, false, self.dur).map_err(|err| io_err(err, "saving fields"))?;
        self.indexed(&e.path, &out, ChangeOp::Updated)
    }

    /// Renames and/or moves a record: the file name follows the title. Written as an intent:
    /// rename first, then rewrite the frontmatter.
    pub fn relocate(&self, id: Id, title: Option<&str>, subfolder: Option<Option<&str>>) -> Result<(Entry, u64)> {
        self.relocate_from(id, None, title, subfolder)
    }

    /// Like [`Tx::relocate`], refusing if the record changed since `base_version` (used by undo).
    pub fn relocate_from(
        &self,
        id: Id,
        base_version: Option<&str>,
        title: Option<&str>,
        subfolder: Option<Option<&str>>,
    ) -> Result<(Entry, u64)> {
        let s = self.store;
        let e = self.writable(id)?;
        if let Some(v) = base_version {
            if v != e.hash {
                return Err(BackendError::conflict(format!("“{}” changed since, so this can’t be undone.", e.title)));
            }
        }
        let def = s.kind_def(&e.kind)?.clone();
        let title = title.map(clean_title).unwrap_or_else(|| e.title.clone());
        if title.is_empty() {
            return Err(BackendError::invalid("a title can't be empty"));
        }
        let sub = match subfolder {
            Some(s) => s.map(|x| x.trim_matches('/').to_string()).filter(|x| !x.is_empty()),
            None => s.subfolder_of(&def, &e.path).filter(|x| !x.is_empty()),
        };
        if let Some(sub) = &sub {
            if sub.split('/').any(|p| p.is_empty() || p.starts_with('.') || p == "..") {
                return Err(BackendError::invalid(format!("not a folder name: {sub:?}")));
            }
        }
        let intent = Intent::Relocate { record: id, title, subfolder: sub };
        let p = s.write_intent(&intent)?;
        let r = self.apply(&intent);
        if r.is_ok() {
            s.clear_intent(&p);
        }
        r
    }

    /// Carries out an intent. Idempotent: redoing a finished intent changes nothing.
    pub fn apply(&self, intent: &Intent) -> Result<(Entry, u64)> {
        match intent {
            Intent::Relocate { record, title, subfolder } => self.apply_relocate(*record, title, subfolder.as_deref()),
            Intent::Identify { from, id, copied_from } => self.apply_identify(from, *id, *copied_from),
        }
    }

    fn apply_relocate(&self, id: Id, title: &str, subfolder: Option<&str>) -> Result<(Entry, u64)> {
        let s = self.store;
        let e = s.get(id).ok_or_else(|| BackendError::not_found(format!("no record {id}")))?;
        let def = s.kind_def(&e.kind)?.clone();
        let mut fields = e.fields.clone();
        if let Some(f) = &def.subfolder_field {
            match subfolder {
                Some(sub) => fields.insert(f.clone(), Value::String(sub.into())),
                None => fields.remove(f),
            };
        }
        let slug = s.slug_for(&e.kind, title, &fields);
        let target = s.record_path(&def, id, &slug, subfolder);
        let mut path = e.path.clone();
        let renamed = target != e.path;
        if renamed {
            let (from, to) = match def.format {
                Format::Markdown => (s.abs(&e.path), s.abs(&target)),
                Format::JsonDir => {
                    (s.abs(&e.path).parent().unwrap().to_path_buf(), s.abs(&target).parent().unwrap().to_path_buf())
                }
            };
            s.fs.create_dir_all(to.parent().unwrap()).map_err(|err| io_err(err, "creating the folder"))?;
            s.fs.rename_exclusive(&from, &to).map_err(|err| io_err(err, "renaming"))?;
            s.fs.flush_dir(to.parent().unwrap(), self.dur.flush()).map_err(|err| io_err(err, "flushing"))?;
            if from.parent() != to.parent() {
                s.fs.flush_dir(from.parent().unwrap(), self.dur.flush()).map_err(|err| io_err(err, "flushing"))?;
            }
            path = target.clone();
            // Memory follows the file at once, so a crash before the rewrite is found by ID.
            let mut moved = e.clone();
            moved.path = path.clone();
            s.upsert(moved)?;
        }
        // Then rewrite the frontmatter.
        let mut edits: Vec<(String, Option<FmValue>)> = vec![];
        if e.title != title {
            edits.push(("title".into(), Some(FmValue::Str(title.into()))));
        }
        if let Some(f) = &def.subfolder_field {
            let want = subfolder.map(|x| Value::String(x.into()));
            if e.fields.get(f) != want.as_ref() {
                edits.push((f.clone(), subfolder.map(|x| FmValue::Str(x.into()))));
            }
        }
        let abs = s.abs(&path);
        let cur = s.fs.read(&abs).map_err(|err| io_err(err, "reading"))?;
        if edits.is_empty() {
            let op = if renamed { ChangeOp::Renamed } else { ChangeOp::Updated };
            return self.indexed(&path, &cur, op);
        }
        let out = match def.format {
            Format::Markdown => {
                let text = String::from_utf8_lossy(&cur).into_owned();
                let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
                let (fm, body) = frontmatter::split(&text);
                let mut fm = Frontmatter::parse(fm.map(|f| f.0).unwrap_or("")).map_err(fm_err)?;
                for (k, v) in &edits {
                    match v {
                        Some(v) => fm.set(k, v).map_err(fm_err)?,
                        None => fm.remove(k).map_err(fm_err)?,
                    }
                }
                frontmatter::join(fm.text(), body, newline).into_bytes()
            }
            Format::JsonDir => {
                let mut obj: Map<String, Value> = serde_json::from_slice(&cur)
                    .map_err(|err| BackendError::new(ErrorCode::ReadOnly, err.to_string()))?;
                for (k, v) in &edits {
                    match v {
                        Some(v) => obj.insert(k.clone(), v.to_json()),
                        None => obj.remove(k),
                    };
                }
                let mut b = serde_json::to_vec_pretty(&Value::Object(obj)).unwrap();
                b.push(b'\n');
                b
            }
        };
        s.safe_write(&abs, &out, false, self.dur).map_err(|err| io_err(err, "rewriting the title"))?;
        self.indexed(&path, &out, ChangeOp::Renamed)
    }

    /// Renames `from` to the canonical name for `id`, then writes the ID into it.
    fn apply_identify(&self, from: &str, id: Id, copied_from: Option<Id>) -> Result<(Entry, u64)> {
        let s = self.store;
        let def = s
            .kind_for_path(from)
            .ok_or_else(|| BackendError::invalid(format!("{from} is outside every kind's folder")))?
            .clone();
        if def.format != Format::Markdown {
            return Err(BackendError::invalid("only Markdown records are identified in place"));
        }
        let sub = s.subfolder_of(&def, from);
        // Where is the file now? At `from`, or already renamed.
        let cur_rel = {
            let src_exists = s.fs.stat(&s.abs(from)).ok().flatten().is_some();
            if src_exists {
                from.to_string()
            } else {
                let dir = Path::new(&s.abs(from)).parent().unwrap().to_path_buf();
                let prefix = id.to_string();
                let found = s.fs.list(&dir).ok().and_then(|l| {
                    l.into_iter().find(|e| !e.is_dir && e.name.starts_with(&prefix) && e.name.ends_with(".md"))
                });
                match found {
                    Some(f) => rel_str(Path::new(&format!(
                        "{}/{}",
                        Path::new(from).parent().map(rel_str).unwrap_or_default(),
                        f.name
                    )))
                    .trim_start_matches('/')
                    .to_string(),
                    None => return Err(BackendError::not_found(format!("{from} is gone"))),
                }
            }
        };
        let bytes = s.fs.read(&s.abs(&cur_rel)).map_err(|e| io_err(e, "reading"))?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let d = s.decode(&cur_rel, &bytes).ok_or_else(|| BackendError::internal("undecodable"))?;
        let title = if d.title.is_empty() {
            Path::new(&cur_rel).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
        } else {
            d.title.clone()
        };
        let slug = s.slug_for(&def.kind, &title, &d.fields);
        let target = s.record_path(&def, id, &slug, sub.as_deref());
        let mut rel = cur_rel.clone();
        if cur_rel != target {
            s.fs.rename_exclusive(&s.abs(&cur_rel), &s.abs(&target)).map_err(|e| io_err(e, "renaming"))?;
            s.fs.flush_dir(s.abs(&target).parent().unwrap(), self.dur.flush()).map_err(|e| io_err(e, "flushing"))?;
            rel = target;
        }
        let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let (fm, body) = frontmatter::split(&text);
        let out = match fm {
            Some((f, _)) => {
                let mut fm = Frontmatter::parse(f).map_err(fm_err)?;
                fm.set("id", &FmValue::Str(id.to_string())).map_err(fm_err)?;
                if fm.get("kind").is_none() {
                    fm.set("kind", &FmValue::Str(def.kind.clone())).map_err(fm_err)?;
                }
                if fm.get("title").is_none() {
                    fm.set("title", &FmValue::Str(title.clone())).map_err(fm_err)?;
                }
                if let Some(o) = copied_from {
                    fm.set("copied-from", &FmValue::Str(o.to_string())).map_err(fm_err)?;
                }
                frontmatter::join(fm.text(), body, newline)
            }
            None => {
                let created = iso_utc(s.clock.now_ms());
                let mut fm = record::new_frontmatter(id, &def.kind, def.version, &created, &title, &[]);
                if let Some(o) = copied_from {
                    fm.push_str(&format!("copied-from: \"{o}\"\n"));
                }
                frontmatter::join(&fm, &text, newline)
            }
        };
        s.safe_write(&s.abs(&rel), out.as_bytes(), false, self.dur).map_err(|e| io_err(e, "writing the ID"))?;
        s.with_state(|st| {
            st.duplicates.remove(from);
            st.repairs.remove(from);
            st.unreadable.remove(from);
        });
        self.save_side_lists()?;
        let op = if s.get(id).is_some() { ChangeOp::Updated } else { ChangeOp::Created };
        self.indexed(&rel, out.as_bytes(), op)
    }

    /// Runs the repairs whose files still match what was seen. Call only when the folder is
    /// quiet (see [`Store::quiet`]).
    pub fn run_repairs(&self) -> Vec<Result<Id>> {
        let s = self.store;
        let mut out = vec![];
        for r in s.pending_repairs() {
            let path = r.path().to_string();
            let still = s.fs.read(&s.abs(&path)).ok().map(|b| version_of(&b));
            let (expected, id, copied_from) = match &r {
                Repair::AssignId { hash, id, .. } => (hash, id.unwrap_or_else(|| s.ids.next_id()), None),
                Repair::RewriteCopy { hash, original, .. } => (hash, s.ids.next_id(), Some(*original)),
            };
            if still.as_ref() != Some(expected) {
                // Changed since it was seen: drop it; the next check sees it afresh.
                s.with_state(|st| st.repairs.remove(&path));
                continue;
            }
            let intent = Intent::Identify { from: path.clone(), id, copied_from };
            let res = s.write_intent(&intent).and_then(|p| {
                let r = self.apply(&intent);
                if r.is_ok() {
                    s.clear_intent(&p);
                }
                r
            });
            out.push(res.map(|(e, _)| e.id));
        }
        out
    }
}

fn fm_err(e: FmError) -> BackendError {
    match e {
        FmError::Complex(_) | FmError::Invalid(_) => BackendError::new(ErrorCode::ReadOnly, e.to_string()),
    }
}
