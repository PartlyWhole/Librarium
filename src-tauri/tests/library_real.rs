//! Importing PDFs, images and EPUBs with the real adapters and the real worker (§8, milestone 5).
use librarium_app::compose::App;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/library").join(name)
}

fn sha(p: &Path) -> String {
    Sha256::digest(std::fs::read(p).unwrap()).iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn imports_keep_originals_byte_for_byte_and_their_text_is_searchable() {
    let d = std::env::temp_dir().join(format!("librarium-import-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("lib")).unwrap();
    let a = App::compose(librarium_testkit::binaries::worker_binary(), d.join("support"), d.join("logs"));
    a.api.open_library(&d.join("lib")).unwrap();
    let files =
        ["short.pdf", "text-100.pdf", "jbig2_symbol_offset.pdf", "bug_jpx.pdf", "notebooks.epub", "gradient.png"];
    let paths: Vec<String> = files.iter().map(|f| fixture(f).display().to_string()).collect();
    let r = a.api.call("library.import", json!({ "paths": paths })).unwrap();
    assert_eq!(r["failed"], json!([]), "{r}");
    let imported = r["imported"].as_array().unwrap();
    assert_eq!(imported.len(), files.len());

    let lib = a.api.library().unwrap();
    for (f, w) in files.iter().zip(imported) {
        let id = w["info"]["id"].as_str().unwrap().parse().unwrap();
        let orig = librarium_feature_library::file_path(&lib.store, id, None).unwrap();
        assert_eq!(sha(&orig), sha(&fixture(f)), "{f} is byte-identical");
        assert_eq!(
            w["info"]["fields"]["library.format"],
            match *f {
                f if f.ends_with(".pdf") => "pdf",
                f if f.ends_with(".epub") => "epub",
                _ => "image",
            }
        );
        let rj: Value = serde_json::from_slice(&std::fs::read(orig.with_file_name("record.json")).unwrap()).unwrap();
        assert_eq!(rj["sha256"], sha(&fixture(f)));
        assert_eq!(rj["provenance"]["original-name"], *f);
        assert!(orig.parent().unwrap().starts_with(d.join("lib/items")));
    }
    // Staging is empty again.
    let staging = std::fs::read_dir(lib.app_dir.join("staging")).unwrap().count();
    assert_eq!(staging, 0);

    // Extraction jobs run in the worker and store their text.
    let jobs = &a.api.hosts().unwrap().jobs;
    let deadline = Instant::now() + Duration::from_secs(60);
    while (!jobs.list().running.is_empty()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(jobs.list().failed.is_empty(), "{:?}", jobs.list().failed);
    let items = a.api.records_list(librarium_contracts::api::ListParams { kind: Some("item".into()) }).unwrap();
    let book = items.iter().find(|i| i.fields["library.format"] == "epub").unwrap();
    assert_eq!(book.title, "Notebooks", "the EPUB's own title replaces the file name");
    let pdf = items.iter().find(|i| i.title == "text-100").unwrap();
    assert_eq!(pdf.fields["library.pages"], 100);
    let seq = lib.store.changes.last_seq();
    assert!(a.api.hosts().unwrap().views.wait_applied(seq, Duration::from_secs(10)));
    let hits = a.api.call("search.query", json!({ "text": "\"rarest and purest\"", "kinds": ["item"] })).unwrap();
    assert_eq!(hits[0]["title"], "Notebooks");
    let hits = a.api.call("search.query", json!({ "text": "\"Line 7 of page 42\"" })).unwrap();
    assert_eq!(hits[0]["title"], "text-100");

    // The stored text anchors refer to, with a segment per page.
    let st = a.api.call("records.text", json!({ "id": pdf.id })).unwrap();
    assert_eq!(st["segments"].as_array().unwrap().len(), 100);
    assert_eq!(st["segments"][41]["label"], "p. 42");
    assert_eq!(st["origin"]["extractor"], "pdfkit");
    let seg = &st["segments"][41];
    let page: String = st["text"]
        .as_str()
        .unwrap()
        .chars()
        .skip(seg["start"].as_u64().unwrap() as usize)
        .take((seg["end"].as_u64().unwrap() - seg["start"].as_u64().unwrap()) as usize)
        .collect();
    assert!(page.starts_with("Page 42"), "{page}");

    // A capture on page 42: sidecar first, then the record; its anchor holds its own ID.
    let w = a.api.call("captures.create", json!({
        "source": pdf.id,
        "text": st["origin"],
        "parts": [{ "selector": [{ "type": "TextQuoteSelector", "exact": "Line 7 of page 42", "prefix": "", "suffix": "" }, { "type": "FragmentSelector", "value": "page=42", "conformsTo": "http://tools.ietf.org/rfc/rfc8118" }], "quote": "Line 7 of page 42", "locator": "p. 42" }],
        "words": "Mine."
    })).unwrap();
    let cid = w["info"]["id"].as_str().unwrap();
    let md = d.join("lib/captures").join(format!("{cid}.md"));
    assert!(std::fs::read_to_string(&md).unwrap().contains("captures.quote: \"Line 7 of page 42\""));
    let anchor: Value =
        serde_json::from_slice(&std::fs::read(d.join("lib/captures").join(format!("{cid}.anchor.json"))).unwrap())
            .unwrap();
    assert_eq!(anchor["id"], cid);
    assert_eq!(anchor["source"], pdf.id.to_string());
    a.api.close_library();
    let _ = std::fs::remove_dir_all(&d);
}
