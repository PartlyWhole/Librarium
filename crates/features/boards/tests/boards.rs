//! Boards on the test adapters: two files beside notes, saved together, checked, carried along.
use librarium_contracts::ports::{ChangeSource, FileSystem, IndexEngine};
use librarium_contracts::ErrorCode;
use librarium_feature_boards::{self as boards, EMPTY_SCENE, SCENE_SHA};
use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::library::{Library, LibraryPorts, OpenOptions};
use librarium_kernel::methods::MethodCtx;
use librarium_kernel::writer::Lane;
use librarium_testkit::changes::ScriptedChanges;
use librarium_testkit::clock::FixedClock;
use librarium_testkit::ids::SequenceIds;
use librarium_testkit::memfs::MemFs;
use librarium_testkit::memindex::MemIndex;
use librarium_testkit::versions::RecordingVersions;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

fn open_on(fs: Arc<MemFs>) -> Arc<Library> {
    let mut k = Kinds::new();
    // Notes, as the notes feature defines them (features don't depend on each other).
    k.add(
        "test",
        RecordKindDef {
            kind: "note".into(),
            version: 1,
            format: Format::Markdown,
            folder: "notes".into(),
            slugged: true,
            subfolder_field: Some("notes.folder".into()),
        },
    )
    .unwrap();
    boards::contribute_kinds(&mut k).unwrap();
    let index = MemIndex::new();
    let lib = Library::open(
        Path::new("/lib"),
        Path::new("/app"),
        LibraryPorts {
            fs: fs as Arc<dyn FileSystem>,
            clock: Arc::new(FixedClock::new()),
            ids: Arc::new(SequenceIds::new()),
            versions: Arc::new(RecordingVersions::default()),
            index: Arc::new(move |_p: &Path| Arc::new(index.clone()) as Arc<dyn IndexEngine>),
            changes: Arc::new(ScriptedChanges::new()) as Arc<dyn ChangeSource>,
        },
        k,
        OpenOptions { tick: std::time::Duration::from_secs(3600), ..Default::default() },
    )
    .unwrap();
    Arc::new(lib)
}

fn open() -> (Arc<Library>, Arc<MemFs>) {
    let fs = Arc::new(MemFs::new());
    fs.create_dir_all(Path::new("/lib")).unwrap();
    (open_on(fs.clone()), fs)
}

fn read(fs: &MemFs, rel: &str) -> String {
    String::from_utf8(fs.read(&Path::new("/lib").join(rel)).unwrap()).unwrap()
}

const DRAWING: &str = r#"{"type":"excalidraw","version":2,"source":"librarium","elements":[{"id":"a","type":"rectangle"}],"appState":{},"files":{}}"#;

#[test]
fn a_board_is_two_files_beside_notes() {
    let (lib, fs) = open();
    let get = |_: &str| None;
    let ctx = MethodCtx { library: &lib, setting: &get, views: None, jobs: None };
    let note = lib.write(Lane::Interactive, |tx| tx.create("note", "Ellul", vec![], "", Some("Thinkers"))).unwrap();
    let w = boards::create(&ctx, "Map of Ellul", Some("Thinkers")).unwrap();
    let id = w.info.id;
    assert_eq!(w.info.kind, "board");
    assert_eq!(w.info.path, format!("notes/Thinkers/{id}-map-of-ellul.md"));
    // The drawing beside it, empty, in Excalidraw's format; the page says what it is.
    assert_eq!(read(&fs, &format!("notes/Thinkers/{id}.excalidraw")), EMPTY_SCENE);
    let page = read(&fs, &w.info.path);
    assert!(page.contains("kind: \"board\""), "{page}");
    assert!(page.contains(&format!("{id}.excalidraw")), "{page}");
    assert!(page.contains("notes.folder: \"Thinkers\""), "{page}");
    // One folder space: the note's and the board's folder is the same.
    assert_eq!(lib.store.folders("note"), ["Thinkers"]);
    let def = lib.store.foldered_kind("note").unwrap();
    assert_eq!(lib.store.space_kinds(&def), ["note", "board"]);
    assert_eq!(lib.store.records_in_folder(&def, "Thinkers").len(), 2);
    let _ = note;
    // Opened: the drawing, and the page is current.
    let b = boards::load(&ctx, id).unwrap();
    assert_eq!(b.scene, EMPTY_SCENE);
    assert!(!b.stale_page);
    // An empty title.
    assert_eq!(boards::create(&ctx, "  ", None).unwrap().info.title, "Untitled board");
    // A note isn't a board.
    assert_eq!(boards::load(&ctx, w.info.id).unwrap().info.kind, "board");
    assert!(boards::load(&ctx, lib.store.list(Some("note"))[0].id).is_err());
}

#[test]
fn saving_writes_the_drawing_and_its_page_checked_against_both() {
    let (lib, fs) = open();
    let get = |_: &str| None;
    let ctx = MethodCtx { library: &lib, setting: &get, views: None, jobs: None };
    let w = boards::create(&ctx, "Map", None).unwrap();
    let id = w.info.id;
    let b = boards::load(&ctx, id).unwrap();
    let page = format!("{}\nA rectangle.\n", boards::page_note(id));
    let saved = boards::save(&ctx, id, &b.info.version, &b.scene_sha, DRAWING, &page).unwrap();
    assert_eq!(read(&fs, &format!("notes/{id}.excalidraw")), DRAWING);
    let md = read(&fs, &saved.info.path);
    assert!(md.ends_with("A rectangle.\n"), "{md}");
    assert!(md.contains(&format!("{SCENE_SHA}: \"{}\"", saved.scene_sha)), "{md}");
    let again = boards::load(&ctx, id).unwrap();
    assert_eq!(again.scene, DRAWING);
    assert!(!again.stale_page);
    assert_eq!(again.info.version, saved.info.version);

    // Based on an old version: refused, saying what is there now.
    let e = boards::save(&ctx, id, &b.info.version, &again.scene_sha, DRAWING, &page).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    // The drawing changed outside (another program, a sync): refused too, and the page is stale.
    fs.write_outside(&Path::new("/lib").join(format!("notes/{id}.excalidraw")), EMPTY_SCENE.as_bytes());
    let e = boards::save(&ctx, id, &again.info.version, &again.scene_sha, DRAWING, &page).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(
        e.data.as_ref().and_then(|d| d.get("scene_sha")).and_then(Value::as_str),
        Some(boards::sha(EMPTY_SCENE.as_bytes()).as_str())
    );
    let outside = boards::load(&ctx, id).unwrap();
    assert_eq!(outside.scene, EMPTY_SCENE);
    assert!(outside.stale_page);
    // Saved from what is there now: fine.
    boards::save(&ctx, id, &outside.info.version, &outside.scene_sha, DRAWING, &page).unwrap();
    // Not a drawing: refused, nothing written.
    let e = boards::save(
        &ctx,
        id,
        &boards::load(&ctx, id).unwrap().info.version,
        &boards::sha(DRAWING.as_bytes()),
        "{}",
        &page,
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert_eq!(read(&fs, &format!("notes/{id}.excalidraw")), DRAWING);
}

#[test]
fn unknown_keys_in_the_page_are_kept_and_a_newer_board_is_read_only() {
    let (lib, fs) = open();
    let get = |_: &str| None;
    let ctx = MethodCtx { library: &lib, setting: &get, views: None, jobs: None };
    let w = boards::create(&ctx, "Map", None).unwrap();
    let id = w.info.id;
    let path = Path::new("/lib").join(&w.info.path);
    let md = read(&fs, &w.info.path).replacen("title:", "tags: [\"maps\"]\n# mine\ntitle:", 1);
    fs.write_outside(&path, md.as_bytes());
    let lib2 = open_on(fs.clone());
    let ctx = MethodCtx { library: &lib2, setting: &get, views: None, jobs: None };
    let b = boards::load(&ctx, id).unwrap();
    boards::save(&ctx, id, &b.info.version, &b.scene_sha, DRAWING, "page\n").unwrap();
    let after = read(&fs, &w.info.path);
    assert!(after.contains("tags: [\"maps\"]\n# mine\n"), "{after}");
    // Written by a newer Librarium: opens read-only, and isn't saved over.
    let newer = after.replace("kind-version: 1", "kind-version: 9");
    fs.write_outside(&path, newer.as_bytes());
    let lib3 = open_on(fs.clone());
    let ctx = MethodCtx { library: &lib3, setting: &get, views: None, jobs: None };
    let b = boards::load(&ctx, id).unwrap();
    assert!(b.info.read_only.is_some());
    assert!(boards::save(&ctx, id, &b.info.version, &b.scene_sha, DRAWING, "page\n").is_err());
    let _ = lib;
}

#[test]
fn the_drawing_goes_where_the_board_goes_and_is_deleted_with_it() {
    let (lib, fs) = open();
    let get = |_: &str| None;
    let ctx = MethodCtx { library: &lib, setting: &get, views: None, jobs: None };
    let w = boards::create(&ctx, "Map", Some("Drafts")).unwrap();
    let id = w.info.id;
    // To another folder.
    lib.write(Lane::Interactive, move |tx| tx.move_to_folder(id, Some("Final"))).unwrap();
    assert_eq!(read(&fs, &format!("notes/Final/{id}.excalidraw")), EMPTY_SCENE);
    // A folder moved, with the board in it.
    lib.write(Lane::Interactive, |tx| tx.move_folder("note", "Final", "Done/Final")).unwrap();
    assert_eq!(read(&fs, &format!("notes/Done/Final/{id}.excalidraw")), EMPTY_SCENE);
    let b = boards::load(&ctx, id).unwrap();
    assert_eq!(b.info.path, format!("notes/Done/Final/{id}-map.md"));
    assert!(!b.stale_page);
    // Renamed: the drawing's name carries only the ID.
    lib.write(Lane::Interactive, move |tx| tx.relocate(id, Some("Big map"), None)).unwrap();
    assert_eq!(boards::load(&ctx, id).unwrap().scene, EMPTY_SCENE);
    // Deleted for good: both files.
    let (files, _) = lib.write(Lane::Interactive, move |tx| tx.deletion_plan(id)).unwrap();
    assert!(files.contains(&format!("notes/Done/Final/{id}.excalidraw")), "{files:?}");
}

#[test]
fn a_save_cut_short_at_any_step_leaves_the_old_pair_or_the_new_drawing_with_a_stale_page() {
    for n in 1..30 {
        let (lib, fs) = open();
        let get = |_: &str| None;
        let ctx = MethodCtx { library: &lib, setting: &get, views: None, jobs: None };
        let id = boards::create(&ctx, "Map", None).unwrap().info.id;
        let b = boards::load(&ctx, id).unwrap();
        fs.crash_after(n);
        let r = boards::save(&ctx, id, &b.info.version, &b.scene_sha, DRAWING, "new page\n");
        let crashed = fs.has_crashed();
        fs.restart();
        let lib2 = open_on(fs.clone());
        let ctx = MethodCtx { library: &lib2, setting: &get, views: None, jobs: None };
        let after = boards::load(&ctx, id).unwrap();
        if !crashed {
            assert!(r.is_ok(), "step {n}");
            assert_eq!(after.scene, DRAWING);
            assert!(!after.stale_page, "step {n}");
            return;
        }
        // Never a page claiming a drawing that isn't there.
        if after.scene == DRAWING {
            let page = read(&fs, &after.info.path);
            assert!(after.stale_page || page.ends_with("new page\n"), "step {n}: {page}");
        } else {
            assert_eq!(after.scene, EMPTY_SCENE, "step {n}");
            assert!(!after.stale_page, "step {n}");
        }
        // And the next save puts it right.
        boards::save(&ctx, id, &after.info.version, &after.scene_sha, DRAWING, "new page\n").unwrap();
        assert!(!boards::load(&ctx, id).unwrap().stale_page, "step {n}");
    }
    panic!("the save never finished within 30 steps");
}
