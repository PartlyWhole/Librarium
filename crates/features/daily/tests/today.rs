//! ⌘T: open or create today's note — one writer operation.
use librarium_contracts::ports::{ChangeSource, FileSystem, IndexEngine};
use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::library::{Library, LibraryPorts, OpenOptions};
use librarium_kernel::methods::MethodCtx;
use librarium_testkit::changes::ScriptedChanges;
use librarium_testkit::clock::FixedClock;
use librarium_testkit::ids::SequenceIds;
use librarium_testkit::memfs::MemFs;
use librarium_testkit::memindex::MemIndex;
use librarium_testkit::versions::RecordingVersions;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

fn open(clock: Arc<FixedClock>) -> Arc<Library> {
    let fs = Arc::new(MemFs::new());
    fs.create_dir_all(Path::new("/lib")).unwrap();
    let mut k = Kinds::new();
    // The note kind as the Notes module defines it (this test can't depend on Notes).
    k.add(
        "test",
        RecordKindDef {
            kind: "note".into(),
            version: 1,
            format: Format::Markdown,
            folder: "notes".into(),
            slugged: true,
            subfolder_field: None,
        },
    )
    .unwrap();
    librarium_feature_daily::contribute_kinds(&mut k).unwrap();
    let index = MemIndex::new();
    Arc::new(
        Library::open(
            Path::new("/lib"),
            Path::new("/app"),
            LibraryPorts {
                fs: fs as Arc<dyn FileSystem>,
                clock,
                ids: Arc::new(SequenceIds::new()),
                versions: Arc::new(RecordingVersions::default()),
                index: Arc::new(move |_p: &Path| Arc::new(index.clone()) as Arc<dyn IndexEngine>),
                changes: Arc::new(ScriptedChanges::new()) as Arc<dyn ChangeSource>,
            },
            k,
            OpenOptions { tick: std::time::Duration::from_secs(3600), ..Default::default() },
        )
        .unwrap(),
    )
}

fn today(lib: &Arc<Library>, day_start: Option<u64>) -> librarium_contracts::api::Written {
    let get = move |k: &str| if k == librarium_feature_daily::DAY_START { day_start.map(Value::from) } else { None };
    librarium_feature_daily::today(&MethodCtx { library: lib, setting: &get, views: None, jobs: None }).unwrap()
}

#[test]
fn pressing_twice_makes_one_note() {
    // 2026-10-02T09:14Z, in UTC.
    let lib = open(Arc::new(FixedClock::new()));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let l = lib.clone();
            std::thread::spawn(move || today(&l, None))
        })
        .collect();
    let ids: std::collections::BTreeSet<_> = threads.into_iter().map(|t| t.join().unwrap().info.id).collect();
    assert_eq!(ids.len(), 1, "one note for eight presses");
    let notes = lib.store.list(Some("note"));
    assert_eq!(notes.len(), 1);
    let n = &notes[0];
    assert_eq!(n.title, "2026-10-02");
    assert_eq!(n.fields["daily.date"], json!("2026-10-02"));
    assert_eq!(n.path, format!("notes/{}-2026-10-02.md", n.id), "a daily note's slug is its date");

    // Renaming it keeps the date, and the slug.
    let id = n.id;
    let (e, _) = lib
        .write(librarium_kernel::writer::Lane::Interactive, move |tx| tx.relocate(id, Some("A long Friday"), None))
        .unwrap();
    assert_eq!(e.path, format!("notes/{id}-2026-10-02.md"));
    assert_eq!(today(&lib, None).info.id, id);
}

#[test]
fn the_day_starts_at_four_by_default() {
    // 02:30 local (UTC) on 3 October still belongs to 2 October.
    let lib = open(Arc::new(FixedClock::at(1_790_995_800_000, 0)));
    assert_eq!(today(&lib, None).info.title, "2026-10-02");
    assert_eq!(today(&lib, Some(0)).info.title, "2026-10-03", "with the day starting at midnight");
}

#[test]
fn with_two_notes_for_a_date_the_earlier_opens() {
    let clock = Arc::new(FixedClock::new());
    let lib = open(clock.clone());
    let first = today(&lib, None).info.id;
    clock.advance_ms(60_000);
    let fm = vec![("daily.date".to_string(), librarium_kernel::frontmatter::FmValue::Str("2026-10-02".into()))];
    lib.write(librarium_kernel::writer::Lane::Interactive, move |tx| tx.create("note", "Second", fm, "", None))
        .unwrap();
    assert_eq!(lib.store.list(Some("note")).len(), 2);
    assert_eq!(today(&lib, None).info.id, first);
}
