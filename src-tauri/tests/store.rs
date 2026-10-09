//! The library folder: safe writes, crash recovery, duplicate IDs, saves against a changed
//! file, outside edits, and the fixture library surviving a round trip byte for byte.

mod common;

use common::{call, copy_dir, files, open, temp_dir};
use librarium::store::repair::{classify, run_repairs, DupClass};
use librarium::store::write::{safe_write, write_intent, Intent};
use librarium::util::parse_id;
use serde_json::json;
use std::fs;

fn note(app: &librarium::app::App, title: &str, body: &str) -> serde_json::Value {
    call(app, "records.create", json!({ "kind": "note", "title": title, "body": body }))["info"].clone()
}

#[test]
fn safe_writes_never_replace_by_surprise_and_leave_no_temp_files() {
    let d = temp_dir("safe");
    let p = d.join("a.md");
    safe_write(&p, b"one", true).unwrap();
    assert!(safe_write(&p, b"two", true).is_err(), "a new file never replaces one");
    safe_write(&p, b"three", false).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"three");
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1, "no temp file is left");

    // A temp file left by a crash is removed when the library opens.
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::write(root.join("notes/.x.md.librarium-tmp-1-1"), "half").unwrap();
    let _app = open(&root, &data);
    assert!(!root.join("notes/.x.md.librarium-tmp-1-1").exists());
}

#[test]
fn an_interrupted_rename_finishes_at_the_next_start() {
    let d = temp_dir("intent");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let info = note(&app, "Before", "text\n");
    let id = parse_id(info["id"].as_str().unwrap()).unwrap();
    let lib_dir = data.join("libraries").join(call(&app, "folder.status", json!({}))["id"].as_str().unwrap());
    call(&app, "folder.close", json!({}));

    // The app stopped after writing the intent and renaming the file, before the title.
    write_intent(&lib_dir, &Intent::Relocate { record: id, title: "After".into(), subfolder: Some("Moved".into()) })
        .unwrap();
    fs::create_dir_all(root.join("notes/Moved")).unwrap();
    fs::rename(root.join(info["path"].as_str().unwrap()), root.join(format!("notes/Moved/{id}-after.md"))).unwrap();

    let app = open(&root, &data);
    let r = call(&app, "records.get", json!({ "id": id }));
    assert_eq!(r["path"], format!("notes/Moved/{id}-after.md"));
    assert_eq!(r["title"], "After");
    assert_eq!(r["fields"]["notes.folder"], "Moved");
    assert_eq!(fs::read_dir(lib_dir.join("intents")).unwrap().count(), 0);
}

#[test]
fn duplicates_are_classified_and_copies_get_their_own_id() {
    let a = "---\nid: x\n---\nOne\nTwo\nThree\nFour\nFive\n";
    let b = "---\nid: x\n---\nOne\nTwo\nThree\nFour\nFive!\n";
    assert_eq!(classify("notes/x-other.md", a, b), DupClass::Conflict, "mostly the same text");
    assert_eq!(classify("notes/x copy.md", a, a), DupClass::Copy, "a Finder copy");
    assert_eq!(classify("notes/x-other.md", a, "---\nid: x\n---\nSomething else\n"), DupClass::Copy);
    assert_eq!(classify("notes/x 2.md", a, "totally different"), DupClass::Conflict, "iCloud's name");
    assert_eq!(classify("notes/x.sync-conflict-20261002.md", a, ""), DupClass::Conflict);

    let d = temp_dir("dups");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let info = note(&app, "Weil", "Attention is the rarest form of generosity.\n");
    let path = root.join(info["path"].as_str().unwrap());
    let conflict = path.with_file_name(format!("{} 2.md", info["id"].as_str().unwrap()));
    let copy = path.with_file_name("Weil copy.md");
    fs::copy(&path, &conflict).unwrap();
    fs::copy(&path, &copy).unwrap();
    call(&app, "folder.close", json!({}));

    let app = open(&root, &data);
    let r = call(&app, "records.get", json!({ "id": info["id"] }));
    assert_eq!(r["path"], info["path"], "the original keeps its place");
    assert_eq!(r["conflicts"].as_array().unwrap().len(), 1, "the conflict is shown to compare");
    let lib = app.library().unwrap();
    run_repairs(&lib.write());
    assert!(conflict.exists(), "a conflict is never rewritten");
    assert!(!copy.exists(), "the copy was renamed");
    let copies: Vec<_> = call(&app, "records.list", json!({}))
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["fields"]["copied-from"] == info["id"])
        .cloned()
        .collect();
    assert_eq!(copies.len(), 1);
    assert!(copies[0]["path"].as_str().unwrap().ends_with("-weil.md"));
}

#[test]
fn a_save_from_an_old_version_merges_or_conflicts() {
    let d = temp_dir("merge");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let base = "one\ntwo\nthree\n";
    let info = note(&app, "Merge", base);
    let (id, v0) = (info["id"].clone(), info["version"].clone());
    let path = root.join(info["path"].as_str().unwrap());

    // Changed outside since the editor read it.
    let outside = fs::read_to_string(&path).unwrap().replace("three", "THREE");
    fs::write(&path, &outside).unwrap();
    let r = call(
        &app,
        "records.save",
        json!({ "id": id, "base_version": v0, "base_body": base, "body": "ONE\ntwo\nthree\n" }),
    );
    assert_eq!(r["outcome"], "merged");
    assert_eq!(r["body"], "ONE\ntwo\nTHREE\n");
    assert!(fs::read_to_string(&path).unwrap().ends_with("---\nONE\ntwo\nTHREE\n"));

    // Overlapping edits are never merged silently, and nothing is written.
    let before = fs::read(&path).unwrap();
    let r =
        call(&app, "records.save", json!({ "id": id, "base_version": v0, "base_body": base, "body": "one\ntwo\n3\n" }));
    assert_eq!(r["outcome"], "conflict");
    assert_eq!(r["body"], "ONE\ntwo\nTHREE\n");
    assert_eq!(fs::read(&path).unwrap(), before);

    // A file that has gone is never re-created.
    fs::remove_file(&path).unwrap();
    let r = librarium::commands::dispatch(
        &app,
        "records.save",
        json!({ "id": id, "base_version": r["version"], "body": "x" }),
    );
    assert!(r.is_err());
    assert!(!path.exists());
}

#[test]
fn the_startup_check_notices_outside_edits() {
    let d = temp_dir("outside");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let info = note(&app, "Ellul", "Technique.\n");
    call(&app, "folder.close", json!({}));

    let path = root.join(info["path"].as_str().unwrap());
    let mut text = fs::read_to_string(&path).unwrap();
    text.push_str("Propaganda, written elsewhere.\n");
    fs::write(&path, text).unwrap();
    fs::write(root.join("notes/plain.md"), "# A plain file\nNo frontmatter.\n").unwrap();

    let app = open(&root, &data);
    let r = call(&app, "records.read", json!({ "id": info["id"] }));
    assert_eq!(r["body"], "Technique.\nPropaganda, written elsewhere.\n");
    let hits = call(&app, "search.query", json!({ "text": "propag" }));
    assert_eq!(hits[0]["id"], info["id"]);
    let versions = call(&app, "history.versions", json!({ "id": info["id"] }));
    assert_eq!(versions[0]["origin"], "outside");
    assert_eq!(versions[0]["current"], true);
    assert_eq!(call(&app, "folder.status", json!({}))["store"]["pending_repairs"], 1, "the plain file waits for an ID");
}

#[test]
fn the_fixture_library_survives_a_round_trip_byte_for_byte() {
    let d = temp_dir("fixture");
    let (root, data) = (d.join("lib"), d.join("data"));
    copy_dir(&std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/library")), &root);
    let before = files(&root);
    let app = open(&root, &data);

    let list = call(&app, "records.list", json!({}));
    let kinds: Vec<&str> = list.as_array().unwrap().iter().map(|r| r["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds.len(), 5);
    for k in ["note", "board", "capture", "item"] {
        assert!(kinds.contains(&k), "{k} in {kinds:?}");
    }
    for r in list.as_array().unwrap() {
        assert!(r["read_only"].is_null(), "{}", r["path"]);
        let id = &r["id"];
        let archived = call(&app, "archive.archive", json!({ "id": id, "base_version": r["version"] }));
        call(&app, "archive.restore", json!({ "id": id, "base_version": archived["info"]["version"] }));
        if r["path"].as_str().unwrap().ends_with(".md") {
            let t = call(&app, "records.read", json!({ "id": id }));
            let saved = call(
                &app,
                "records.save",
                json!({ "id": id, "base_version": t["info"]["version"], "body": t["body"] }),
            );
            assert_eq!(saved["version"], r["version"]);
        }
    }
    // The essay's text is searchable; links and backlinks are found.
    assert_eq!(call(&app, "search.query", json!({ "text": "escapes", "kinds": ["item"] }))[0]["title"], "essay");
    let back = call(&app, "links.backlinks", json!({ "id": "0192f3b0-0000-7000-8000-000000000001" }));
    assert_eq!(back.as_array().unwrap().len(), 2);
    let unresolved = call(&app, "links.unresolved", json!({}));
    assert_eq!(unresolved[0]["label"], "an unresolved idea");
    assert_eq!(
        call(&app, "records.text", json!({ "id": "0192e7c2-0000-7000-8000-0000000000aa" }))["segments"][0]["label"],
        "p. 1"
    );
    call(&app, "folder.close", json!({}));
    assert_eq!(files(&root), before, "every file is byte for byte as it was");
}
