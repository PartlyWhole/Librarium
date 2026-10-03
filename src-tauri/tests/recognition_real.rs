//! Words in an image (and a scanned PDF) can be found and captured; recognition results are
//! stored and survive an index rebuild (§8, milestone 8). Real adapters, real worker, Vision.
use librarium_app::compose::App;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

fn fixture(n: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/library").join(n).display().to_string()
}

fn app(d: &Path) -> App {
    let a = App::compose(librarium_testkit::binaries::worker_binary(), d.join("support"), d.join("logs"));
    a.api.open_library(&d.join("lib")).unwrap();
    assert!(a.api.hosts().unwrap().views.wait_applied(0, Duration::from_secs(60)));
    a
}

fn settle(a: &App) {
    let jobs = &a.api.hosts().unwrap().jobs;
    let deadline = Instant::now() + Duration::from_secs(120);
    while !jobs.list().running.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(jobs.list().failed.is_empty(), "{:?}", jobs.list().failed);
    let seq = a.api.library().unwrap().store.changes.last_seq();
    assert!(a.api.hosts().unwrap().views.wait_applied(seq, Duration::from_secs(20)));
}

fn stored_files(d: &Path) -> Vec<(PathBuf, SystemTime)> {
    let mut out = vec![];
    for e in std::fs::read_dir(d.join("lib/items")).unwrap().flatten() {
        let f = e.path().join("extracted/text-v1.json");
        out.push((f.clone(), std::fs::metadata(&f).unwrap().modified().unwrap()));
    }
    out.sort();
    out
}

#[test]
fn words_in_images_and_scans_are_found_captured_and_kept() {
    let d = std::env::temp_dir().join(format!("librarium-ocr-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("lib")).unwrap();
    let a = app(&d);
    let r = a.api.call("library.import", json!({ "paths": [fixture("words.png"), fixture("scan.pdf")] })).unwrap();
    assert_eq!(r["failed"], json!([]));
    settle(&a);

    // Found by search, in both.
    let hits = a.api.call("search.query", json!({ "text": "\"rarest form of generosity\"" })).unwrap();
    let mut titles: Vec<&str> = hits.as_array().unwrap().iter().map(|h| h["title"].as_str().unwrap()).collect();
    titles.sort();
    assert_eq!(titles, ["scan", "words"]);

    // Captured: the quote anchors in the recognised text of the image.
    let img = a
        .api
        .records_list(librarium_contracts::api::ListParams { kind: Some("item".into()) })
        .unwrap()
        .into_iter()
        .find(|i| i.title == "words")
        .unwrap();
    let st = a.api.call("records.text", json!({ "id": img.id })).unwrap();
    let text = st["text"].as_str().unwrap();
    let start = text.chars().collect::<String>().find("Gravity and grace").map(|b| text[..b].chars().count()).unwrap();
    let w = a.api.call("captures.create", json!({
        "source": img.id, "text": st["origin"],
        "parts": [{ "selector": [{ "type": "TextQuoteSelector", "exact": "Gravity and grace are two forces.", "prefix": "", "suffix": "\nAttention" }, { "type": "TextPositionSelector", "start": start, "end": start + 33 }], "quote": "Gravity and grace are two forces." }],
        "words": ""
    })).unwrap();
    assert_eq!(w["info"]["fields"]["captures.quote"], "Gravity and grace are two forces.");
    let stored = librarium_feature_library::stored_text(
        &a.api.library().unwrap().store,
        &a.api.library().unwrap().store.get(img.id).unwrap(),
    )
    .unwrap();
    assert!(stored["extractor"].as_str().unwrap().starts_with("apple-vision"));
    assert_eq!(
        stored["pages"][0]["lines"].as_array().unwrap().len(),
        3,
        "lines with their places, for selecting in the reader"
    );

    // Deleting the index and restarting rebuilds everything without re-running recognition.
    let before = stored_files(&d);
    a.api.close_library();
    drop(a);
    let lib_dir = std::fs::read_dir(d.join("support/libraries")).unwrap().flatten().next().unwrap().path();
    std::fs::remove_dir_all(lib_dir.join("index")).unwrap();
    let a = app(&d);
    settle(&a);
    assert_eq!(stored_files(&d), before, "recognition results were not rewritten");
    let hits = a.api.call("search.query", json!({ "text": "quote exactly" })).unwrap();
    assert_eq!(hits.as_array().unwrap().len(), 2);
    a.api.close_library();
    let _ = std::fs::remove_dir_all(&d);
}
