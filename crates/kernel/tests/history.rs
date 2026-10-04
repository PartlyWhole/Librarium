//! Version history (decision 0038): taken on writes and outside edits, spaced, kept with the
//! library, pruned by age, erased by permanent deletion, shared between Macs.
mod common;

use common::*;
use librarium_contracts::ports::{Clock, FileSystem};
use librarium_kernel::history::{retained, Origin, Version, SPACING_MS};
use librarium_kernel::writer::Lane;
use std::path::Path;

const MIN: i64 = 60_000;

fn tick(lib: &librarium_kernel::library::Library) {
    let s = &lib.store;
    s.history.tick(s.clock.now_ms(), |id| {
        let e = s.get(id)?;
        Some((e.kind.clone(), e.path.clone(), e.title.clone(), s.fs.read(&s.abs(&e.path)).ok()?))
    });
}

fn body(lib: &librarium_kernel::library::Library, hash: &str) -> String {
    String::from_utf8(lib.store.history.read(hash).unwrap()).unwrap()
}

#[test]
fn versions_are_taken_when_written_spaced_out_and_finally_the_latest() {
    let h = H::new();
    let lib = h.open();
    let (e, _) = lib.write(Lane::Interactive, |tx| tx.create("page", "Essay", vec![], "one\n", None)).unwrap();
    let id = e.id;
    assert_eq!(lib.store.history.versions(id).len(), 1, "the first version, at once");
    // Typing: saves within five minutes make no new version…
    for (i, text) in ["two\n", "three\n"].into_iter().enumerate() {
        h.clock.advance_ms(MIN);
        let v = lib.store.get(id).unwrap().hash;
        lib.write(Lane::Interactive, move |tx| tx.save_body(id, &v, None, text)).unwrap();
        assert_eq!(lib.store.history.versions(id).len(), 1, "save {i}");
    }
    // …until the spacing has passed: then the latest text is taken.
    tick(&lib);
    assert_eq!(lib.store.history.versions(id).len(), 1, "not yet");
    h.clock.advance_ms(SPACING_MS);
    tick(&lib);
    let vs = lib.store.history.versions(id);
    assert_eq!(vs.len(), 2);
    assert!(body(&lib, &vs[0].hash).ends_with("three\n"), "the newest first, with the latest text");
    assert_eq!(vs[0].origin, Origin::App);
    // The same bytes are never taken twice.
    h.clock.advance_ms(SPACING_MS);
    tick(&lib);
    assert_eq!(lib.store.history.versions(id).len(), 2);
    // Stored in the library, readable without the app.
    let objects = h.fs.files().into_iter().filter(|p| p.starts_with(h.abs(".librarium/history/objects"))).count();
    assert_eq!(objects, 2);
    assert!(h.read(".librarium/history/README.txt").contains("version history"));
}

#[test]
fn outside_edits_are_taken_at_once() {
    let h = H::new();
    let lib = h.open();
    let (e, _) = lib.write(Lane::Interactive, |tx| tx.create("page", "Shared", vec![], "mine\n", None)).unwrap();
    h.outside_write(&e.path, &h.read(&e.path).replace("mine", "theirs"));
    settle(&lib);
    let vs = lib.store.history.versions(e.id);
    assert_eq!(vs.len(), 2);
    assert_eq!(vs[0].origin, Origin::Outside);
    assert!(body(&lib, &vs[0].hash).ends_with("theirs\n"));
}

#[test]
fn a_note_deleted_outside_can_be_brought_back_with_its_id() {
    let h = H::new();
    let lib = h.open();
    let (e, _) =
        lib.write(Lane::Interactive, |tx| tx.create("page", "Fragile", vec![], "keep me\n", Some("Shelf"))).unwrap();
    let (id, path) = (e.id, e.path.clone());
    h.outside_remove(&path);
    settle(&lib);
    assert!(lib.store.get(id).is_none());
    let last = lib.store.history.versions(id)[0].clone();
    let bytes = lib.store.history.read(&last.hash).unwrap();
    let (back, _) = lib.write(Lane::Interactive, move |tx| tx.bring_back(id, &last.path, &bytes)).unwrap();
    assert_eq!(back.id, id);
    assert_eq!(back.path, path);
    assert!(h.read(&path).ends_with("keep me\n"));
}

#[test]
fn permanent_deletion_erases_the_history() {
    let h = H::new();
    let lib = h.open();
    let (e, _) = lib.write(Lane::Interactive, |tx| tx.create("page", "Gone", vec![], "secret\n", None)).unwrap();
    let (keep, _) = lib.write(Lane::Interactive, |tx| tx.create("page", "Kept", vec![], "stay\n", None)).unwrap();
    let (id, v) = (e.id, e.hash.clone());
    lib.write(Lane::Interactive, move |tx| tx.delete_permanently(id, &v)).unwrap();
    assert!(lib.store.history.versions(id).is_empty());
    assert_eq!(lib.store.history.versions(keep.id).len(), 1);
    let objects: Vec<_> =
        h.fs.files().into_iter().filter(|p| p.starts_with(h.abs(".librarium/history/objects"))).collect();
    assert_eq!(objects.len(), 1, "only the kept note's text remains: {objects:?}");
    for p in &objects {
        assert!(!String::from_utf8_lossy(&h.fs.read(p).unwrap()).contains("secret"));
    }
}

#[test]
fn other_macs_versions_are_read_never_rewritten() {
    let h = H::new();
    let lib = h.open();
    let (e, _) = lib.write(Lane::Interactive, |tx| tx.create("page", "Both", vec![], "here\n", None)).unwrap();
    // Another Mac's log and object, as sync would bring them.
    let text = "---\nid: x\n---\nthere\n";
    let hash = librarium_kernel::hash::version_of(text.as_bytes());
    h.fs.write_outside(&h.abs(&format!(".librarium/history/objects/{}/{hash}", &hash[..2])), text.as_bytes());
    let line = serde_json::to_string(&Version {
        id: e.id,
        kind: "page".into(),
        path: e.path.clone(),
        title: "Both".into(),
        hash: hash.clone(),
        ms: h.clock.now_ms() - 1000,
        origin: Origin::App,
        size: text.len() as u64,
        device: "other".into(),
    })
    .unwrap();
    h.fs.write_outside(Path::new(&h.abs(".librarium/history/log/other.jsonl")), format!("{line}\n").as_bytes());
    let vs = lib.store.history.versions(e.id);
    assert_eq!(vs.len(), 2);
    assert_eq!(vs[1].device, "other");
    // Pruning here never touches the other Mac's log or the objects it uses.
    lib.store.history.prune(h.clock.now_ms() + 400 * 86_400_000).unwrap();
    assert!(h.read(".librarium/history/log/other.jsonl").contains(&hash));
    assert!(lib.store.history.read(&hash).is_ok());
}

#[test]
fn retention_keeps_a_day_then_hourly_daily_and_weekly() {
    let now = 1_800_000_000_000i64;
    let at = |ago: i64| Version {
        id: "0192f3a4-7c1e-7b2a-9f00-000000000001".parse().unwrap(),
        kind: "page".into(),
        path: "p".into(),
        title: "t".into(),
        hash: format!("{ago}"),
        ms: now - ago,
        origin: Origin::App,
        size: 1,
        device: "d".into(),
    };
    let h = 3_600_000;
    let d = 24 * h;
    // Oldest first, as kept.
    let vs = vec![
        at(200 * d),
        at(200 * d - 1000), // the same week, long ago: one kept
        at(30 * d),
        at(30 * d - 60_000), // the same day, a month ago: one kept
        at(3 * d),
        at(3 * d - 60_000), // the same hour, three days ago: one kept
        at(10 * h),
        at(10 * h - 60_000), // today: both kept
    ];
    assert_eq!(retained(&vs, now), [false, true, false, true, false, true, true, true]);
}
