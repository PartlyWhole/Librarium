//! API message types: parameters and results of API calls.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Method names of the built-in API calls.
pub mod methods {
    pub const APP_INFO: &str = "app.info";
    pub const WORKER_PING: &str = "worker.ping";
    pub const LIBRARY_STATUS: &str = "folder.status";
    pub const LIBRARY_OPEN: &str = "folder.open";
    pub const LIBRARY_CLOSE: &str = "folder.close";
    pub const RECORDS_LIST: &str = "records.list";
    pub const RECORDS_GET: &str = "records.get";
    pub const RECORDS_READ: &str = "records.read";
    pub const RECORDS_CREATE: &str = "records.create";
    pub const RECORDS_SAVE: &str = "records.save";
    pub const RECORDS_SET_FIELDS: &str = "records.setFields";
    pub const RECORDS_RELOCATE: &str = "records.relocate";
    pub const SETTINGS_GET: &str = "settings.get";
    pub const SETTINGS_SET: &str = "settings.set";
    pub const FOLDER_INSPECT: &str = "folder.inspect";
    pub const FOLDER_REVEAL: &str = "folder.reveal";
    pub const APP_REVEAL_LOGS: &str = "app.revealLogs";
    pub const APP_LOG: &str = "app.log";
    pub const DRAFTS_PUT: &str = "drafts.put";
    pub const DRAFTS_GET: &str = "drafts.get";
    pub const DRAFTS_LIST: &str = "drafts.list";
    pub const DRAFTS_DISCARD: &str = "drafts.discard";
    pub const JOBS_LIST: &str = "jobs.list";
    pub const JOBS_RETRY: &str = "jobs.retry";
    pub const JOBS_CANCEL: &str = "jobs.cancel";
    pub const JOBS_DISMISS: &str = "jobs.dismiss";
    pub const INDEX_REBUILD: &str = "index.rebuild";
    pub const INDEX_STATUS: &str = "index.status";
    pub const EXPORT_WRITE: &str = "export.write";
    pub const RECORDS_TEXT: &str = "records.text";
    pub const RECORDS_MOVE: &str = "records.move";
    pub const FOLDERS_LIST: &str = "folders.list";
    pub const FOLDERS_CREATE: &str = "folders.create";
    pub const FOLDERS_MOVE: &str = "folders.move";
    pub const FOLDERS_REMOVE: &str = "folders.remove";
    pub const FOLDERS_SET_ORDER: &str = "folders.setOrder";
    pub const APP_OPEN_URL: &str = "app.openUrl";
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub api_methods: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct WorkerPong {
    pub worker_version: String,
    #[ts(type = "number")]
    pub pid: u32,
    #[ts(type = "number")]
    pub round_trip_us: u64,
}

/// A record as listed: its envelope and fields, never its body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RecordInfo {
    pub id: crate::Id,
    pub kind: String,
    pub title: String,
    /// Store-relative path, `/`-separated.
    pub path: String,
    /// The content hash a save must be based on.
    pub version: String,
    pub created: Option<String>,
    /// Why the record can't be edited, when it can't.
    pub read_only: Option<String>,
    #[ts(type = "Record<string, unknown>")]
    pub fields: serde_json::Map<String, serde_json::Value>,
    /// Other files claiming this ID that look like sync conflicts, to compare.
    pub conflicts: Vec<String>,
}

/// A text record with its body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RecordText {
    pub info: RecordInfo,
    /// The frontmatter text between the `---` lines.
    pub frontmatter: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum SaveResult {
    Saved {
        version: String,
        #[ts(type = "number")]
        seq: u64,
    },
    /// The file changed since; an automatic three-way merge succeeded.
    Merged {
        version: String,
        body: String,
        #[ts(type = "number")]
        seq: u64,
    },
    /// The file changed since and the edits overlap: both versions are shown.
    Conflict { version: String, body: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum StorePhase {
    /// The startup check is running: views show "checking".
    Checking,
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct StoreStatus {
    pub phase: StorePhase,
    #[ts(type = "number")]
    pub records: u64,
    /// "replay" or "full", for the last startup or periodic check.
    pub last_check: Option<String>,
    #[ts(type = "number")]
    pub last_check_ms: u64,
    /// Files claiming another record's ID.
    pub duplicates: Vec<DuplicateInfo>,
    /// Records whose ID is missing or damaged, waiting for a quiet moment to be repaired.
    #[ts(type = "number")]
    pub pending_repairs: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct DuplicateInfo {
    pub path: String,
    pub id: crate::Id,
    /// "conflict" or "copy".
    pub class: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum LibraryState {
    /// No library folder chosen yet (first run).
    None,
    /// Opening, and running the startup check.
    Opening,
    Open,
    /// The chosen folder can't be found (e.g. an unmounted drive).
    Missing,
    /// Opening failed for another reason.
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct LibraryStatus {
    pub state: LibraryState,
    pub path: Option<String>,
    pub id: Option<crate::Id>,
    /// The folder is inside iCloud Drive (the app's own data stays outside it).
    pub in_icloud: bool,
    pub store: Option<StoreStatus>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct OpenLibraryParams {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct IdParams {
    pub id: crate::Id,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct ListParams {
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct CreateParams {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub fields: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub subfolder: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct SaveParams {
    pub id: crate::Id,
    pub base_version: String,
    /// The body the edit started from, for a three-way merge.
    #[serde(default)]
    pub base_body: Option<String>,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct SetFieldsParams {
    pub id: crate::Id,
    #[serde(default)]
    pub base_version: Option<String>,
    /// `null` removes a field.
    #[ts(type = "Record<string, unknown>")]
    pub fields: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RelocateParams {
    pub id: crate::Id,
    /// Refuse if the record changed since this version (undo).
    #[serde(default)]
    pub base_version: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Absent: keep the folder. `null` or "": the kind's top folder.
    #[serde(default, deserialize_with = "some_option")]
    #[ts(optional, type = "string | null")]
    pub subfolder: Option<Option<String>>,
}

/// The user's folders, for each kind kept in folders.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct FoldersList {
    pub spaces: Vec<FolderSpace>,
}

/// One kind's folders (`/`-separated paths, sorted) and the order the user arranged them in:
/// `{ folder: [record ID or "folder:<name>", …] }`, the top level as `""`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct FolderSpace {
    pub kind: String,
    pub folders: Vec<String>,
    #[ts(type = "Record<string, string[]>")]
    pub order: std::collections::BTreeMap<String, Vec<String>>,
}

/// Keeps the order a folder's contents were arranged in (`path` "" is the top level).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct FolderOrderParams {
    pub kind: String,
    pub path: String,
    pub order: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct FolderPathParams {
    pub kind: String,
    pub path: String,
}

/// Moves or renames a folder: `from` becomes `to` (a full path).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct FolderMoveParams {
    pub kind: String,
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct FolderMoved {
    pub path: String,
    /// How many records moved with it.
    #[ts(type = "number")]
    pub moved: usize,
}

/// Moves records into a folder; `null` or "" is the top level.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct MoveRecordsParams {
    pub ids: Vec<crate::Id>,
    #[serde(default)]
    pub folder: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct MoveFailure {
    pub id: crate::Id,
    pub error: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct MovedRecords {
    pub moved: Vec<Written>,
    pub failed: Vec<MoveFailure>,
}

fn some_option<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

/// A write's result: the record as written and the change's sequence number.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct Written {
    pub info: RecordInfo,
    #[ts(type = "number")]
    pub seq: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct SettingsParams {
    #[ts(type = "Record<string, unknown>")]
    pub values: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct FolderInfo {
    pub path: String,
    pub exists: bool,
    /// Nothing in it but hidden files.
    pub empty: bool,
    /// It already holds a Librarium library (`.librarium/library.json`).
    pub is_library: bool,
    /// Markdown files found (counting stops at 10,000).
    #[ts(type = "number")]
    pub markdown_files: u64,
    pub in_icloud: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct LogParams {
    /// "info", "warn" or "error".
    pub level: String,
    pub message: String,
}

/// Unsaved editor text, kept by the backend until its save succeeds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct Draft {
    pub id: crate::Id,
    /// The version the edit started from.
    pub base_version: String,
    /// The body at that version (for a three-way merge).
    pub base_body: String,
    pub body: String,
    #[serde(default)]
    #[ts(type = "number")]
    pub updated_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

/// A background job. Its payload holds IDs, not content.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct JobInfo {
    pub id: crate::Id,
    pub kind: String,
    /// Two requests with one key are one job.
    pub key: String,
    pub state: JobState,
    /// A short, calm description ("Rebuilding the index").
    pub title: String,
    #[ts(type = "number")]
    pub attempts: u32,
    pub error: Option<String>,
    /// 0 to 1, when known.
    pub progress: Option<f32>,
    pub message: Option<String>,
    #[ts(type = "unknown")]
    pub payload: serde_json::Value,
    #[ts(type = "number")]
    pub created_ms: i64,
    #[ts(type = "number")]
    pub updated_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct JobsList {
    pub running: Vec<JobInfo>,
    pub failed: Vec<JobInfo>,
    pub recent: Vec<JobInfo>,
    /// Shown once after a restart, e.g. "Resumed 3 saves".
    pub resumed: Option<String>,
}

/// A search result: a passage of a record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct SearchHit {
    pub id: crate::Id,
    pub kind: String,
    pub title: String,
    /// The passage with matches between U+0002 and U+0003.
    pub snippet: String,
    /// Where the passage starts in the record's text, in code points.
    #[ts(type = "number")]
    pub offset: i64,
    pub score: f64,
}

/// A record that links to another.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct Backlink {
    pub source: crate::Id,
    pub title: String,
    pub kind: String,
    /// The line around the link, links shown as labels.
    pub context: String,
    pub embed: bool,
}

/// A link with no usable ID, waiting for the user to choose its target.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct Unresolved {
    pub source: crate::Id,
    pub title: String,
    pub label: String,
}

/// One part of a capture: its W3C selectors, and an image of a region when it is one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct CapturePart {
    /// W3C Web Annotation selectors (TextQuoteSelector, TextPositionSelector, FragmentSelector…).
    #[ts(type = "unknown[]")]
    pub selector: Vec<serde_json::Value>,
    /// The quoted text of this part (empty for an image region).
    #[serde(default)]
    pub quote: String,
    /// "p. 3", a chapter's title…, for the citation.
    #[serde(default)]
    pub locator: Option<String>,
    /// A PNG of the region, base64-encoded.
    #[serde(default)]
    pub region_png: Option<String>,
    /// Where the part is drawn, to highlight it: boxes in percent of their page (with a
    /// 1-based `page` in a PDF) or of the image. Stored with the anchor; sources don't change.
    #[ts(type = "{ page?: number, x: number, y: number, w: number, h: number }[]")]
    #[serde(default)]
    pub boxes: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct CaptureParams {
    pub source: crate::Id,
    #[serde(default)]
    pub snapshot: Option<String>,
    /// The stored text the positions refer to.
    #[ts(type = "{ file: string, extractor: string, version: number } | null")]
    #[serde(default)]
    pub text: Option<serde_json::Value>,
    pub parts: Vec<CapturePart>,
    /// The user's own words.
    #[serde(default)]
    pub words: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct OrphanSidecar {
    pub path: String,
    pub id: Option<crate::Id>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ExportParams {
    /// A path the user chose.
    pub path: String,
    pub text: String,
}

/// A record's stored text, as derived views and anchors see it, with its segments (pages,
/// chapters). Offsets are code points.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct StoredText {
    pub text: String,
    pub segments: Vec<TextSegment>,
    /// Where the text is stored and what made it: `{file, extractor, version}` (absent for
    /// Markdown, whose text is the record itself).
    #[ts(type = "{ file: string, extractor: string, version: number } | null")]
    #[serde(default)]
    pub origin: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct TextSegment {
    /// "p. 3", or a chapter's title.
    pub label: String,
    #[ts(type = "number")]
    pub start: u64,
    #[ts(type = "number")]
    pub end: u64,
}
