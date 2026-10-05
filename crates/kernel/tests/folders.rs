//! The user's folders: each kind with subfolders has its own, kept on disk.
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
fn each_kind_has_its_own_folders_found_on_disk() {
    let h = H::new();
    let rel = thing_in(&h, "Reading/Plato");
    let lib = h.open();
    // A folder record inside a user's folder is found by the full check.
    let thing = lib.store.get(THING.parse().unwrap()).expect("found inside the folder");
    assert_eq!(thing.path, rel);
    lib.write(Lane::Interactive, |tx| tx.create("page", "Note", vec![], "", Some("Notebook"))).unwrap();
    lib.write(Lane::Interactive, |tx| tx.create_folder("thing", "Empty")).unwrap();
    assert_eq!(lib.store.folders("thing"), ["Empty", "Reading", "Reading/Plato"]);
    assert_eq!(lib.store.folders("page"), ["Notebook"]);
    assert!(h.fs.stat(&h.abs("things/Empty")).unwrap().unwrap().is_dir);
    assert!(h.fs.stat(&h.abs("pages/Empty")).unwrap().is_none(), "only in that kind's folder");
    // The same name is fine in another kind.
    lib.write(Lane::Interactive, |tx| tx.create_folder("page", "Empty")).unwrap();
    let again = lib.write(Lane::Interactive, |tx| tx.create_folder("thing", "Empty")).unwrap_err();
    assert_eq!(again.code, ErrorCode::Conflict);
    assert!(lib.write(Lane::Interactive, |tx| tx.create_folder("clip", "X")).is_err(), "a kind without folders");
    for bad in ["", ".hidden", "a/../b", "a//b", "a/ b", "x:y", THING] {
        assert!(lib.write(Lane::Interactive, move |tx| tx.create_folder("thing", bad)).is_err(), "{bad:?} refused");
    }
}

#[test]
fn moving_a_folder_takes_everything_inside_along() {
    let h = H::new();
    thing_in(&h, "Reading/Plato");
    h.fs.write_outside(&h.abs("things/Reading/picture.png"), b"png");
    let lib = h.open();
    // A note folder of the same name is another folder, and stays.
    let (n, _) =
        lib.write(Lane::Interactive, |tx| tx.create("page", "Note", vec![], "body\n", Some("Reading"))).unwrap();
    let nid = n.id;
    let moved = lib.write(Lane::Interactive, |tx| tx.move_folder("thing", "Reading", "Archive/Old reading")).unwrap();
    assert_eq!(moved, 1);
    let t = lib.store.get(THING.parse().unwrap()).unwrap();
    assert_eq!(t.path, format!("things/Archive/Old reading/Plato/{THING}-an-essay/record.json"));
    assert_eq!(t.fields["test.place"], "Archive/Old reading/Plato", "the field follows the path");
    assert_eq!(h.read(&format!("things/Archive/Old reading/Plato/{THING}-an-essay/original.pdf")), "%PDF");
    assert_eq!(h.read("things/Archive/Old reading/picture.png"), "png", "other files go along");
    assert!(h.fs.stat(&h.abs("things/Reading")).unwrap().is_none());
    assert_eq!(lib.store.folders("thing"), ["Archive", "Archive/Old reading", "Archive/Old reading/Plato"]);
    assert_eq!(lib.store.get(nid).unwrap().path, format!("pages/Reading/{nid}-note.md"));

    // Never into itself, never over another folder.
    let e = lib.write(Lane::Interactive, |tx| tx.move_folder("thing", "Archive", "Archive/Inner")).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    lib.write(Lane::Interactive, |tx| tx.create_folder("thing", "Taken")).unwrap();
    let e = lib.write(Lane::Interactive, |tx| tx.move_folder("thing", "Archive", "Taken")).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);

    // A note folder moves its notes, and the field mirrors it.
    lib.write(Lane::Interactive, |tx| tx.move_folder("page", "Reading", "Done")).unwrap();
    let n = lib.store.get(nid).unwrap();
    assert_eq!(n.path, format!("pages/Done/{nid}-note.md"));
    assert!(
        h.read(&n.path).contains("test.folder: Done\n") || h.read(&n.path).contains("test.folder: \"Done\"\n"),
        "{}",
        h.read(&n.path)
    );

    // What was moved is found where it is after a restart.
    drop(lib);
    let lib = h.open();
    assert_eq!(lib.store.get(nid).unwrap().path, format!("pages/Done/{nid}-note.md"));
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
    let err = lib.write(Lane::Interactive, |tx| tx.remove_folder("thing", "Sorted")).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(err.message.contains("isn’t empty"), "{}", err.message);

    // Back to the top level: the field goes.
    let (e, _) = lib.write(Lane::Interactive, move |tx| tx.move_to_folder(id, None)).unwrap();
    assert_eq!(e.path, format!("things/{THING}-an-essay/record.json"));
    assert!(e.fields.get("test.place").is_none());

    // The system's litter doesn't keep a folder; anyone else's file does.
    h.fs.write_outside(&h.abs("things/Sorted/Essays/.DS_Store"), b"x");
    lib.write(Lane::Interactive, |tx| tx.remove_folder("thing", "Sorted")).unwrap();
    assert!(h.fs.stat(&h.abs("things/Sorted")).unwrap().is_none());
    assert!(!lib.store.folders("thing").contains(&"Sorted".to_string()));
    h.fs.write_outside(&h.abs("things/Inbox/keep.txt"), b"mine");
    let err = lib.write(Lane::Interactive, |tx| tx.remove_folder("thing", "Inbox")).unwrap_err();
    assert!(err.message.contains("keep.txt"), "{}", err.message);
    assert_eq!(h.read("things/Inbox/keep.txt"), "mine");

    // A kind without subfolders can't be put in one.
    let (clip, _) = lib.write(Lane::Interactive, |tx| tx.create("clip", "Clip", vec![], "", None)).unwrap();
    let cid = clip.id;
    assert!(lib.write(Lane::Interactive, move |tx| tx.move_to_folder(cid, Some("Inbox"))).is_err());
}

#[test]
fn an_arrangement_follows_renames_and_goes_with_a_removed_folder() {
    let h = H::new();
    let lib = h.open();
    for f in ["B", "A", "A/Inner"] {
        lib.write(Lane::Interactive, move |tx| tx.create_folder("thing", f)).unwrap();
    }
    lib.write(Lane::Interactive, |tx| tx.set_folder_order("thing", "", vec!["folder:B".into(), "folder:A".into()]))
        .unwrap();
    lib.write(Lane::Interactive, |tx| tx.set_folder_order("thing", "A", vec!["folder:Inner".into()])).unwrap();
    lib.write(Lane::Interactive, |tx| tx.set_folder_order("page", "", vec!["x".into()])).unwrap();
    // Renamed in place: same spot, new name; what it held keeps its arrangement.
    lib.write(Lane::Interactive, |tx| tx.move_folder("thing", "A", "Alpha")).unwrap();
    let o = lib.store.folder_order("thing");
    assert_eq!(o[""], ["folder:B", "folder:Alpha"]);
    assert_eq!(o["Alpha"], ["folder:Inner"]);
    assert!(!o.contains_key("A"));
    assert_eq!(lib.store.folder_order("page")[""], ["x"], "each kind has its own");
    // Moved elsewhere: it leaves its old place.
    lib.write(Lane::Interactive, |tx| tx.move_folder("thing", "Alpha", "B/Alpha")).unwrap();
    let o = lib.store.folder_order("thing");
    assert_eq!(o[""], ["folder:B"]);
    assert_eq!(o["B/Alpha"], ["folder:Inner"]);
    // Removed: so is its arrangement.
    lib.write(Lane::Interactive, |tx| tx.remove_folder("thing", "B/Alpha/Inner")).unwrap();
    lib.write(Lane::Interactive, |tx| tx.remove_folder("thing", "B/Alpha")).unwrap();
    assert!(!lib.store.folder_order("thing").contains_key("B/Alpha"));
    let file = h.read(".librarium/order.json");
    assert!(file.contains("\"things\"") && file.ends_with("}\n"), "a plain file, readable without the app: {file}");
}

#[test]
fn kinds_share_a_folder_only_when_stored_alike() {
    let mut k = common::kinds();
    let other = |format, slugged, field: Option<&str>| librarium_kernel::kinds::RecordKindDef {
        kind: "odd".into(),
        version: 1,
        format,
        folder: "pages".into(),
        slugged,
        subfolder_field: field.map(Into::into),
    };
    use librarium_kernel::kinds::Format;
    assert!(k.add("test", other(Format::JsonDir, true, Some("test.folder"))).is_err(), "another format");
    assert!(k.add("test", other(Format::Markdown, false, Some("test.folder"))).is_err(), "other slugs");
    assert!(k.add("test", other(Format::Markdown, true, Some("test.place"))).is_err(), "another field");
    assert_eq!(k.sharing("pages").iter().map(|d| d.kind.as_str()).collect::<Vec<_>>(), ["page", "sketch"]);
}

#[test]
fn kinds_sharing_folders_are_one_space() {
    let h = H::new();
    let lib = h.open();
    // A sketch lives in the pages' folders; a file there is read as the kind it names.
    let (p, _) = lib.write(Lane::Interactive, |tx| tx.create("page", "Note", vec![], "", Some("Notebook"))).unwrap();
    let (sk, _) = lib.write(Lane::Interactive, |tx| tx.create("sketch", "Map", vec![], "", Some("Drawings"))).unwrap();
    let skid = sk.id;
    assert_eq!(sk.path, format!("pages/Drawings/{skid}-map.md"));
    assert_eq!(lib.store.get(skid).unwrap().kind, "sketch");
    // One space: the folders of both, listed for either kind; one entry in the list of spaces.
    assert_eq!(lib.store.folders("page"), ["Drawings", "Notebook"]);
    assert_eq!(lib.store.folders("sketch"), ["Drawings", "Notebook"]);
    let spaces: Vec<String> = lib.store.foldered().into_iter().map(|d| d.kind).collect();
    assert_eq!(spaces, ["page", "thing"]);
    let def = lib.store.foldered_kind("page").unwrap();
    assert_eq!(lib.store.space_kinds(&def), ["page", "sketch"]);
    // A folder holding a sketch isn't empty.
    let e = lib.write(Lane::Interactive, |tx| tx.remove_folder("page", "Drawings")).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    // Moving a folder moves the sketch in it too, and its folder field follows.
    lib.write(Lane::Interactive, |tx| tx.move_folder("page", "Drawings", "Notebook/Drawings")).unwrap();
    let moved = lib.store.get(skid).unwrap();
    assert_eq!(moved.path, format!("pages/Notebook/Drawings/{skid}-map.md"));
    assert_eq!(moved.fields["test.folder"], "Notebook/Drawings");
    assert_eq!(lib.store.get(p.id).unwrap().path, format!("pages/Notebook/{}-note.md", p.id));
}

#[test]
fn a_record_moved_to_another_folder_takes_its_sidecars() {
    let h = H::new();
    let lib = h.open();
    let (sk, _) = lib.write(Lane::Interactive, |tx| tx.create("sketch", "Map", vec![], "", None)).unwrap();
    let id = sk.id;
    lib.write(Lane::Interactive, move |tx| tx.write_sidecar(id, ".drawing", b"{\"elements\":[]}")).unwrap();
    h.fs.write_outside(&h.abs(&format!("pages/{id}.region-1.png")), b"png");
    lib.write(Lane::Interactive, move |tx| tx.move_to_folder(id, Some("Later"))).unwrap();
    assert_eq!(lib.store.get(id).unwrap().path, format!("pages/Later/{id}-map.md"));
    assert_eq!(h.read(&format!("pages/Later/{id}.drawing")), "{\"elements\":[]}");
    assert_eq!(h.read(&format!("pages/Later/{id}.region-1.png")), "png");
    assert!(h.fs.stat(&h.abs(&format!("pages/{id}.drawing"))).unwrap().is_none());
    // Renaming within a folder leaves them where they are (their names carry only the ID).
    lib.write(Lane::Interactive, move |tx| tx.relocate(id, Some("Big map"), None)).unwrap();
    assert_eq!(lib.store.get(id).unwrap().path, format!("pages/Later/{id}-big-map.md"));
    assert_eq!(h.read(&format!("pages/Later/{id}.drawing")), "{\"elements\":[]}");
}
