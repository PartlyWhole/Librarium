//! What crosses IPC: method parameters and results. Exported to `src/types.ts` by the
//! `export_types` test; field names are the interface's contract.

use crate::util::Id;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, TS)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub api_methods: Vec<String>,
}

/// A record as listed: its envelope and fields, never its body.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct RecordInfo {
    pub id: Id,
    pub kind: String,
    pub title: String,
    /// Library-relative path, `/`-separated.
    pub path: String,
    /// The content hash a save must be based on.
    pub version: String,
    pub created: Option<String>,
    /// Why the record can't be edited, when it can't.
    pub read_only: Option<String>,
    #[ts(type = "Record<string, unknown>")]
    pub fields: Map<String, Value>,
    /// Other files claiming this ID that look like sync conflicts, to compare.
    pub conflicts: Vec<String>,
}

/// A Markdown record with its body.
#[derive(Clone, Debug, Serialize, TS)]
pub struct RecordText {
    pub info: RecordInfo,
    /// The frontmatter text between the `---` lines.
    pub frontmatter: String,
    pub body: String,
}

/// A write's result: the record as written, and the change's number.
#[derive(Clone, Debug, Serialize, TS)]
pub struct Written {
    pub info: RecordInfo,
    pub seq: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum SaveResult {
    Saved {
        version: String,
        seq: u64,
    },
    /// The file changed since; an automatic three-way merge succeeded.
    Merged {
        version: String,
        body: String,
        seq: u64,
    },
    /// The file changed since and the edits overlap: both versions are shown.
    Conflict {
        version: String,
        body: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum StorePhase {
    /// The startup check is running.
    Checking,
    Ready,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct StoreStatus {
    pub phase: StorePhase,
    pub records: u64,
    /// "full": the kind of the last check.
    pub last_check: Option<String>,
    pub last_check_ms: u64,
    /// Files claiming another record's ID.
    pub duplicates: Vec<DuplicateInfo>,
    /// Records whose ID is missing or damaged, waiting for a quiet moment to be repaired.
    pub pending_repairs: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct DuplicateInfo {
    pub path: String,
    pub id: Id,
    /// "conflict" or "copy".
    pub class: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum LibraryState {
    /// No library folder chosen yet (first run).
    None,
    /// Opening, and checking the folder.
    Opening,
    Open,
    /// The chosen folder can't be found (e.g. an unmounted drive).
    Missing,
    /// Opening failed for another reason.
    Failed,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct LibraryStatus {
    pub state: LibraryState,
    pub path: Option<String>,
    pub id: Option<Id>,
    /// The folder is inside iCloud Drive (the app's own data stays outside it).
    pub in_icloud: bool,
    pub store: Option<StoreStatus>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct FolderInfo {
    pub path: String,
    pub exists: bool,
    /// Nothing in it but hidden files.
    pub empty: bool,
    /// It already holds a Librarium library (`.librarium/library.json`).
    pub is_library: bool,
    /// Markdown files found (counting stops at 10,000).
    pub markdown_files: u64,
    pub in_icloud: bool,
}

/// One kind's folders (`/`-separated paths, sorted) and the order the user arranged them in:
/// `{ folder: [record ID or "folder:<name>", …] }`, the top level as `""`. `kinds` lists every
/// kind kept in these folders, the space's own first (boards are kept beside notes).
#[derive(Clone, Debug, Serialize, TS)]
pub struct FolderSpace {
    pub kind: String,
    pub kinds: Vec<String>,
    pub folders: Vec<String>,
    #[ts(type = "Record<string, string[]>")]
    pub order: BTreeMap<String, Vec<String>>,
}

/// The user's folders, for each kind kept in folders.
#[derive(Clone, Debug, Serialize, TS)]
pub struct FoldersList {
    pub spaces: Vec<FolderSpace>,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct FolderMoved {
    pub path: String,
    /// How many records moved with it.
    pub moved: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct MoveFailure {
    pub id: Id,
    pub error: String,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct MovedRecords {
    pub moved: Vec<Written>,
    pub failed: Vec<MoveFailure>,
}

/// Unsaved editor text, kept until its save succeeds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct Draft {
    pub id: Id,
    /// The version the edit started from.
    pub base_version: String,
    /// The body at that version (for a three-way merge).
    pub base_body: String,
    pub body: String,
    #[serde(default)]
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
    pub id: Id,
    pub kind: String,
    /// Two requests with one key are one job.
    pub key: String,
    pub state: JobState,
    /// A short, calm description ("Rebuilding the index").
    pub title: String,
    pub attempts: u32,
    pub error: Option<String>,
    /// 0 to 1, when known.
    pub progress: Option<f32>,
    pub message: Option<String>,
    #[ts(type = "unknown")]
    pub payload: Value,
    pub created_ms: i64,
    pub updated_ms: i64,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct JobsList {
    pub running: Vec<JobInfo>,
    pub failed: Vec<JobInfo>,
    pub recent: Vec<JobInfo>,
    /// Shown once after a restart, e.g. "Resumed 3 saves".
    pub resumed: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct IndexStatus {
    pub ready: bool,
    /// The number of the last change indexed.
    pub applied: u64,
    pub progress: Option<f32>,
    pub views: Vec<String>,
}

/// A search result: a passage of a record.
#[derive(Clone, Debug, Serialize, TS)]
pub struct SearchHit {
    pub id: Id,
    pub kind: String,
    pub title: String,
    /// The passage with matches between U+0002 and U+0003.
    pub snippet: String,
    /// Where the passage starts in the record's text, in code points.
    pub offset: i64,
    pub score: f64,
}

/// A link to a record, from another.
#[derive(Clone, Debug, Serialize, TS)]
pub struct Backlink {
    pub source: Id,
    pub title: String,
    pub kind: String,
    /// The line around the link, links shown as labels.
    pub context: String,
    pub embed: bool,
    /// Where the link starts in the source's body, in code points.
    pub offset: i64,
}

/// A link with no usable ID, waiting for the user to choose its target.
#[derive(Clone, Debug, Serialize, TS)]
pub struct Unresolved {
    pub source: Id,
    pub title: String,
    pub label: String,
}

/// A record's stored text, as search and anchors see it, with its segments (pages, chapters).
/// Offsets are code points.
#[derive(Clone, Debug, Default, Serialize, TS)]
pub struct StoredText {
    pub text: String,
    pub segments: Vec<TextSegment>,
    /// Where the text is stored and what made it: `{file, extractor, version}` (absent for
    /// Markdown, whose text is the record itself).
    #[ts(type = "{ file: string, extractor: string, version: number, snapshot?: string } | null")]
    pub origin: Option<Value>,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct TextSegment {
    /// "p. 3", or a chapter's title.
    pub label: String,
    pub start: u64,
    pub end: u64,
}

/// A past version of a note.
#[derive(Clone, Debug, Serialize, TS)]
pub struct HistoryVersion {
    pub hash: String,
    pub ms: i64,
    /// `app`, `outside`, `before-restore` or `restore`.
    pub origin: String,
    pub size: u64,
    pub title: String,
    pub path: String,
    /// The same text as the file now.
    pub current: bool,
}

/// One line of a comparison: `equal`, `delete` (only in the old version) or `insert` (only now).
#[derive(Clone, Debug, Serialize, TS)]
pub struct DiffLine {
    pub op: String,
    pub text: String,
}

/// A note deleted outside the app, that its history can bring back.
#[derive(Clone, Debug, Serialize, TS)]
pub struct DeletedNote {
    pub id: Id,
    pub kind: String,
    pub title: String,
    pub path: String,
    pub ms: i64,
}

/// What a permanent deletion would remove, and the token that confirms it.
#[derive(Clone, Debug, Serialize, TS)]
pub struct DeletionPreview {
    pub token: String,
    pub records: Vec<DeletionRecord>,
    /// Files that go, in all.
    pub files: u64,
    pub expires_ms: i64,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct DeletionRecord {
    pub id: Id,
    pub title: String,
    pub kind: String,
    pub version: String,
    pub files: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, TS)]
pub struct Deleted {
    pub deleted: Vec<Id>,
    pub skipped: Vec<Skipped>,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct Skipped {
    pub id: Id,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct Resolved {
    pub changed: bool,
}

// ---- parameters ------------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, TS)]
pub struct PathParams {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct IdParams {
    pub id: Id,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct IdsParams {
    pub ids: Vec<Id>,
}

#[derive(Clone, Debug, Default, Deserialize, TS)]
pub struct ListParams {
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct CreateParams {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub fields: Map<String, Value>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub subfolder: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct SaveParams {
    pub id: Id,
    pub base_version: String,
    /// The body the edit started from, for a three-way merge.
    #[serde(default)]
    pub base_body: Option<String>,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct SetFieldsParams {
    pub id: Id,
    #[serde(default)]
    pub base_version: Option<String>,
    /// `null` removes a field.
    #[ts(type = "Record<string, unknown>")]
    pub fields: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct RelocateParams {
    pub id: Id,
    /// Refuse if the record changed since this version (undo).
    #[serde(default)]
    pub base_version: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Absent: keep the folder. `null` or "": the kind's top folder.
    #[serde(default, deserialize_with = "present")]
    #[ts(optional, type = "string | null")]
    pub subfolder: Option<Option<String>>,
}

fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct TextParams {
    pub id: Id,
    /// A web page's snapshot; absent for the latest.
    #[serde(default)]
    pub part: Option<String>,
}

/// Moves records into a folder; `null` or "" is the top level.
#[derive(Clone, Debug, Deserialize, TS)]
pub struct MoveRecordsParams {
    pub ids: Vec<Id>,
    #[serde(default)]
    pub folder: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct FolderPathParams {
    pub kind: String,
    pub path: String,
}

/// Moves or renames a folder: `from` becomes `to` (a full path).
#[derive(Clone, Debug, Deserialize, TS)]
pub struct FolderMoveParams {
    pub kind: String,
    pub from: String,
    pub to: String,
}

/// Keeps the order a folder's contents were arranged in (`path` "" is the top level).
#[derive(Clone, Debug, Deserialize, TS)]
pub struct FolderOrderParams {
    pub kind: String,
    pub path: String,
    pub order: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct SettingsParams {
    #[ts(type = "Record<string, unknown>")]
    pub values: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct LogParams {
    /// "info", "warn" or "error".
    pub level: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct UrlParams {
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct ExportParams {
    /// A path the user chose.
    pub path: String,
    /// What to write, as text…
    #[serde(default)]
    pub text: String,
    /// …or as bytes, in base64 (a picture), when given.
    #[serde(default)]
    pub data: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct HistoryParams {
    pub id: Id,
    pub hash: String,
    /// Required to restore: the version the note is at now.
    #[serde(default)]
    pub base_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct SearchParams {
    pub text: String,
    /// Only these kinds (all when empty), applied before the limit.
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, TS)]
pub struct UnresolvedParams {
    /// One record's unresolved links; every record's when absent.
    #[serde(default)]
    pub id: Option<Id>,
}

/// The user chose the target of an unresolved link: `[[label]]` becomes `[[label|target]]`.
#[derive(Clone, Debug, Deserialize, TS)]
pub struct ResolveParams {
    pub source: Id,
    pub label: String,
    pub target: Id,
}

#[derive(Clone, Debug, Default, Deserialize, TS)]
pub struct NoteParams {
    /// Empty: "Untitled".
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct ArchiveParams {
    pub id: Id,
    #[serde(default)]
    pub base_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
pub struct TokenParams {
    pub token: String,
}

/// Every exported type, in the order `src/types.ts` lists them.
pub fn typescript() -> String {
    use crate::error::{Code, Error};
    let cfg = ts_rs::Config::new().with_large_int("number");
    let mut out = String::from("// Generated from src-tauri/src/types.rs by `cargo test export_types`. Do not edit.\n");
    out.push_str("\n/** A record's permanent ID: a canonical UUID v7. */\nexport type Id = string;\n");
    macro_rules! export {
        ($($t:ty),* $(,)?) => {$(
            out.push('\n');
            if let Some(d) = <$t as TS>::docs() {
                out.push_str(&d);
            }
            out.push_str(&format!("export {}\n", <$t as TS>::decl(&cfg)));
        )*};
    }
    export!(
        Code,
        Error,
        AppInfo,
        RecordInfo,
        RecordText,
        Written,
        SaveResult,
        StorePhase,
        StoreStatus,
        DuplicateInfo,
        LibraryState,
        LibraryStatus,
        FolderInfo,
        FolderSpace,
        FoldersList,
        FolderMoved,
        MoveFailure,
        MovedRecords,
        Draft,
        JobState,
        JobInfo,
        JobsList,
        IndexStatus,
        SearchHit,
        Backlink,
        Unresolved,
        StoredText,
        TextSegment,
        HistoryVersion,
        DiffLine,
        DeletedNote,
        DeletionPreview,
        DeletionRecord,
        Deleted,
        Skipped,
        Resolved,
        PathParams,
        IdParams,
        IdsParams,
        ListParams,
        CreateParams,
        SaveParams,
        SetFieldsParams,
        RelocateParams,
        TextParams,
        MoveRecordsParams,
        FolderPathParams,
        FolderMoveParams,
        FolderOrderParams,
        SettingsParams,
        LogParams,
        UrlParams,
        ExportParams,
        HistoryParams,
        SearchParams,
        UnresolvedParams,
        ResolveParams,
        NoteParams,
        ArchiveParams,
        TokenParams,
    );
    out
}
