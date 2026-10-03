//! Port traits. Each port has a real adapter and a test adapter, and one shared suite (in
//! `testkit`) runs against both.

use crate::error::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

// ---------------------------------------------------------------------------------------------
// Clock and IdGenerator

/// The system clock, or a fixed one in tests.
pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch, UTC.
    fn now_ms(&self) -> i64;
    /// The local offset from UTC in seconds, at the given instant.
    fn local_offset_s(&self, at_ms: i64) -> i32;
}

/// UUID v7, or a fixed sequence in tests.
pub trait IdGenerator: Send + Sync {
    fn next_id(&self) -> crate::Id;
}

// ---------------------------------------------------------------------------------------------
// FileSystem

/// What a check compares: size, modification and change times (ns), inode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileMeta {
    pub len: u64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
    pub inode: u64,
    /// Creation time, when the file system records it.
    pub birth_ns: Option<i64>,
    pub is_dir: bool,
    /// The user's permissions allow replacing it (no read-only mode, not locked).
    pub writable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// How hard a flush is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flush {
    /// `fsync`: ordered towards the drive, not necessarily on the platter.
    Data,
    /// `F_FULLFSYNC`: on permanent storage, and everything flushed before it too.
    Full,
}

/// The file system, kept narrow on purpose: the kernel owns the safe-write algorithm and this
/// port is where faults are injected. Paths are absolute.
pub trait FileSystem: Send + Sync {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    /// `Ok(None)` when nothing is at `path`.
    fn stat(&self, path: &Path) -> io::Result<Option<FileMeta>>;
    fn list(&self, dir: &Path) -> io::Result<Vec<DirEntry>>;
    fn create_dir_all(&self, path: &Path) -> io::Result<()>;
    /// Creates a new file exclusively and writes it; fails if anything exists at `path`.
    /// The bytes are not durable until [`FileSystem::flush_file`].
    fn write_new(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;
    fn flush_file(&self, path: &Path, how: Flush) -> io::Result<()>;
    /// Renames atomically, replacing anything at `to`.
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// Renames atomically, failing with `AlreadyExists` if anything is at `to` (`RENAME_EXCL`).
    fn rename_exclusive(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// Makes the folder's entries (creations, renames, removals) durable.
    fn flush_dir(&self, dir: &Path, how: Flush) -> io::Result<()>;
    /// Issues one `F_FULLFSYNC` on the volume holding `path` (ends a background batch).
    fn barrier(&self, path: &Path) -> io::Result<()>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
    fn remove_dir(&self, path: &Path) -> io::Result<()>;
}

// ---------------------------------------------------------------------------------------------
// ChangeSource

/// Where a change source stopped: enough to replay everything since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplayState {
    pub event_id: u64,
    pub volume_uuid: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeBatch {
    /// Absolute paths that may have changed.
    pub paths: Vec<PathBuf>,
    /// Events were dropped or merged, or history is unusable: check everything.
    pub rescan: bool,
    /// The replay of past events is complete (sent once, after a replay).
    pub history_done: bool,
    /// The event ID to store after this batch is applied.
    pub state: ReplayState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartOutcome {
    /// Events since the given state will be replayed, then `history_done`.
    Replaying,
    /// No usable history (first run, different volume, IDs wrapped): do a full check.
    Unavailable(String),
}

pub type ChangeSink = Box<dyn Fn(ChangeBatch) + Send + Sync>;

/// Watches the library folder, and replays what changed while the app was closed.
pub trait ChangeSource: Send + Sync {
    /// Starts watching `root`. With `since`, replays every event after it first.
    fn start(&self, root: &Path, since: Option<ReplayState>, sink: ChangeSink) -> Result<StartOutcome>;
    fn stop(&self);
    /// The state as of now, for a full check that has just completed.
    fn current(&self, root: &Path) -> Result<ReplayState>;
}

// ---------------------------------------------------------------------------------------------
// IndexEngine

/// A cell in an index table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Cell {
    Null,
    Int(i64),
    Text(String),
}

impl Cell {
    pub fn text(&self) -> Option<&str> {
        match self {
            Cell::Text(s) => Some(s),
            _ => None,
        }
    }
    pub fn int(&self) -> Option<i64> {
        match self {
            Cell::Int(i) => Some(*i),
            _ => None,
        }
    }
}

impl From<&str> for Cell {
    fn from(s: &str) -> Self {
        Cell::Text(s.to_string())
    }
}
impl From<String> for Cell {
    fn from(s: String) -> Self {
        Cell::Text(s)
    }
}
impl From<i64> for Cell {
    fn from(i: i64) -> Self {
        Cell::Int(i)
    }
}
impl<T: Into<Cell>> From<Option<T>> for Cell {
    fn from(o: Option<T>) -> Self {
        o.map(Into::into).unwrap_or(Cell::Null)
    }
}

pub type Row = Vec<Cell>;

/// A table: the first column is the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableSpec {
    pub name: String,
    pub columns: Vec<String>,
    /// Columns to look rows up by (besides the key).
    pub indexed: Vec<String>,
}

/// A derived view's storage: tables, and optionally a full-text index of passages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewSpec {
    pub name: String,
    pub schema_version: u32,
    pub tables: Vec<TableSpec>,
    pub text: bool,
}

/// One passage in the full-text index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Passage {
    pub record: String,
    pub kind: String,
    pub ordinal: i64,
    pub title: String,
    pub body: String,
    /// Where the passage starts in the record's text (code points), for opening at the place.
    pub offset: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TextQuery {
    /// The user's query: words (prefix-matched), `"phrases"` and `-exclusions`.
    pub text: String,
    /// Only these kinds; applied before the limit.
    pub kinds: Vec<String>,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextHit {
    pub record: String,
    pub kind: String,
    pub ordinal: i64,
    pub offset: i64,
    pub title: String,
    /// The passage with matches marked by `\u{2}` … `\u{3}`.
    pub snippet: String,
    /// Higher is better.
    pub score: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenState {
    /// The view's file exists at the right schema version.
    Ready,
    /// The view's file was missing, damaged or at another version: it is empty and must be
    /// rebuilt.
    Empty,
}

/// Disposable index storage: one file per derived view, each stamped with its schema version.
pub trait IndexEngine: Send + Sync {
    /// Opens a view. A missing, damaged or differently versioned file comes back `Empty`.
    fn open(&self, spec: &ViewSpec) -> Result<(Box<dyn ViewIndex>, OpenState)>;
    /// Starts a rebuild into a new file; [`ViewIndex::finish_rebuild`] replaces the old file.
    fn rebuild(&self, spec: &ViewSpec) -> Result<Box<dyn ViewIndex>>;
    /// Deletes a view's file.
    fn drop_view(&self, name: &str) -> Result<()>;
}

pub trait ViewIndex: Send {
    fn begin(&mut self) -> Result<()>;
    fn commit(&mut self) -> Result<()>;
    /// Inserts or replaces a row by its key (first column).
    fn put(&mut self, table: &str, row: Row) -> Result<()>;
    fn delete(&mut self, table: &str, key: &str) -> Result<()>;
    fn delete_where(&mut self, table: &str, column: &str, value: &Cell) -> Result<()>;
    fn get(&self, table: &str, key: &str) -> Result<Option<Row>>;
    fn find(&self, table: &str, column: &str, value: &Cell) -> Result<Vec<Row>>;
    fn all(&self, table: &str) -> Result<Vec<Row>>;
    fn meta_get(&self, key: &str) -> Result<Option<String>>;
    fn meta_put(&mut self, key: &str, value: &str) -> Result<()>;
    /// Replaces a record's passages.
    fn put_passages(&mut self, record: &str, passages: &[Passage]) -> Result<()>;
    fn delete_passages(&mut self, record: &str) -> Result<()>;
    fn search(&self, q: &TextQuery) -> Result<Vec<TextHit>>;
    /// Completes a rebuild started by [`IndexEngine::rebuild`]: the new file replaces the old.
    fn finish_rebuild(self: Box<Self>) -> Result<Box<dyn ViewIndex>>;
}

// ---------------------------------------------------------------------------------------------
// VersionStore

/// Version history (BRIEF §9): off for now. Its `none` adapter records nothing.
pub trait VersionStore: Send + Sync {
    /// Called after the app writes a store file (store-relative path).
    fn recorded(&self, path: &str, bytes: &[u8]) -> Result<()>;
    /// Past versions of a file, newest first.
    fn history(&self, path: &str) -> Result<Vec<String>>;
}

// ---------------------------------------------------------------------------------------------
// WorkerHost

/// Runs parsers in an isolated worker process, speaking JSON-RPC over stdin/stdout.
pub trait WorkerHost: Send + Sync {
    /// Calls a worker method. Times out, restarts the worker after a crash, a hang or the
    /// memory ceiling, and reports a `Worker` error.
    fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value>;
}

// ---------------------------------------------------------------------------------------------
// Desktop

/// Asks the desktop to show things to the user (Finder). Nothing here changes files.
pub trait Desktop: Send + Sync {
    /// Shows a file or folder in Finder.
    fn reveal(&self, path: &Path) -> Result<()>;
}

// ---------------------------------------------------------------------------------------------
// PageSaver

/// What a saved web page gives: a faithful PDF and the page's clean text and metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedPage {
    /// The address after redirects.
    pub final_url: String,
    /// The HTTP status of the page, when the browser reports it.
    pub status: Option<u16>,
    pub title: String,
    pub author: Option<String>,
    /// The site or publication.
    pub publication: Option<String>,
    pub published: Option<String>,
    pub language: Option<String>,
    /// The readable text (the article, or the page's main content).
    pub text: String,
    /// All visible text, for checks.
    pub visible_text: String,
    /// The page's HTML, truncated, for checks.
    pub html: String,
    /// Images visible on the page (loaded, not tiny).
    pub images: u32,
    pub pdf: Vec<u8>,
}

/// Saves a web page from its address. The real adapter uses WebKit in the app's webview.
pub trait PageSaver: Send + Sync {
    fn save(&self, url: &str, timeout: Duration) -> Result<SavedPage>;
}
