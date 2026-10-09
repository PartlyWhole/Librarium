//! Boards: a note you can draw on, as two files beside each other in the Notes folders.
//!
//! - `<id>-<slug>.md`: the record (`kind: "board"`), with a readable page the interface writes
//!   from the drawing (its texts, links and captures), so search, backlinks and other programs
//!   see what is on the board.
//! - `<id>.excalidraw`: the drawing, in Excalidraw's own format.
//!
//! `boards.scene-sha256` is the SHA-256 of the drawing the page was written from. A save is
//! refused if the record or the drawing changed since it was opened. The drawing is written
//! first, then the page, then the SHA: a save cut short leaves a stale page, which the next
//! save rewrites.

use crate::error::{Error, Result};
use crate::store::frontmatter::FmValue;
use crate::store::{files, record, Library};
use crate::types::{BoardLoaded, BoardSaveParams, BoardSaved, SaveResult, Written};
use crate::util::{new_id, sha256, Id};
use serde_json::Value;

pub const KIND: &str = "board";
/// The drawing's file, beside the record: `<id>.excalidraw`.
pub const SCENE: &str = ".excalidraw";
pub const SCENE_SHA: &str = "boards.scene-sha256";

/// An empty drawing, in Excalidraw's file format.
pub const EMPTY_SCENE: &str = "{\n  \"type\": \"excalidraw\",\n  \"version\": 2,\n  \"source\": \"librarium\",\n  \"elements\": [],\n  \"appState\": {},\n  \"files\": {}\n}\n";

/// The line that opens every board's page: what it is, and that edits to it are replaced.
pub fn page_note(id: Id) -> String {
    format!(
        "<!-- Librarium writes this page from the board's drawing ({id}{SCENE}); edits here are replaced when the board is saved. -->"
    )
}

/// Makes an empty board; an empty title becomes "Untitled board".
pub fn create(lib: &Library, title: Option<&str>, folder: Option<&str>) -> Result<Written> {
    let title = title.map(str::trim).filter(|t| !t.is_empty()).unwrap_or("Untitled board");
    let id = new_id();
    let fields = vec![(SCENE_SHA.to_string(), FmValue::Str(sha256(EMPTY_SCENE.as_bytes())))];
    let sidecars = [(SCENE.to_string(), EMPTY_SCENE.as_bytes().to_vec())];
    let page = format!("{}\n", page_note(id));
    let w = lib.write();
    let e = record::create_with_sidecars(&w, id, KIND, title, fields, &page, folder, &sidecars)?;
    Ok(Written { info: record::info(lib, &e), seq: w.seq() })
}

fn board(lib: &Library, id: Id) -> Result<record::Entry> {
    lib.index.get(id).filter(|e| e.kind == KIND).ok_or_else(|| Error::not_found("That board can’t be found."))
}

/// The board's drawing; a missing one is the empty drawing.
fn read_scene(lib: &Library, e: &record::Entry) -> Result<String> {
    match std::fs::read(e.dir(lib).join(format!("{}{SCENE}", e.id))) {
        Ok(b) => String::from_utf8(b).map_err(|_| Error::invalid("The board’s drawing isn’t text.")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(EMPTY_SCENE.to_string()),
        Err(err) => Err(Error::io(format!("reading the board’s drawing: {err}"))),
    }
}

/// Opens a board: its record and its drawing, and whether the page was written from it.
pub fn load(lib: &Library, id: Id) -> Result<BoardLoaded> {
    let e = board(lib, id)?;
    let scene = read_scene(lib, &e)?;
    let scene_sha = sha256(scene.as_bytes());
    let stale_page = e.field_str(SCENE_SHA) != Some(scene_sha.as_str());
    Ok(BoardLoaded { info: record::info(lib, &e), scene, scene_sha, stale_page })
}

/// Saves the drawing, then its readable page, then the drawing's SHA, all checked against
/// what the save was based on.
pub fn save(lib: &Library, p: BoardSaveParams) -> Result<BoardSaved> {
    let is_drawing = serde_json::from_str::<Value>(&p.scene).ok().is_some_and(|v| v["elements"].is_array());
    if !is_drawing {
        return Err(Error::invalid("That isn’t an Excalidraw drawing."));
    }
    let changed = || Error::conflict("The board was changed elsewhere since it was opened.");
    let w = lib.write();
    let e = board(lib, p.id)?;
    if e.hash != p.base_version || sha256(read_scene(lib, &e)?.as_bytes()) != p.base_scene_sha {
        return Err(changed());
    }
    files::write_sidecar(&w, p.id, SCENE, p.scene.as_bytes())?;
    let version = match record::save_body(&w, p.id, &p.base_version, None, &p.page)? {
        SaveResult::Saved { version, .. } | SaveResult::Merged { version, .. } => version,
        SaveResult::Conflict { .. } => return Err(changed()),
    };
    let scene_sha = sha256(p.scene.as_bytes());
    let edits = [(SCENE_SHA.to_string(), Some(FmValue::Str(scene_sha.clone())))];
    let e = record::set_fields(&w, p.id, Some(&version), &edits)?;
    Ok(BoardSaved { info: record::info(lib, &e), seq: w.seq(), scene_sha })
}
