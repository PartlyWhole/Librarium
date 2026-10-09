//! Library items: an import keeps the original byte for byte, and extraction stores the text
//! once, in the shape FORMAT.md gives (a PDF, a scanned PDF, an EPUB and a picture).

mod common;

use common::{call, open, temp_dir};
use librarium::app::App;
use librarium::util::sha256;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn import(app: &App, name: &str, folder: Option<&str>) -> Value {
    let r = call(app, "library.import", json!({ "paths": [fixture(name)], "folder": folder }));
    assert_eq!(r["failed"], json!([]), "{name}");
    r["imported"][0]["info"].clone()
}

/// Waits until no job is running or waiting.
fn settle(app: &App) {
    let until = Instant::now() + Duration::from_secs(120);
    while Instant::now() < until {
        let jobs = call(app, "jobs.list", json!({}));
        if jobs["running"].as_array().unwrap().is_empty() {
            assert_eq!(jobs["failed"], json!([]), "no job failed");
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("the jobs didn't finish");
}

fn item_dir(root: &Path, info: &Value) -> PathBuf {
    root.join(info["path"].as_str().unwrap()).parent().unwrap().to_path_buf()
}

#[test]
fn an_import_keeps_the_original_byte_for_byte() {
    let d = temp_dir("import");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let original = fs::read(fixture("short.pdf")).unwrap();
    let info = import(&app, "short.pdf", None);
    let id = info["id"].as_str().unwrap();
    assert_eq!(info["path"], format!("items/{id}-short/record.json"));
    let dir = item_dir(&root, &info);
    assert_eq!(fs::read(dir.join("original.pdf")).unwrap(), original);

    let raw = fs::read_to_string(dir.join("record.json")).unwrap();
    assert!(raw.ends_with("}\n") && raw.starts_with("{\n  \"created\""), "sorted, with a trailing newline");
    let rec: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(rec["sha256"], sha256(&original));
    assert_eq!(rec["kind"], "item");
    assert_eq!(rec["kind-version"], 1);
    assert_eq!(rec["title"], "short");
    assert_eq!(rec["library.format"], "pdf");
    assert_eq!(rec["library.original"], "original.pdf");
    let p = &rec["provenance"];
    assert_eq!(p["original-name"], "short.pdf");
    assert_eq!(p["source"], Value::Null);
    assert_eq!(p["saved-at"], rec["created"]);
    assert_eq!(p["saved-with"], format!("Librarium {} (import)", env!("CARGO_PKG_VERSION")));

    // Pasted bytes go into Attachments, kept the same way; the format comes from the bytes.
    let png = fs::read(fixture("words.png")).unwrap();
    use base64::Engine as _;
    let data64 = base64::engine::general_purpose::STANDARD.encode(&png);
    let w = call(
        &app,
        "library.importData",
        json!({ "name": "Pasted image.png", "data": data64, "folder": "Attachments" }),
    );
    let pasted = &w["info"];
    assert!(pasted["path"].as_str().unwrap().starts_with("items/Attachments/"));
    assert_eq!(pasted["fields"]["library.folder"], "Attachments");
    assert_eq!(fs::read(item_dir(&root, pasted).join("original.png")).unwrap(), png);
    assert_eq!(pasted["fields"]["sha256"], sha256(&png));

    // Anything else is refused, and nothing is left behind.
    fs::write(d.join("notes.txt"), "plain text").unwrap();
    let r = call(&app, "library.import", json!({ "paths": [d.join("notes.txt")] }));
    assert_eq!(r["imported"], json!([]));
    assert_eq!(r["failed"].as_array().unwrap().len(), 1);
    settle(&app);
    assert_eq!(fs::read_dir(root.join("items")).unwrap().count(), 2, "the item and Attachments");
}

#[test]
fn text_is_extracted_once_in_the_stored_shape() {
    let d = temp_dir("extract");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let pdf = import(&app, "short.pdf", None);
    let epub = import(&app, "old.epub", None);
    settle(&app);

    // PDF: PDFKit, page by page.
    let raw = fs::read_to_string(item_dir(&root, &pdf).join("extracted/text-v1.json")).unwrap();
    assert!(raw.ends_with('}'), "no trailing newline");
    let v: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["extractor"], "pdfkit");
    assert_eq!(v["version"], 1);
    let pages = v["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0]["page"], 1);
    assert!(pages[0]["text"].as_str().unwrap().contains("Technique integrates everything."));
    let rec = call(&app, "records.get", json!({ "id": pdf["id"] }));
    assert_eq!(rec["fields"]["library.text"], "extracted/text-v1.json");
    assert_eq!(rec["fields"]["library.pages"], 2);

    // The text anchors see: pages joined by a blank line, labelled, in code points.
    let t = call(&app, "records.text", json!({ "id": pdf["id"] }));
    let p1 = pages[0]["text"].as_str().unwrap().chars().count() as u64;
    assert_eq!(t["segments"][0], json!({ "label": "p. 1", "start": 0, "end": p1 }));
    assert_eq!(t["segments"][1]["label"], "p. 2");
    assert_eq!(t["segments"][1]["start"], p1 + 2);
    assert_eq!(t["origin"], json!({ "file": "extracted/text-v1.json", "extractor": "pdfkit", "version": 1 }));
    let hits = call(&app, "search.query", json!({ "text": "integrates" }));
    assert_eq!(hits[0]["id"], pdf["id"], "the extracted text is searchable");

    // EPUB: its chapters; the book's own title replaces the file name.
    let epub = call(&app, "records.get", json!({ "id": epub["id"] }));
    assert_eq!(epub["path"], format!("items/{}-old-book/record.json", epub["id"].as_str().unwrap()));
    let v: Value =
        serde_json::from_slice(&fs::read(item_dir(&root, &epub).join("extracted/text-v1.json")).unwrap()).unwrap();
    assert_eq!(v["extractor"], "librarium-epub 1");
    assert_eq!(v["title"], "Old Book");
    assert_eq!(v["language"], "en");
    let ch = &v["chapters"][0];
    assert_eq!((ch["href"].as_str(), ch["path"].as_str()), (Some("a.html"), Some("a.html")));
    assert!(ch["text"].as_str().unwrap().contains("Old text"));
    let rec = call(&app, "records.get", json!({ "id": epub["id"] }));
    assert_eq!(rec["title"], "Old Book");
    assert_eq!(rec["fields"]["library.pages"], 1);

    // Never made again: a second run leaves the stored text alone.
    let file = item_dir(&root, &pdf).join("extracted/text-v1.json");
    let before = fs::metadata(&file).unwrap().modified().unwrap();
    let lib = app.library().unwrap();
    lib.jobs.enqueue(&lib, "library.extract", "again", json!({ "id": pdf["id"] }));
    settle(&app);
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), before);
}

/// Needs Apple Vision, which is on every Mac this app runs on.
#[test]
fn pictures_and_scans_are_recognised() {
    let d = temp_dir("vision");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let png = import(&app, "words.png", None);
    let scan = import(&app, "scan.pdf", None);
    settle(&app);

    let v: Value =
        serde_json::from_slice(&fs::read(item_dir(&root, &png).join("extracted/text-v1.json")).unwrap()).unwrap();
    assert_eq!(v["extractor"], "apple-vision 1");
    assert_eq!(v["version"], 1);
    assert!(v["image"]["width"].as_u64().is_some() && v["image"]["height"].as_u64().is_some());
    let page = &v["pages"][0];
    assert_eq!(page["page"], 1);
    assert!(page["text"].as_str().unwrap().contains("generosity"), "{}", page["text"]);
    let line = page["lines"][0].as_object().unwrap();
    let mut keys: Vec<&str> = line.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, ["confidence", "h", "text", "w", "x", "y"]);
    assert!((0.0..=1.0).contains(&line["y"].as_f64().unwrap()), "fractions from the top left");

    let v: Value =
        serde_json::from_slice(&fs::read(item_dir(&root, &scan).join("extracted/text-v1.json")).unwrap()).unwrap();
    assert_eq!(v["extractor"], "pdfkit + apple-vision 1");
    assert_eq!(v["pages"][0]["recognized"], true);
    assert!(v["pages"][0]["text"].as_str().unwrap().contains("generosity"));
    assert!(v["pages"][0]["lines"].as_array().is_some_and(|l| !l.is_empty()));
}
