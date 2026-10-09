//! Failures that must leave the user's files alone: operations that stop part way, files that
//! went while the app was writing, and the library's own files it can't read.

mod common;

use common::{app, call, open, temp_dir};
use librarium::commands::dispatch;
use librarium::history::Origin;
use librarium::store::write::{write_intent, Intent};
use librarium::store::{repair::run_repairs, save, Library};
use serde_json::json;
use std::fs;
use std::path::Path;
use std::process::Command;

fn note(app: &librarium::app::App, title: &str, body: &str) -> serde_json::Value {
    call(app, "notes.create", json!({ "title": title, "body": body }))["info"].clone()
}

/// The unfinished operations waiting in app data.
fn intents(data: &Path) -> usize {
    let libs = fs::read_dir(data.join("libraries")).unwrap().flatten();
    libs.map(|l| fs::read_dir(l.path().join("intents")).map(|d| d.count()).unwrap_or(0)).sum()
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> =
        fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into()).collect();
    v.sort();
    v
}

fn lock(path: &Path, on: bool) {
    let flag = if on { "uchg" } else { "nouchg" };
    assert!(Command::new("chflags").arg(flag).arg(path).status().unwrap().success());
}

#[test]
fn a_failed_delete_never_deletes_the_note_later() {
    let d = temp_dir("delete");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let info = note(&app, "Keep me", "v1\n");
    let (id, path) = (info["id"].clone(), root.join(info["path"].as_str().unwrap()));
    call(&app, "archive.archive", json!({ "id": id }));
    lock(&path, true);
    let token = call(&app, "archive.prepareDelete", json!({ "ids": [id] }))["token"].clone();
    let r = call(&app, "archive.delete", json!({ "token": token }));
    lock(&path, false);
    assert_eq!(r["skipped"].as_array().unwrap().len(), 1);
    assert_eq!(intents(&data), 0, "nothing was removed, so nothing is left to finish");

    // Restored and edited since: even an intent left by a crash is not carried out.
    let confirmed = call(&app, "records.get", json!({ "id": id }))["version"].as_str().unwrap().to_string();
    let v = call(&app, "archive.restore", json!({ "id": id }))["info"]["version"].clone();
    call(&app, "records.save", json!({ "id": id, "base_version": v, "body": "new words\n" }));
    let stale = Intent::Delete {
        record: id.as_str().unwrap().parse().unwrap(),
        version: confirmed,
        files: vec![info["path"].as_str().unwrap().into()],
        folders: vec![],
    };
    write_intent(&app.library().unwrap().app_dir, &stale).unwrap();
    app.close();
    let app = open(&root, &data);
    assert!(path.exists());
    assert_eq!(call(&app, "records.read", json!({ "id": id }))["body"], "new words\n");
}

#[test]
fn history_lines_taken_at_once_are_all_kept() {
    let d = temp_dir("history");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let lib = Library::open(&root, &data, std::sync::Arc::new(|_: &str, _: serde_json::Value| {})).unwrap();
    let entries: Vec<_> =
        (0..2).map(|i| save::create(&lib.write(), "note", &format!("n{i}"), vec![], "x\n", None).unwrap()).collect();
    let log_lines = || -> usize {
        let logs = fs::read_dir(root.join(".librarium/history/log")).unwrap().flatten();
        logs.map(|f| fs::read_to_string(f.path()).unwrap().lines().count()).sum()
    };
    let before = log_lines();
    let n = 40;
    // As the ticker does, outside the write lock, while a save takes one inside it.
    let threads: Vec<_> = entries
        .into_iter()
        .map(|e| {
            let lib = lib.clone();
            std::thread::spawn(move || {
                for k in 0..n {
                    lib.history.take(&e, format!("{} {k}\n", e.id).as_bytes(), Origin::Outside);
                }
            })
        })
        .collect();
    threads.into_iter().for_each(|t| t.join().unwrap());
    assert_eq!(log_lines(), before + 2 * n);
}

#[test]
fn a_refused_rename_changes_nothing_and_leaves_nothing_to_redo() {
    let d = temp_dir("relocate");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(root.join("notes")).unwrap();
    let id = "0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44";
    let text = format!("---\nid: \"{id}\"\nkind: note\ntitle: >-\n  Folded\n---\nbody\n");
    fs::write(root.join(format!("notes/{id}-folded.md")), &text).unwrap();
    let app = open(&root, &data);
    let r = dispatch(&app, "records.relocate", json!({ "id": id, "title": "Renamed" }));
    assert_eq!(r.unwrap_err().code, librarium::error::Code::ReadOnly);
    assert_eq!(names(&root.join("notes")), vec![format!("{id}-folded.md")]);
    assert_eq!(fs::read_to_string(root.join(format!("notes/{id}-folded.md"))).unwrap(), text);
    assert_eq!(intents(&data), 0);

    // A later move stays where it was put after a restart.
    call(&app, "records.move", json!({ "ids": [id], "folder": "X" }));
    let before = call(&app, "records.get", json!({ "id": id }))["path"].clone();
    app.close();
    let app = open(&root, &data);
    assert_eq!(call(&app, "records.get", json!({ "id": id }))["path"], before);
}

#[test]
fn an_id_that_cant_be_written_leaves_the_file_where_it_is() {
    let d = temp_dir("identify");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(root.join("notes")).unwrap();
    let text = "---\nid: |\n  not-an-id\ntitle: \"X\"\n---\nbody\n";
    fs::write(root.join("notes/x.md"), text).unwrap();
    let app = open(&root, &data);
    let lib = app.library().unwrap();
    run_repairs(&lib.write());
    run_repairs(&lib.write());
    assert_eq!(names(&root.join("notes")), vec!["x.md".to_string()]);
    assert_eq!(fs::read_to_string(root.join("notes/x.md")).unwrap(), text);
    assert_eq!(intents(&data), 0);
    assert!(!lib.problems.lock().unwrap().has_repairs(), "not tried again until the file changes");
}

#[test]
fn files_of_a_record_that_has_gone_are_never_written_again() {
    let d = temp_dir("gone");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let info = call(&app, "boards.create", json!({ "title": "B" }))["info"].clone();
    let id = info["id"].as_str().unwrap().to_string();
    let md = root.join(info["path"].as_str().unwrap());
    let scene = md.with_file_name(format!("{id}.excalidraw"));
    fs::remove_file(&md).unwrap();
    fs::remove_file(&scene).unwrap();
    let empty = librarium::util::sha256(librarium::boards::EMPTY_SCENE.as_bytes());
    let r = dispatch(
        &app,
        "boards.save",
        json!({ "id": id, "base_version": info["version"], "base_scene_sha": empty,
                "scene": "{\"elements\":[]}", "page": "x\n" }),
    );
    assert_eq!(r.unwrap_err().code, librarium::error::Code::NotFound);
    assert!(!scene.exists() && !md.exists());
}

#[test]
fn library_json_is_never_rewritten() {
    let d = temp_dir("libjson");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(root.join(".librarium")).unwrap();
    let p = root.join(".librarium/library.json");
    let upper = "{\n  \"created\": \"2026-01-01T00:00:00Z\",\n  \"id\": \"0192F3A4-7C1E-7B2A-9F00-3E5D8C1A2B44\",\n  \"x.extra\": 1\n}\n";
    fs::write(&p, upper).unwrap();
    let a = open(&root, &data);
    assert_eq!(call(&a, "folder.status", json!({}))["id"], "0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44");
    a.close();
    assert_eq!(fs::read_to_string(&p).unwrap(), upper);

    // One that can't be read stops the library from opening.
    fs::write(&p, "{\"id\": ").unwrap();
    assert!(dispatch(&app(&data), "folder.open", json!({ "path": root })).is_err());
    assert_eq!(fs::read_to_string(&p).unwrap(), "{\"id\": ");
}

#[test]
fn order_json_keeps_what_it_doesnt_know_and_is_never_replaced_when_unreadable() {
    let d = temp_dir("order");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(root.join(".librarium")).unwrap();
    let app = open(&root, &data);
    let p = root.join(".librarium/order.json");
    fs::write(&p, "{\n  \"future\": {\"x\": 1},\n  \"notes\": {\n    \"\": [\"folder:A\"]\n  }\n}\n").unwrap();
    call(&app, "folders.setOrder", json!({ "kind": "item", "path": "", "order": ["folder:B"] }));
    let after: serde_json::Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    assert_eq!(after, json!({ "future": { "x": 1 }, "items": { "": ["folder:B"] }, "notes": { "": ["folder:A"] } }));

    fs::write(&p, "{\"notes\": ").unwrap();
    assert!(dispatch(&app, "folders.setOrder", json!({ "kind": "item", "path": "", "order": ["folder:C"] })).is_err());
    assert_eq!(fs::read_to_string(&p).unwrap(), "{\"notes\": ");
}
