//! Captures on the test adapters: sidecars first, pairing by the ID inside, orphans kept.
use base64::Engine as _;
use librarium_contracts::api::{CaptureParams, CapturePart};
use librarium_contracts::ports::{ChangeSource, FileSystem, IndexEngine};
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
use serde_json::json;
use std::path::Path;
use std::sync::Arc;

fn open() -> (Arc<Library>, Arc<MemFs>) {
    let fs = Arc::new(MemFs::new());
    fs.create_dir_all(Path::new("/lib")).unwrap();
    let mut k = Kinds::new();
    k.add(
        "test",
        RecordKindDef {
            kind: "page".into(),
            version: 1,
            format: Format::Markdown,
            folder: "pages".into(),
            slugged: true,
            subfolder_field: None,
        },
    )
    .unwrap();
    librarium_feature_captures::contribute_kinds(&mut k).unwrap();
    let index = MemIndex::new();
    let lib = Library::open(
        Path::new("/lib"),
        Path::new("/app"),
        LibraryPorts {
            fs: fs.clone() as Arc<dyn FileSystem>,
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
    (Arc::new(lib), fs)
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake image bytes";

#[test]
fn a_capture_keeps_its_quote_anchor_and_region() {
    let (lib, fs) = open();
    let (src, _) = lib.write(Lane::Interactive, |tx| tx.create("page", "The Source", vec![], "text", None)).unwrap();
    let get = |_: &str| None;
    let ctx = MethodCtx { library: &lib, setting: &get, views: None, jobs: None };
    let w = librarium_feature_captures::create(
        &ctx,
        CaptureParams {
            source: src.id,
            snapshot: None,
            text: Some(json!({ "file": "extracted/text-v1.json", "extractor": "pdf-extract 0.12", "version": 1 })),
            parts: vec![
                CapturePart { selector: vec![json!({ "type": "TextQuoteSelector", "exact": "Technique integrates everything.", "prefix": "", "suffix": " It avoids" }), json!({ "type": "TextPositionSelector", "start": 0, "end": 32 }), json!({ "type": "FragmentSelector", "value": "page=1", "conformsTo": "http://tools.ietf.org/rfc/rfc8118" })], quote: "Technique integrates everything.".into(), locator: Some("p. 1".into()), region_png: None, boxes: vec![json!({ "page": 1, "x": 10, "y": 5, "w": 30, "h": 2 })] },
                CapturePart { selector: vec![json!({ "type": "FragmentSelector", "value": "xywh=percent:10,20,30,40", "conformsTo": "http://www.w3.org/TR/media-frags/" })], quote: String::new(), locator: Some("p. 2".into()), region_png: Some(base64::engine::general_purpose::STANDARD.encode(PNG)), boxes: vec![] },
            ],
            words: "This is why it matters.".into(),
        },
    )
    .unwrap();
    let id = w.info.id;
    assert_eq!(w.info.path, format!("captures/{id}.md"));
    assert_eq!(w.info.title, "Technique integrates everything.");
    assert_eq!(w.info.fields["captures.quote"], "Technique integrates everything.");
    assert_eq!(w.info.fields["captures.locator"], "p. 1");
    let md = String::from_utf8(fs.read(Path::new(&format!("/lib/captures/{id}.md"))).unwrap()).unwrap();
    assert!(md.ends_with("---\nThis is why it matters.\n"), "{md}");
    assert_eq!(fs.read(Path::new(&format!("/lib/captures/{id}.region-2.png"))).unwrap(), PNG);
    let a = librarium_feature_captures::anchor(&lib.store, id).unwrap();
    assert_eq!(a["id"], id.to_string());
    assert_eq!(a["parts"][1]["region"], ".region-2.png");
    assert_eq!(a["parts"][0]["boxes"][0]["page"], 1, "where the part is drawn is kept");
    assert!(a["parts"][1].get("boxes").is_none());
    // The source's captures, with where to highlight them (a region's from its selector).
    let marks = librarium_feature_captures::for_source(&lib.store, src.id, None);
    assert_eq!(marks.len(), 1);
    assert_eq!(marks[0]["id"], id.to_string());
    assert_eq!(marks[0]["parts"][0]["boxes"][0]["x"], 10);
    assert_eq!(marks[0]["parts"][1]["region"], true);
    assert_eq!(marks[0]["parts"][1]["boxes"][0], json!({ "x": 10.0, "y": 20.0, "w": 30.0, "h": 40.0 }));
    assert!(
        librarium_feature_captures::for_source(&lib.store, src.id, Some("2026-10-02T091400Z")).is_empty(),
        "not of another snapshot"
    );
    assert_eq!(a["text"]["extractor"], "pdf-extract 0.12");

    // Paired by the ID inside, not the name.
    fs.write_outside(
        Path::new("/lib/captures/renamed.anchor.json"),
        &fs.read(Path::new(&format!("/lib/captures/{id}.anchor.json"))).unwrap(),
    );
    fs.remove_outside(Path::new(&format!("/lib/captures/{id}.anchor.json")));
    assert_eq!(librarium_feature_captures::anchor(&lib.store, id).unwrap()["id"], id.to_string());

    // A sidecar with no capture is listed, never deleted.
    fs.write_outside(
        Path::new("/lib/captures/0192f3a4-7c1e-7b2a-9f00-0000000000ff.anchor.json"),
        br#"{"id":"0192f3a4-7c1e-7b2a-9f00-0000000000ff","parts":[]}"#,
    );
    let o = librarium_feature_captures::orphans(&lib.store);
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].path, "captures/0192f3a4-7c1e-7b2a-9f00-0000000000ff.anchor.json");
    assert!(fs.read(Path::new("/lib/captures/0192f3a4-7c1e-7b2a-9f00-0000000000ff.anchor.json")).is_ok());
}

#[test]
fn sidecars_are_written_before_the_record() {
    let (lib, fs) = open();
    let (src, _) = lib.write(Lane::Interactive, |tx| tx.create("page", "S", vec![], "", None)).unwrap();
    let before = fs.ops();
    let get = |_: &str| None;
    let ctx = MethodCtx { library: &lib, setting: &get, views: None, jobs: None };
    // Crash just after the sidecar's rename: the anchor exists, the capture does not.
    fs.crash_after(5);
    let r = librarium_feature_captures::create(
        &ctx,
        CaptureParams {
            source: src.id,
            snapshot: None,
            text: None,
            parts: vec![CapturePart {
                selector: vec![],
                quote: "q".into(),
                locator: None,
                region_png: None,
                boxes: vec![],
            }],
            words: String::new(),
        },
    );
    assert!(r.is_err());
    let _ = before;
    fs.restart();
    assert!(lib.store.list(Some("capture")).is_empty());
}

#[test]
fn editing_a_capture_replaces_its_parts_and_quote_and_keeps_the_words() {
    let (lib, fs) = open();
    let (src, _) = lib.write(Lane::Interactive, |tx| tx.create("page", "The Source", vec![], "text", None)).unwrap();
    let get = |_: &str| None;
    let ctx = MethodCtx { library: &lib, setting: &get, views: None, jobs: None };
    let part = |q: &str| CapturePart {
        selector: vec![json!({ "type": "TextQuoteSelector", "exact": q, "prefix": "", "suffix": "" })],
        quote: q.into(),
        locator: Some("p. 1".into()),
        region_png: None,
        boxes: vec![json!({ "page": 1, "x": 1, "y": 2, "w": 3, "h": 4 })],
    };
    let w = librarium_feature_captures::create(
        &ctx,
        CaptureParams {
            source: src.id,
            snapshot: None,
            text: None,
            parts: vec![part("Technique integrates everything.")],
            words: "Why it matters.".into(),
        },
    )
    .unwrap();
    let id = w.info.id;
    // An automatic title follows the new quote; the words stay.
    let u = librarium_feature_captures::update(
        &ctx,
        librarium_feature_captures::UpdateParams {
            id,
            parts: vec![
                part("Technique integrates everything. It avoids shock"),
                CapturePart {
                    selector: vec![json!({ "type": "FragmentSelector", "value": "xywh=percent:10,20,30,40" })],
                    quote: String::new(),
                    locator: None,
                    region_png: Some(base64::engine::general_purpose::STANDARD.encode(PNG)),
                    boxes: vec![],
                },
            ],
        },
    )
    .unwrap();
    assert_eq!(u.info.id, id);
    assert_eq!(u.info.fields["captures.quote"], "Technique integrates everything. It avoids shock");
    assert_eq!(u.info.fields["captures.parts"], 2);
    assert_eq!(u.info.title, "Technique integrates everything. It avoids shock");
    let md = String::from_utf8(fs.read(Path::new(&format!("/lib/captures/{id}.md"))).unwrap()).unwrap();
    assert!(md.ends_with("---\nWhy it matters.\n"), "{md}");
    let a = librarium_feature_captures::anchor(&lib.store, id).unwrap();
    assert_eq!(a["parts"].as_array().unwrap().len(), 2);
    assert_eq!(a["parts"][0]["selector"][0]["exact"], "Technique integrates everything. It avoids shock");
    assert_eq!(a["parts"][1]["region"], ".region-2.png");
    assert_eq!(a["source"], src.id.to_string(), "the rest of the anchor is kept");
    assert_eq!(fs.read(Path::new(&format!("/lib/captures/{id}.region-2.png"))).unwrap(), PNG);
    // A title the user gave stays.
    lib.write(Lane::Interactive, move |tx| tx.relocate_from(id, None, Some("On technique"), None)).unwrap();
    let u = librarium_feature_captures::update(
        &ctx,
        librarium_feature_captures::UpdateParams { id, parts: vec![part("It avoids shock")] },
    )
    .unwrap();
    assert_eq!(u.info.title, "On technique");
    assert_eq!(u.info.fields["captures.parts"], 1);
    assert!(
        librarium_feature_captures::update(&ctx, librarium_feature_captures::UpdateParams { id, parts: vec![] })
            .is_err(),
        "a capture keeps a part"
    );
}
