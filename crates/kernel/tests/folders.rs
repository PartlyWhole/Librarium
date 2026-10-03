//! The user's folders: one tree across the kinds that have subfolders, kept on disk.
mod common;

use common::H;
use librarium_contracts::ports::FileSystem;
use librarium_contracts::ErrorCode;
use librarium_kernel::writer::Lane;

const THING: &str = "0192f3a4-7c1e-7b2a-9f00-0000000000dd";

/// A folder record (a "thing") written by an outside program into `things/<sub>`.
fn thing_in(h: &H, sub: &str) -> String {
    let rel = format!("things/{sub}/{THING}-an-essay/record.json");
    h.fs.write_outside(
        &h.abs(&rel),
        format!("{{\"id\": \"{THING}\", \"kind\": \"thing\", \"kind-version\": 1, \"title\": \"An essay\"}}")
            .as_bytes(),
    );
    h.fs.write_outside(&h.abs(&format!("things/{sub}/{THING}-an-essay/original.pdf")), b"%PDF");
    rel
}

#[test]
fn folders_are_one_tree_across_kinds_and_found_on_disk() {
    let h = H::new();
    let rel = thing_in(&h, "Reading/Plato");
    let lib = h.open();
    // A folder record inside a user's folder is found by the full check.
    let thing = lib.store.get(THING.parse().unwrap()).expect("found inside the folder");
    assert_eq!(thing.path, rel);
    lib.write(Lane::Interactive, |tx| tx.create("page", "Note", vec![], "", Some("Reading"))).unwrap();
    lib.write(Lane::Interactive, |tx| tx.create_folder("Empty")).unwrap();
    assert_eq!(lib.store.folders(), ["Empty", "Reading", "Reading/Plato"]);
    // A new folder is made in each kind's folder, so it is there whichever is looked at.
    for top in ["pages", "things"] {
        assert!(h.fs.stat(&h.abs(&format!("{top}/Empty"))).unwrap().unwrap().is_dir);
    }
    let again = lib.write(Lane::Interactive, |tx| tx.create_folder("Empty")).unwrap_err();
    assert_eq!(again.code, ErrorCode::Conflict);
    for bad in ["", ".hidden", "a/../b", "a//b", "a/ b", "x:y", THING] {
        assert!(lib.write(Lane::Interactive, move |tx| tx.create_folder(bad)).is_err(), "{bad:?} refused");
    }
}

#[test]
fn moving_a_folder_takes_everything_inside_along() {
    let h = H::new();
    thing_in(&h, "Reading/Plato");
    h.fs.write_outside(&h.abs("pages/Reading/picture.png"), b"png");
    let lib = h.open();
    let (n, _) =
        lib.write(Lane::Interactive, |tx| tx.create("page", "Note", vec![], "body\n", Some("Reading/Plato"))).unwrap();
    let nid = n.id;
    let moved = lib.write(Lane::Interactive, |tx| tx.move_folder("Reading", "Archive/Old reading")).unwrap();
    assert_eq!(moved, 2);
    let n = lib.store.get(nid).unwrap();
    assert_eq!(n.path, format!("pages/Archive/Old reading/Plato/{nid}-note.md"));
    assert!(h.read(&n.path).contains("test.folder: \"Archive/Old reading/Plato\"\n"), "{}", h.read(&n.path));
    let t = lib.store.get(THING.parse().unwrap()).unwrap();
    assert_eq!(t.path, format!("things/Archive/Old reading/Plato/{THING}-an-essay/record.json"));
    assert_eq!(t.fields["test.place"], "Archive/Old reading/Plato", "a folder record's field follows too");
    assert_eq!(h.read(&format!("things/Archive/Old reading/Plato/{THING}-an-essay/original.pdf")), "%PDF");
    assert_eq!(h.read("pages/Archive/Old reading/picture.png"), "png", "other files go along");
    assert!(h.fs.stat(&h.abs("pages/Reading")).unwrap().is_none());
    assert_eq!(lib.store.folders(), ["Archive", "Archive/Old reading", "Archive/Old reading/Plato"]);

    // Never into itself, never over another folder.
    let e = lib.write(Lane::Interactive, |tx| tx.move_folder("Archive", "Archive/Inner")).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    lib.write(Lane::Interactive, |tx| tx.create_folder("Taken")).unwrap();
    let e = lib.write(Lane::Interactive, |tx| tx.move_folder("Archive", "Taken")).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);

    // What was moved is found where it is after a restart.
    drop(lib);
    let lib = h.open();
    assert_eq!(lib.store.get(nid).unwrap().path, format!("pages/Archive/Old reading/Plato/{nid}-note.md"));
    assert!(lib.store.duplicates().is_empty());
}

#[test]
fn records_move_between_folders_and_only_empty_folders_are_removed() {
    let h = H::new();
    thing_in(&h, "Inbox");
    let lib = h.open();
    let id = THING.parse().unwrap();
    let (e, _) = lib.write(Lane::Interactive, move |tx| tx.move_to_folder(id, Some("Sorted/Essays"))).unwrap();
    assert_eq!(e.path, format!("things/Sorted/Essays/{THING}-an-essay/record.json"));
    assert_eq!(e.fields["test.place"], "Sorted/Essays");
    assert_eq!(h.read(&format!("things/Sorted/Essays/{THING}-an-essay/original.pdf")), "%PDF", "its files go along");

    // Not empty: refused, and nothing is touched.
    let err = lib.write(Lane::Interactive, |tx| tx.remove_folder("Sorted")).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(err.message.contains("isn’t empty"), "{}", err.message);

    // Back to the top level: the field goes.
    let (e, _) = lib.write(Lane::Interactive, move |tx| tx.move_to_folder(id, None)).unwrap();
    assert_eq!(e.path, format!("things/{THING}-an-essay/record.json"));
    assert!(e.fields.get("test.place").is_none());

    // The system's litter doesn't keep a folder; anyone else's file does.
    h.fs.write_outside(&h.abs("things/Sorted/Essays/.DS_Store"), b"x");
    lib.write(Lane::Interactive, |tx| tx.remove_folder("Sorted")).unwrap();
    assert!(h.fs.stat(&h.abs("things/Sorted")).unwrap().is_none());
    assert!(!lib.store.folders().contains(&"Sorted".to_string()));
    h.fs.write_outside(&h.abs("things/Inbox/keep.txt"), b"mine");
    let err = lib.write(Lane::Interactive, |tx| tx.remove_folder("Inbox")).unwrap_err();
    assert!(err.message.contains("keep.txt"), "{}", err.message);
    assert_eq!(h.read("things/Inbox/keep.txt"), "mine");

    // A kind without subfolders can't be put in one.
    let (clip, _) = lib.write(Lane::Interactive, |tx| tx.create("clip", "Clip", vec![], "", None)).unwrap();
    let cid = clip.id;
    assert!(lib.write(Lane::Interactive, move |tx| tx.move_to_folder(cid, Some("Inbox"))).is_err());
}
