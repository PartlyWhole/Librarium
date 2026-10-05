//! Boards: a note you can draw on (docs/plans/boards.md, decisions 0061 and 0062).
//!
//! A board is two files beside each other in the Notes folders:
//! - `<id>-<slug>.md`: the record (frontmatter, `kind: "board"`) and a readable page written by
//!   the app from the drawing (its texts, links and captures), so search, backlinks and other
//!   programs see what is on the board;
//! - `<id>.excalidraw`: the drawing, in Excalidraw's own JSON format.
//!
//! The record keeps the SHA-256 of the drawing its page was written from
//! (`boards.scene-sha256`). A save names the record version and drawing it was based on, and
//! is refused if either changed since. The drawing is written first, then the page: a save cut
//! short leaves the new drawing with the old page, which the next save rewrites.

use librarium_contracts::api::{BoardLoaded, BoardSaved, SaveResult, Written};
use librarium_contracts::{BackendError, Id, Result};
use librarium_kernel::frontmatter::FmValue;
use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::methods::{ApiMethod, MethodCtx};
use librarium_kernel::registry::{DuplicateId, Registry};
use librarium_kernel::writer::Lane;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const ID: &str = "boards";
pub const KIND: &str = "board";
/// The drawing's file, beside the record: `<id>.excalidraw`.
pub const SCENE: &str = ".excalidraw";
/// The SHA-256 of the drawing the readable page was written from.
pub const SCENE_SHA: &str = "boards.scene-sha256";
/// The notes' folder field: boards live in the Notes folders, so they share it.
pub const FOLDER_FIELD: &str = "notes.folder";

/// An empty drawing, in Excalidraw's file format.
pub const EMPTY_SCENE: &str = "{\n  \"type\": \"excalidraw\",\n  \"version\": 2,\n  \"source\": \"librarium\",\n  \"elements\": [],\n  \"appState\": {},\n  \"files\": {}\n}\n";

/// The readable page of a board with nothing on it yet.
pub fn empty_page(id: Id) -> String {
    format!("{}\n", page_note(id))
}

/// The line that opens every board's page: what it is, and that edits to it are replaced.
pub fn page_note(id: Id) -> String {
    format!(
        "<!-- Librarium writes this page from the board's drawing ({id}{SCENE}); edits here are replaced when the board is saved. -->"
    )
}

pub fn contribute_kinds(k: &mut Kinds) -> Result<(), DuplicateId> {
    k.add(
        ID,
        RecordKindDef {
            kind: KIND.into(),
            version: 1,
            format: Format::Markdown,
            // Beside notes, in their folders (stored as notes are).
            folder: "notes".into(),
            slugged: true,
            subfolder_field: Some(FOLDER_FIELD.into()),
        },
    )
}

#[derive(Deserialize)]
struct CreateParams {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    folder: Option<String>,
}

#[derive(Deserialize)]
struct IdParams {
    id: Id,
}

#[derive(Deserialize)]
struct SaveParams {
    id: Id,
    base_version: String,
    base_scene_sha: String,
    scene: String,
    page: String,
}

fn params<T: for<'de> Deserialize<'de>>(p: Value) -> Result<T> {
    serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))
}

pub fn contribute_methods(r: &mut Registry<ApiMethod>) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "boards.create",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: CreateParams = params(p)?;
            Ok(serde_json::to_value(create(ctx, p.title.as_deref().unwrap_or(""), p.folder.as_deref())?).unwrap())
        }),
    )?;
    r.add(
        ID,
        "boards.load",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: IdParams = params(p)?;
            Ok(serde_json::to_value(load(ctx, p.id)?).unwrap())
        }),
    )?;
    r.add(
        ID,
        "boards.save",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: SaveParams = params(p)?;
            Ok(serde_json::to_value(save(ctx, p.id, &p.base_version, &p.base_scene_sha, &p.scene, &p.page)?).unwrap())
        }),
    )?;
    Ok(())
}

/// The SHA-256 of a drawing, in lowercase hex.
pub fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Makes an empty board; an empty title becomes "Untitled board".
pub fn create(ctx: &MethodCtx, title: &str, folder: Option<&str>) -> Result<Written> {
    let title = if title.trim().is_empty() { "Untitled board".to_string() } else { title.to_string() };
    let folder = folder.map(|f| f.trim_matches('/').to_string()).filter(|f| !f.is_empty());
    let id = ctx.library.store.ids.next_id();
    let fields = vec![(SCENE_SHA.to_string(), FmValue::Str(sha(EMPTY_SCENE.as_bytes())))];
    let (e, seq) = ctx.library.write(Lane::Interactive, move |tx| {
        tx.create_with_sidecars_in(
            id,
            KIND,
            &title,
            fields,
            &empty_page(id),
            vec![(SCENE.into(), EMPTY_SCENE.as_bytes().to_vec())],
            folder.as_deref(),
        )
    })?;
    Ok(Written { info: e.info(), seq })
}

/// Where a board's drawing is: beside its record.
fn scene_path(ctx: &MethodCtx, rel: &str, id: Id) -> std::path::PathBuf {
    let s = &ctx.library.store;
    s.abs(rel).parent().map(|d| d.join(format!("{id}{SCENE}"))).unwrap_or_default()
}

fn board(ctx: &MethodCtx, id: Id) -> Result<librarium_kernel::store::Entry> {
    let e = ctx.library.store.get(id).ok_or_else(|| BackendError::not_found(format!("no board {id}")))?;
    if e.kind != KIND {
        return Err(BackendError::invalid(format!("{id} is a {}, not a board", e.kind)));
    }
    Ok(e)
}

/// Reads a board's drawing. A missing drawing is an empty one (the page says it is stale, so
/// the next save writes the drawing back).
fn read_scene(ctx: &MethodCtx, e: &librarium_kernel::store::Entry) -> Result<String> {
    let p = scene_path(ctx, &e.path, e.id);
    match ctx.library.store.fs.read(&p) {
        Ok(b) => String::from_utf8(b).map_err(|_| BackendError::invalid("the board's drawing isn't text")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(BackendError::io(format!("reading the board's drawing: {err}"))),
    }
}

/// Opens a board: its record and its drawing.
pub fn load(ctx: &MethodCtx, id: Id) -> Result<BoardLoaded> {
    let e = board(ctx, id)?;
    let stored = read_scene(ctx, &e)?;
    let missing = stored.is_empty();
    let scene = if missing { EMPTY_SCENE.to_string() } else { stored };
    let scene_sha = sha(scene.as_bytes());
    let written_from = e.fields.get(SCENE_SHA).and_then(Value::as_str);
    Ok(BoardLoaded {
        stale_page: missing || written_from != Some(scene_sha.as_str()),
        info: e.info(),
        scene,
        scene_sha,
    })
}

/// Saves a board: the drawing, then its readable page, both checked against what the save was
/// based on. Refused (a conflict, with the current version and drawing's SHA) if either changed.
pub fn save(
    ctx: &MethodCtx,
    id: Id,
    base_version: &str,
    base_scene_sha: &str,
    scene: &str,
    page: &str,
) -> Result<BoardSaved> {
    let (base_version, base_scene_sha, scene, page) =
        (base_version.to_string(), base_scene_sha.to_string(), scene.to_string(), page.to_string());
    if serde_json::from_str::<Value>(&scene).ok().and_then(|v| v.get("elements").map(Value::is_array)) != Some(true) {
        return Err(BackendError::invalid("that isn't an Excalidraw drawing"));
    }
    let e = board(ctx, id)?;
    let current_scene = read_scene(ctx, &e)?;
    let current_sha = sha(if current_scene.is_empty() { EMPTY_SCENE.as_bytes() } else { current_scene.as_bytes() });
    if e.hash != base_version || current_sha != base_scene_sha {
        return Err(BackendError::conflict("The board was changed elsewhere since it was opened.")
            .with_data(serde_json::json!({ "version": e.hash, "scene_sha": current_sha })));
    }
    let new_sha = sha(scene.as_bytes());
    let (entry, seq) = ctx.library.write(Lane::Interactive, move |tx| {
        // Checked again on the writer, where nothing can change in between.
        let now = tx.store.get(id).ok_or_else(|| BackendError::not_found(format!("no board {id}")))?;
        if now.hash != base_version {
            return Err(BackendError::conflict("The board was changed elsewhere since it was opened.")
                .with_data(serde_json::json!({ "version": now.hash })));
        }
        tx.write_sidecar(id, SCENE, scene.as_bytes())?;
        let version = match tx.save_body(id, &base_version, None, &page)? {
            SaveResult::Saved { version, .. } | SaveResult::Merged { version, .. } => version,
            SaveResult::Conflict { version, .. } => {
                return Err(BackendError::conflict("The board's page was changed elsewhere.")
                    .with_data(serde_json::json!({ "version": version })))
            }
        };
        tx.set_fields(id, Some(&version), &[(SCENE_SHA.to_string(), Some(FmValue::Str(sha(scene.as_bytes()))))])
    })?;
    Ok(BoardSaved { info: entry.info(), seq, scene_sha: new_sha })
}
