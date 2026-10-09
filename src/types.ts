// Generated from src-tauri/src/types.rs by `cargo test export_types`. Do not edit.

/** A record's permanent ID: a canonical UUID v7. */
export type Id = string;

export type ErrorCode = "no_library" | "not_found" | "conflict" | "read_only" | "invalid" | "io" | "cancelled";

export type BackendError = { code: ErrorCode, message: string, };

export type AppInfo = { name: string, version: string, api_methods: Array<string>, };

/**
 * A record as listed: its envelope and fields, never its body.
 */
export type RecordInfo = { id: string, kind: string, title: string, 
/**
 * Library-relative path, `/`-separated.
 */
path: string, 
/**
 * The content hash a save must be based on.
 */
version: string, created: string | null, 
/**
 * Why the record can't be edited, when it can't.
 */
read_only: string | null, fields: Record<string, unknown>, 
/**
 * Other files claiming this ID that look like sync conflicts, to compare.
 */
conflicts: Array<string>, };

/**
 * A Markdown record with its body.
 */
export type RecordText = { info: RecordInfo, 
/**
 * The frontmatter text between the `---` lines.
 */
frontmatter: string, body: string, };

/**
 * A write's result: the record as written, and the change's number.
 */
export type Written = { info: RecordInfo, seq: number, };

export type SaveResult = { "outcome": "saved", version: string, seq: number, } | { "outcome": "merged", version: string, body: string, seq: number, } | { "outcome": "conflict", version: string, body: string, };

export type StorePhase = "checking" | "ready";

export type StoreStatus = { phase: StorePhase, records: number, 
/**
 * "full": the kind of the last check.
 */
last_check: string | null, last_check_ms: number, 
/**
 * Files claiming another record's ID.
 */
duplicates: Array<DuplicateInfo>, 
/**
 * Records whose ID is missing or damaged, waiting for a quiet moment to be repaired.
 */
pending_repairs: number, };

export type DuplicateInfo = { path: string, id: string, 
/**
 * "conflict" or "copy".
 */
class: string, };

export type LibraryState = "none" | "opening" | "open" | "missing" | "failed";

export type LibraryStatus = { state: LibraryState, path: string | null, id: string | null, 
/**
 * The folder is inside iCloud Drive (the app's own data stays outside it).
 */
in_icloud: boolean, store: StoreStatus | null, error: string | null, };

export type FolderInfo = { path: string, exists: boolean, 
/**
 * Nothing in it but hidden files.
 */
empty: boolean, 
/**
 * It already holds a Librarium library (`.librarium/library.json`).
 */
is_library: boolean, 
/**
 * Markdown files found (counting stops at 10,000).
 */
markdown_files: number, in_icloud: boolean, };

/**
 * One kind's folders (`/`-separated paths, sorted) and the order the user arranged them in:
 * `{ folder: [record ID or "folder:<name>", …] }`, the top level as `""`. `kinds` lists every
 * kind kept in these folders, the space's own first (boards are kept beside notes).
 */
export type FolderSpace = { kind: string, kinds: Array<string>, folders: Array<string>, order: Record<string, string[]>, };

/**
 * The user's folders, for each kind kept in folders.
 */
export type FoldersList = { spaces: Array<FolderSpace>, };

export type FolderMoved = { path: string, 
/**
 * How many records moved with it.
 */
moved: number, };

export type MoveFailure = { id: string, error: string, };

export type MovedRecords = { moved: Array<Written>, failed: Array<MoveFailure>, };

/**
 * Unsaved editor text, kept until its save succeeds.
 */
export type Draft = { id: string, 
/**
 * The version the edit started from.
 */
base_version: string, 
/**
 * The body at that version (for a three-way merge).
 */
base_body: string, body: string, updated_ms: number, };

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * A background job. Its payload holds IDs, not content.
 */
export type JobInfo = { id: string, kind: string, 
/**
 * Two requests with one key are one job.
 */
key: string, state: JobState, 
/**
 * A short, calm description ("Rebuilding the index").
 */
title: string, attempts: number, error: string | null, 
/**
 * 0 to 1, when known.
 */
progress: number | null, message: string | null, payload: unknown, created_ms: number, updated_ms: number, };

export type JobsList = { running: Array<JobInfo>, failed: Array<JobInfo>, recent: Array<JobInfo>, 
/**
 * Shown once after a restart, e.g. "Resumed 3 saves".
 */
resumed: string | null, };

export type IndexStatus = { ready: boolean, 
/**
 * The number of the last change indexed.
 */
applied: number, progress: number | null, views: Array<string>, };

/**
 * A search result: a passage of a record.
 */
export type SearchHit = { id: string, kind: string, title: string, 
/**
 * The passage with matches between U+0002 and U+0003.
 */
snippet: string, 
/**
 * Where the passage starts in the record's text, in code points.
 */
offset: number, score: number, };

/**
 * A link to a record, from another.
 */
export type Backlink = { source: string, title: string, kind: string, 
/**
 * The line around the link, links shown as labels.
 */
context: string, embed: boolean, 
/**
 * Where the link starts in the source's body, in code points.
 */
offset: number, };

/**
 * A link with no usable ID, waiting for the user to choose its target.
 */
export type Unresolved = { source: string, title: string, label: string, };

/**
 * A record's stored text, as search and anchors see it, with its segments (pages, chapters).
 * Offsets are code points.
 */
export type StoredText = { text: string, segments: Array<TextSegment>, 
/**
 * Where the text is stored and what made it: `{file, extractor, version}` (absent for
 * Markdown, whose text is the record itself).
 */
origin: { file: string, extractor: string, version: number, snapshot?: string } | null, };

export type TextSegment = { 
/**
 * "p. 3", or a chapter's title.
 */
label: string, start: number, end: number, };

/**
 * A past version of a note.
 */
export type HistoryVersion = { hash: string, ms: number, 
/**
 * `app`, `outside`, `before-restore` or `restore`.
 */
origin: string, size: number, title: string, path: string, 
/**
 * The same text as the file now.
 */
current: boolean, };

/**
 * One line of a comparison: `equal`, `delete` (only in the old version) or `insert` (only now).
 */
export type DiffLine = { op: string, text: string, };

/**
 * A note deleted outside the app, that its history can bring back.
 */
export type DeletedNote = { id: string, kind: string, title: string, path: string, ms: number, };

/**
 * What a permanent deletion would remove, and the token that confirms it.
 */
export type DeletionPreview = { token: string, records: Array<DeletionRecord>, 
/**
 * Files that go, in all.
 */
files: number, expires_ms: number, };

export type DeletionRecord = { id: string, title: string, kind: string, version: string, files: Array<string>, };

export type Deleted = { deleted: Array<string>, skipped: Array<Skipped>, };

export type Skipped = { id: string, reason: string, };

export type Resolved = { changed: boolean, };

export type PathParams = { path: string, };

export type IdParams = { id: string, };

export type IdsParams = { ids: Array<string>, };

export type ListParams = { kind: string | null, };

export type CreateParams = { kind: string, title: string, fields: Record<string, unknown>, body: string, subfolder: string | null, };

export type SaveParams = { id: string, base_version: string, 
/**
 * The body the edit started from, for a three-way merge.
 */
base_body: string | null, body: string, };

export type SetFieldsParams = { id: string, base_version: string | null, 
/**
 * `null` removes a field.
 */
fields: Record<string, unknown>, };

export type RelocateParams = { id: string, 
/**
 * Refuse if the record changed since this version (undo).
 */
base_version: string | null, title: string | null, 
/**
 * Absent: keep the folder. `null` or "": the kind's top folder.
 */
subfolder?: string | null, };

export type TextParams = { id: string, 
/**
 * A web page's snapshot; absent for the latest.
 */
part: string | null, };

/**
 * Moves records into a folder; `null` or "" is the top level.
 */
export type MoveRecordsParams = { ids: Array<string>, folder: string | null, };

export type FolderPathParams = { kind: string, path: string, };

/**
 * Moves or renames a folder: `from` becomes `to` (a full path).
 */
export type FolderMoveParams = { kind: string, from: string, to: string, };

/**
 * Keeps the order a folder's contents were arranged in (`path` "" is the top level).
 */
export type FolderOrderParams = { kind: string, path: string, order: Array<string>, };

export type SettingsParams = { values: Record<string, unknown>, };

export type LogParams = { 
/**
 * "info", "warn" or "error".
 */
level: string, message: string, };

export type UrlParams = { url: string, };

export type ExportParams = { 
/**
 * A path the user chose.
 */
path: string, 
/**
 * What to write, as text…
 */
text: string, 
/**
 * …or as bytes, in base64 (a picture), when given.
 */
data: string | null, };

export type HistoryParams = { id: string, hash: string, 
/**
 * Required to restore: the version the note is at now.
 */
base_version: string | null, };

export type SearchParams = { text: string, 
/**
 * Only these kinds (all when empty), applied before the limit.
 */
kinds: Array<string>, limit: number | null, };

export type UnresolvedParams = { 
/**
 * One record's unresolved links; every record's when absent.
 */
id: string | null, };

/**
 * The user chose the target of an unresolved link: `[[label]]` becomes `[[label|target]]`.
 */
export type ResolveParams = { source: string, label: string, target: string, };

export type NoteParams = { 
/**
 * Empty: "Untitled".
 */
title: string | null, folder: string | null, body: string, };

export type ArchiveParams = { id: string, base_version: string | null, };

export type TokenParams = { token: string, };
