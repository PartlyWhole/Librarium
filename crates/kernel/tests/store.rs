//! The store against the durability-modelling fakes.
mod common;

use common::*;
use librarium_contracts::api::SaveResult;
use librarium_contracts::events::{ChangeOp, ChangeOrigin};
use librarium_contracts::ports::FileSystem;
use librarium_contracts::ErrorCode;
use librarium_kernel::frontmatter::FmValue;
use librarium_kernel::writer::Lane;

fn create(lib: &librarium_kernel::library::Library, title: &str, body: &str) -> librarium_kernel::store::Entry {
    let (t, b) = (title.to_string(), body.to_string());
    lib.write(Lane::Interactive, move |tx| tx.create("page", &t, vec![], &b, None)).unwrap().0
}

#[test]
fn create_read_save_rename_move() {
    let h = H::new();
    let lib = h.open();
    assert_eq!(lib.startup.mode, "full");
    let e = create(&lib, "Jacques Ellul", "Notes on technique.\n");
    assert_eq!(e.path, format!("pages/{}-jacques-ellul.md", e.id));
    let text = h.read(&e.path);
    assert!(text.starts_with(&format!("---\nid: \"{}\"\nkind: \"page\"\nkind-version: 1\ncreated: \"2026-10-02T09:14:00Z\"\ntitle: \"Jacques Ellul\"\n---\n", e.id)), "{text}");

    // save with the right base version
    let id = e.id;
    let v = e.hash.clone();
    let r = lib.write(Lane::Interactive, move |tx| tx.save_body(id, &v, None, "Edited.\n")).unwrap();
    let SaveResult::Saved { version, .. } = r else { panic!("{r:?}") };
    assert!(h.read(&e.path).ends_with("---\nEdited.\n"));

    // rename: the slug follows the title
    let (e2, _) = lib.write(Lane::Interactive, move |tx| tx.relocate(id, Some("Ellul, Jacques"), None)).unwrap();
    assert_eq!(e2.path, format!("pages/{id}-ellul-jacques.md"));
    assert!(h.read(&e2.path).contains("title: \"Ellul, Jacques\"\n"));
    assert_eq!(h.store_files(), std::slice::from_ref(&e2.path));

    // move into a subfolder: the folder field mirrors it
    let (e3, _) = lib.write(Lane::Interactive, move |tx| tx.relocate(id, None, Some(Some("Thinkers/French")))).unwrap();
    assert_eq!(e3.path, format!("pages/Thinkers/French/{id}-ellul-jacques.md"));
    assert!(h.read(&e3.path).contains("test.folder: \"Thinkers/French\"\n"));

    // a stale version is never written over
    let r = lib.write(Lane::Interactive, move |tx| tx.save_body(id, &version, None, "Stale!\n")).unwrap();
    assert!(matches!(r, SaveResult::Conflict { .. }), "{r:?}");
    assert!(h.read(&e3.path).ends_with("Edited.\n"));

    let ops: Vec<_> = h.changes.lock().unwrap().iter().map(|c| (c.op, c.origin)).collect();
    assert_eq!(ops[0], (ChangeOp::Created, ChangeOrigin::App));
    assert!(ops.contains(&(ChangeOp::Renamed, ChangeOrigin::App)));
    let seqs: Vec<_> = h.changes.lock().unwrap().iter().map(|c| c.seq).collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "numbered in order: {seqs:?}");
}

#[test]
fn three_way_merge_on_save() {
    let h = H::new();
    let lib = h.open();
    let e = create(&lib, "Merge", "one\ntwo\nthree\nfour\n");
    let base_body = "one\ntwo\nthree\nfour\n".to_string();
    // Someone edits the end of the file outside.
    let outside = h.read(&e.path).replace("four\n", "four (outside)\n");
    h.outside_write(&e.path, &outside);
    settle(&lib);
    let (id, v, b) = (e.id, e.hash.clone(), base_body.clone());
    let r = lib.write(Lane::Interactive, move |tx| tx.save_body(id, &v, Some(&b), "ONE\ntwo\nthree\nfour\n")).unwrap();
    match r {
        SaveResult::Merged { body, .. } => assert_eq!(body, "ONE\ntwo\nthree\nfour (outside)\n"),
        other => panic!("{other:?}"),
    }
    // Overlapping edits are refused and both versions shown.
    let cur = lib.store.read_text(id).unwrap();
    let v = cur.info.version.clone();
    h.outside_write(&e.path, &h.read(&e.path).replace("ONE", "uno"));
    settle(&lib);
    let r = lib
        .write(Lane::Interactive, move |tx| {
            tx.save_body(id, &v, Some("ONE\ntwo\nthree\nfour (outside)\n"), "eins\ntwo\nthree\nfour (outside)\n")
        })
        .unwrap();
    match r {
        SaveResult::Conflict { body, .. } => assert!(body.starts_with("uno")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_gone_file_is_never_recreated() {
    let h = H::new();
    let lib = h.open();
    let e = create(&lib, "Doomed", "x\n");
    h.fs.remove_outside(&h.abs(&e.path));
    let (id, v) = (e.id, e.hash.clone());
    let err = lib.write(Lane::Interactive, move |tx| tx.save_body(id, &v, None, "y\n")).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert!(h.fs.stat(&h.abs(&e.path)).unwrap().is_none());
}

#[test]
fn round_trips_preserve_unknown_keys_comments_and_order() {
    let h = H::new();
    let id = "0192f3a4-7c1e-7b2a-9f00-0000000000aa";
    let original = format!(
        "---\n# kept comment\nkind: page\nid: \"{id}\"\nzeta: 1   # trailing\ntitle: 'Hand written'\nweird.key: {{a: [1, 2]}}\ntags:\n  - a\n  - b\nkind-version: 1\n---\nBody stays.\n"
    );
    h.fs.write_outside(&h.abs(&format!("pages/{id}-hand-written.md")), original.as_bytes());
    let lib = h.open();
    let rel = format!("pages/{id}-hand-written.md");
    let idv = id.parse().unwrap();
    // A no-op save changes nothing.
    let v = lib.store.get(idv).unwrap().hash;
    lib.write(Lane::Interactive, move |tx| tx.save_body(idv, &v, None, "Body stays.\n")).unwrap();
    assert_eq!(h.read(&rel), original);
    // Setting a module field changes only that key's bytes.
    lib.write(Lane::Interactive, move |tx| tx.set_fields(idv, None, &[("x.flag".into(), Some(FmValue::Bool(true)))]))
        .unwrap();
    assert_eq!(h.read(&rel), original.replace("kind-version: 1\n---", "kind-version: 1\nx.flag: true\n---"));
    lib.write(Lane::Interactive, move |tx| tx.set_fields(idv, None, &[("zeta".into(), Some(FmValue::Int(2)))]))
        .unwrap();
    assert!(h.read(&rel).contains("zeta: 2   # trailing\n"));
    // Renaming changes the title's bytes (and the file name) only.
    let (e, _) = lib.write(Lane::Interactive, move |tx| tx.relocate(idv, Some("Renamed"), None)).unwrap();
    let expect = original
        .replace("kind-version: 1\n---", "kind-version: 1\nx.flag: true\n---")
        .replace("zeta: 1", "zeta: 2")
        .replace("'Hand written'", "\"Renamed\"");
    assert_eq!(h.read(&e.path), expect);
}

#[test]
fn unknown_kinds_newer_versions_and_bad_frontmatter_are_kept_read_only() {
    let h = H::new();
    let a = "---\nid: \"0192f3a4-7c1e-7b2a-9f00-0000000000a1\"\nkind: poem\n---\nverse\n";
    let b = "---\nid: \"0192f3a4-7c1e-7b2a-9f00-0000000000a2\"\nkind: page\nkind-version: 7\n---\nfuture\n";
    let c = "---\nid: \"0192f3a4-7c1e-7b2a-9f00-0000000000a3\"\ntitle: [unclosed\n---\nbroken\n";
    for (n, t) in [("a", a), ("b", b), ("c", c)] {
        h.fs.write_outside(&h.abs(&format!("pages/{n}.md")), t.as_bytes());
    }
    let lib = h.open();
    for (n, t, last) in [("a", a, "a1"), ("b", b, "a2"), ("c", c, "a3")] {
        let id = format!("0192f3a4-7c1e-7b2a-9f00-0000000000{last}").parse().unwrap();
        let e = lib.store.get(id).expect("listed");
        assert!(e.read_only.is_some(), "{n} is read-only");
        let v = e.hash.clone();
        let err = lib.write(Lane::Interactive, move |tx| tx.save_body(id, &v, None, "overwrite")).unwrap_err();
        assert_eq!(err.code, ErrorCode::ReadOnly);
        assert_eq!(h.read(&format!("pages/{n}.md")), t, "never rewritten");
    }
    // …and repairs never touch them.
    lib.write(Lane::Background, |tx| tx.run_repairs());
    assert_eq!(h.read("pages/a.md"), a);
}

#[test]
fn outside_edits_moves_and_removals_are_detected() {
    let h = H::new();
    let lib = h.open();
    let e = create(&lib, "Watched", "v1\n");
    h.changes.lock().unwrap().clear();
    h.outside_write(&e.path, &h.read(&e.path).replace("v1", "v2"));
    settle(&lib);
    let c = h.changes.lock().unwrap().clone();
    assert_eq!(c.len(), 1, "{c:?}");
    assert_eq!((c[0].id, c[0].op, c[0].origin), (e.id, ChangeOp::Updated, ChangeOrigin::Outside));

    // moved outside (e.g. in Finder): found by the ID inside
    let text = h.read(&e.path);
    let new_rel = "pages/Elsewhere/renamed by hand.md";
    h.fs.write_outside(&h.abs(new_rel), text.as_bytes());
    h.fs.remove_outside(&h.abs(&e.path));
    // FSEvents reports a move's two paths in one batch.
    h.src.record_all(&[&h.abs(&e.path), &h.abs(new_rel)]);
    settle(&lib);
    assert_eq!(lib.store.get(e.id).unwrap().path, new_rel);
    assert!(h.changes.lock().unwrap().iter().any(|c| c.op == ChangeOp::Renamed));

    // our own writes are recognised by their hash: no outside change
    h.changes.lock().unwrap().clear();
    let id = e.id;
    lib.write(Lane::Interactive, move |tx| tx.set_fields(id, None, &[("x.n".into(), Some(FmValue::Int(1)))])).unwrap();
    h.src.record(&h.abs(new_rel));
    settle(&lib);
    assert!(h.changes.lock().unwrap().iter().all(|c| c.origin == ChangeOrigin::App));

    h.outside_remove(new_rel);
    settle(&lib);
    assert!(lib.store.get(e.id).is_none());
    assert!(h.changes.lock().unwrap().iter().any(|c| c.op == ChangeOp::Removed));
}

#[test]
fn edits_while_closed_are_found_by_replay_and_by_a_full_check() {
    let h = H::new();
    let lib = h.open();
    let e = create(&lib, "Closed", "before\n");
    lib.close();
    drop(lib);
    h.outside_write(&e.path, &h.read(&e.path).replace("before", "while closed"));
    let lib = h.open();
    assert_eq!(lib.startup.mode, "replay", "{:?}", lib.startup.reason);
    assert_eq!(lib.startup.check.updated, vec![e.id]);
    assert!(lib.store.read_text(e.id).unwrap().body.contains("while closed"));
    lib.close();
    drop(lib);

    // Replay unavailable (another volume): a full check finds it.
    h.outside_write(&e.path, &h.read(&e.path).replace("while closed", "again"));
    h.src.change_volume("VOLUME-B");
    let lib = h.open();
    assert_eq!(lib.startup.mode, "full");
    assert_eq!(lib.startup.check.updated, vec![e.id]);
    lib.close();
    drop(lib);

    // History purged: full check.
    h.outside_write(&e.path, &h.read(&e.path).replace("again", "purged"));
    h.src.purge_history();
    let lib = h.open();
    assert_eq!(lib.startup.mode, "full");
    assert!(lib.store.read_text(e.id).unwrap().body.contains("purged"));

    // Dropped events while running: full check.
    h.fs.write_outside(&h.abs(&e.path), h.read(&e.path).replace("purged", "dropped").as_bytes());
    h.src.drop_events();
    settle(&lib);
    assert!(lib.store.read_text(e.id).unwrap().body.contains("dropped"));
}

#[test]
fn racy_files_are_hashed() {
    let h = H::new();
    let lib = h.open();
    let e = create(&lib, "Racy", "aaaa\n");
    lib.close();
    drop(lib);
    // Same size, and the fake keeps the fingerprint the same except mtime; a racy check hashes.
    let changed = h.read(&e.path).replace("aaaa", "bbbb");
    h.fs.write_outside(&h.abs(&e.path), changed.as_bytes());
    h.src.change_volume("X"); // force a full check
    let lib = h.open();
    assert!(lib.store.read_text(e.id).unwrap().body.contains("bbbb"));
}

#[test]
fn files_without_ids_get_one_when_the_folder_is_quiet() {
    let h = H::new();
    h.fs.write_outside(&h.abs("pages/My Note.md"), b"# My Note\nWritten elsewhere.\n");
    h.fs.write_outside(
        &h.abs("pages/upper.md"),
        b"---\nid: \"0192F3A4-7C1E-7B2A-9F00-0000000000BB\"\ntitle: Upper\n---\nx\n",
    );
    let lib = h.open();
    assert_eq!(lib.store.pending_repairs().len(), 2);
    h.outside_write("pages/other.md", "# noise\n");
    // Not quiet yet: nothing is rewritten.
    settle(&lib);
    assert!(!lib.store.quiet());
    h.clock.advance_ms(5_000);
    assert!(lib.store.quiet());
    let done = lib.write(Lane::Background, |tx| tx.run_repairs());
    assert_eq!(done.len(), 3, "{done:?}");
    let upper: librarium_contracts::Id = "0192f3a4-7c1e-7b2a-9f00-0000000000bb".parse().unwrap();
    let e = lib.store.get(upper).expect("damaged ID restored in canonical form");
    assert_eq!(e.path, format!("pages/{upper}-upper.md"));
    let mine = lib.store.list(Some("page")).into_iter().find(|e| e.title == "My Note").unwrap();
    assert_eq!(mine.path, format!("pages/{}-my-note.md", mine.id));
    assert!(h.read(&mine.path).ends_with("---\n# My Note\nWritten elsewhere.\n"));
    assert!(lib.store.pending_repairs().is_empty());
}

#[test]
fn ids_are_not_rewritten_during_a_git_operation() {
    let h = H::new();
    h.fs.write_outside(&h.abs("pages/x.md"), b"# X\n");
    h.fs.write_outside(&h.abs(".git/index.lock"), b"");
    let lib = h.open();
    h.clock.advance_ms(10_000);
    assert!(!lib.store.quiet(), "git is busy");
    h.fs.remove_outside(&h.abs(".git/index.lock"));
    assert!(lib.store.quiet());
}

#[test]
fn duplicate_ids_are_classified() {
    let h = H::new();
    let lib = h.open();
    let e = create(&lib, "Original", "line one\nline two\nline three\nline four\nline five\n");
    let text = h.read(&e.path);
    // A sync conflict: conflict name.
    let conflict = format!("pages/{}-original 2.md", e.id);
    h.outside_write(&conflict, &text.replace("five", "5"));
    // A Finder copy: copy name.
    let copy = format!("pages/{}-original copy.md", e.id);
    h.outside_write(&copy, &text);
    // Same text, other name: conflict. Different text: copy.
    let similar = "pages/similar.md";
    h.outside_write(similar, &text.replace("line one", "line 1"));
    let different = "pages/different.md";
    h.outside_write(different, &format!("---\nid: \"{}\"\ntitle: \"Other\"\n---\nA new note entirely.\n", e.id));
    settle(&lib);

    let classes: std::collections::BTreeMap<_, _> =
        lib.store.duplicates().into_iter().map(|d| (d.path, d.class)).collect();
    use librarium_kernel::store::DupClass::*;
    assert_eq!(classes.get(&conflict), Some(&Conflict));
    assert_eq!(classes.get(&copy), Some(&Copy));
    assert_eq!(classes.get(similar), Some(&Conflict));
    assert_eq!(classes.get(different), Some(&Copy));
    // The original stays the record, with its conflicts listed.
    let orig = lib.store.get(e.id).unwrap();
    assert_eq!(orig.path, e.path);
    assert_eq!(orig.conflicts.len(), 2);

    // Copies get a new ID and copied-from, when quiet; conflicts are never merged silently.
    h.clock.advance_ms(5_000);
    lib.write(Lane::Background, |tx| tx.run_repairs());
    let copies: Vec<_> = lib
        .store
        .list(Some("page"))
        .into_iter()
        .filter(|x| x.fields.get("copied-from").and_then(|v| v.as_str()) == Some(&e.id.to_string()))
        .collect();
    assert_eq!(
        copies.len(),
        2,
        "{:#?}",
        lib.store.list(Some("page")).iter().map(|e| (&e.path, e.fields.get("copied-from"))).collect::<Vec<_>>()
    );
    assert!(copies.iter().all(|c| c.id != e.id && c.path.starts_with(&format!("pages/{}", c.id))));
    assert_eq!(h.read(&conflict), text.replace("five", "5"), "conflicts are left alone");
    let left: Vec<_> = lib.store.duplicates().into_iter().map(|d| (d.path, d.class)).collect();
    assert_eq!(left.len(), 2, "{left:?}");

    // Known duplicates survive a replayed restart.
    lib.close();
    drop(lib);
    let lib = h.open();
    assert_eq!(lib.startup.mode, "replay");
    assert_eq!(lib.store.duplicates().len(), 2);
    assert_eq!(lib.store.get(e.id).unwrap().conflicts.len(), 2);
}

#[test]
fn with_no_index_the_canonical_name_is_the_original() {
    let h = H::new();
    let id = "0192f3a4-7c1e-7b2a-9f00-0000000000cc";
    let t = format!("---\nid: \"{id}\"\ntitle: \"Canon\"\n---\nbody\n");
    h.fs.write_outside(&h.abs("pages/aaa-first-by-name.md"), t.as_bytes());
    h.fs.write_outside(&h.abs(&format!("pages/{id}-canon.md")), t.as_bytes());
    let lib = h.open();
    assert_eq!(lib.store.get(id.parse().unwrap()).unwrap().path, format!("pages/{id}-canon.md"));
    assert_eq!(lib.store.duplicates()[0].path, "pages/aaa-first-by-name.md");
}

#[test]
fn json_records_are_listed_and_edited_keeping_unknown_fields() {
    let h = H::new();
    let id = "0192f3a4-7c1e-7b2a-9f00-0000000000dd";
    let rel = format!("things/{id}-an-essay/record.json");
    h.fs.write_outside(&h.abs(&rel), format!("{{\"id\": \"{id}\", \"kind\": \"thing\", \"kind-version\": 1, \"title\": \"An essay\", \"zzz.unknown\": {{\"keep\": [1,2]}}, \"sha256\": \"abc\"}}").as_bytes());
    let lib = h.open();
    let idv = id.parse().unwrap();
    assert_eq!(lib.store.get(idv).unwrap().title, "An essay");
    lib.write(Lane::Interactive, move |tx| tx.set_fields(idv, None, &[("x.read".into(), Some(FmValue::Bool(true)))]))
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&h.read(&rel)).unwrap();
    assert_eq!(v["zzz.unknown"]["keep"][1], 2);
    assert_eq!(v["x.read"], true);
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys.first().map(String::as_str), Some("id"), "order kept: {keys:?}");
}

#[test]
fn a_missing_library_folder_is_reported() {
    let h = H::new();
    h.fs.remove_dir(std::path::Path::new(ROOT)).unwrap();
    let err = h.try_open().err().unwrap();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert!(err.data.unwrap().get("library_missing").is_some());
}

#[test]
fn the_interactive_lane_goes_first() {
    let h = H::new();
    let lib = h.open();
    let order = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
    // Block the writer, queue background then interactive work, then release.
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    lib.writer.submit(Lane::Background, move |_| {
        rx.recv().unwrap();
    });
    std::thread::sleep(std::time::Duration::from_millis(50));
    let mut waits = vec![];
    for (lane, name) in [(Lane::Background, "b1"), (Lane::Background, "b2"), (Lane::Interactive, "i1")] {
        let o = order.clone();
        waits.push(lib.writer.submit(lane, move |_| o.lock().unwrap().push(name)));
    }
    tx.send(()).unwrap();
    for w in waits {
        w.recv().unwrap();
    }
    assert_eq!(*order.lock().unwrap(), ["i1", "b1", "b2"]);
}
