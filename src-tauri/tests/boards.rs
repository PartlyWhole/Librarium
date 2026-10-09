//! Boards: two files beside notes. A save writes the drawing, then the page, then the
//! drawing's SHA; a save cut short after the drawing leaves a page known to be stale.

mod common;

use common::{call, open, temp_dir};
use librarium::boards::{page_note, EMPTY_SCENE};
use librarium::commands::dispatch;
use librarium::error::Code;
use librarium::util::{parse_id, sha256};
use serde_json::json;
use std::fs;

const DRAWING: &str = r#"{"type":"excalidraw","version":2,"source":"librarium","elements":[{"id":"a","type":"rectangle"}],"appState":{},"files":{}}"#;

#[test]
fn a_board_saves_its_drawing_then_its_page_then_the_sha() {
    let d = temp_dir("board");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let w = call(&app, "boards.create", json!({ "title": "Map of Ellul", "folder": "Thinkers" }));
    let id = w["info"]["id"].as_str().unwrap().to_string();
    assert_eq!(w["info"]["path"], format!("notes/Thinkers/{id}-map-of-ellul.md"));
    let scene_file = root.join(format!("notes/Thinkers/{id}.excalidraw"));
    assert_eq!(fs::read_to_string(&scene_file).unwrap(), EMPTY_SCENE);
    let md = fs::read_to_string(root.join(w["info"]["path"].as_str().unwrap())).unwrap();
    let created = w["info"]["created"].as_str().unwrap();
    let note = page_note(parse_id(&id).unwrap());
    assert_eq!(
        md,
        format!(
            "---\nid: \"{id}\"\nkind: \"board\"\nkind-version: 1\ncreated: \"{created}\"\ntitle: \"Map of Ellul\"\nboards.scene-sha256: \"{}\"\nnotes.folder: \"Thinkers\"\n---\n{note}\n",
            sha256(EMPTY_SCENE.as_bytes())
        )
    );

    let loaded = call(&app, "boards.load", json!({ "id": id }));
    assert_eq!(loaded["stale_page"], false);
    assert_eq!(loaded["scene_sha"], sha256(EMPTY_SCENE.as_bytes()));

    let page = format!("{note}\n\nA rectangle\n");
    let saved = call(
        &app,
        "boards.save",
        json!({ "id": id, "base_version": loaded["info"]["version"], "base_scene_sha": loaded["scene_sha"], "scene": DRAWING, "page": page }),
    );
    assert_eq!(fs::read_to_string(&scene_file).unwrap(), DRAWING);
    assert_eq!(saved["scene_sha"], sha256(DRAWING.as_bytes()));
    assert_eq!(saved["info"]["fields"]["boards.scene-sha256"], sha256(DRAWING.as_bytes()));
    let r = call(&app, "records.read", json!({ "id": id }));
    assert_eq!(r["body"], page);

    // Saving from what was opened before is refused: the board changed since.
    let stale = json!({ "id": id, "base_version": loaded["info"]["version"], "base_scene_sha": loaded["scene_sha"], "scene": EMPTY_SCENE, "page": "" });
    assert_eq!(dispatch(&app, "boards.save", stale).unwrap_err().code, Code::Conflict);
    assert_eq!(fs::read_to_string(&scene_file).unwrap(), DRAWING, "nothing was written");

    // Cut short after the drawing: the page is known to be stale, and the next save mends it.
    let newer = DRAWING.replace("rectangle", "ellipse");
    fs::write(&scene_file, &newer).unwrap();
    let loaded = call(&app, "boards.load", json!({ "id": id }));
    assert_eq!((loaded["stale_page"].as_bool(), loaded["scene"].as_str()), (Some(true), Some(newer.as_str())));
    let saved = call(
        &app,
        "boards.save",
        json!({ "id": id, "base_version": loaded["info"]["version"], "base_scene_sha": loaded["scene_sha"], "scene": newer, "page": format!("{note}\n\nAn ellipse\n") }),
    );
    assert_eq!(saved["info"]["fields"]["boards.scene-sha256"], sha256(newer.as_bytes()));
    assert_eq!(call(&app, "boards.load", json!({ "id": id }))["stale_page"], false);
}
