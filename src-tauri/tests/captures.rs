//! A capture's files are exactly as FORMAT.md shows them: the frontmatter in order, the anchor
//! JSON (sorted keys, no trailing newline) and the region pictures' names.

mod common;

use base64::Engine as _;
use common::{call, open, temp_dir};
use serde_json::{json, Value};
use std::fs;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot really a picture";

#[test]
fn capture_files_are_as_the_format_says() {
    let d = temp_dir("capture");
    let (root, data) = (d.join("lib"), d.join("data"));
    fs::create_dir_all(&root).unwrap();
    let app = open(&root, &data);
    let source = call(&app, "notes.create", json!({ "title": "Ellul", "body": "text\n" }))["info"].clone();
    let src = source["id"].as_str().unwrap();
    let png64 = base64::engine::general_purpose::STANDARD.encode(PNG);
    let quote_sel = json!({ "type": "TextQuoteSelector", "exact": "The technique", "prefix": "", "suffix": " of" });
    let page =
        json!({ "type": "FragmentSelector", "value": "page=3", "conformsTo": "http://tools.ietf.org/rfc/rfc8118" });
    let text_part = json!({ "selector": [quote_sel, page], "quote": "  The technique of our time is the one thing that matters  ", "locator": "p. 3" });
    let region_part = json!({ "selector": [], "quote": "", "region_png": png64, "boxes": [{ "page": 3, "x": 1.5, "y": 2, "w": 10, "h": 20 }] });
    let w = call(
        &app,
        "captures.create",
        json!({ "source": src, "snapshot": null, "text": null, "parts": [text_part, region_part], "words": "My own words.  \n\n" }),
    );
    let info = &w["info"];
    let id = info["id"].as_str().unwrap();
    assert_eq!(info["path"], format!("captures/{id}.md"));
    let md = fs::read_to_string(root.join(format!("captures/{id}.md"))).unwrap();
    let created = info["created"].as_str().unwrap();
    assert_eq!(
        md,
        format!(
            "---\nid: \"{id}\"\nkind: \"capture\"\nkind-version: 1\ncreated: \"{created}\"\ntitle: \"The technique of our time is the one…\"\ncaptures.source: \"{src}\"\ncaptures.quote: \"The technique of our time is the one thing that matters\"\ncaptures.parts: 2\ncaptures.locator: \"p. 3\"\n---\nMy own words.\n"
        )
    );

    let anchor = fs::read_to_string(root.join(format!("captures/{id}.anchor.json"))).unwrap();
    let expected = format!(
        r#"{{
  "id": "{id}",
  "parts": [
    {{
      "selector": [
        {{
          "exact": "The technique",
          "prefix": "",
          "suffix": " of",
          "type": "TextQuoteSelector"
        }},
        {{
          "conformsTo": "http://tools.ietf.org/rfc/rfc8118",
          "type": "FragmentSelector",
          "value": "page=3"
        }}
      ]
    }},
    {{
      "boxes": [
        {{
          "h": 20,
          "page": 3,
          "w": 10,
          "x": 1.5,
          "y": 2
        }}
      ],
      "region": ".region-2.png",
      "selector": []
    }}
  ],
  "snapshot": null,
  "source": "{src}",
  "text": null
}}"#
    );
    assert_eq!(anchor, expected, "sorted keys, no trailing newline");
    assert_eq!(fs::read(root.join(format!("captures/{id}.region-2.png"))).unwrap(), PNG);
    assert!(!root.join(format!("captures/{id}.region-1.png")).exists(), "parts are numbered by place");

    // New parts: the region comes first now, so its picture is written as region-1; the old
    // region-2 stays in place. The automatic title follows the quote; the words stay.
    let moved = json!({ "selector": [], "quote": "", "region_png": png64, "boxes": [] });
    let text = json!({ "selector": [], "quote": "Another passage" });
    call(&app, "captures.update", json!({ "id": id, "parts": [moved, text] }));
    assert_eq!(fs::read(root.join(format!("captures/{id}.region-1.png"))).unwrap(), PNG);
    assert!(root.join(format!("captures/{id}.region-2.png")).exists());
    let md = fs::read_to_string(root.join(format!("captures/{id}.md"))).unwrap();
    assert!(md.contains("title: \"Another passage\"\n"), "{md}");
    assert!(md.contains("captures.quote: \"Another passage\"\ncaptures.parts: 2\n---\nMy own words.\n"), "{md}");
    assert!(!md.contains("captures.locator"), "removed when no part has one");
    let a: Value = serde_json::from_slice(&fs::read(root.join(format!("captures/{id}.anchor.json"))).unwrap()).unwrap();
    assert_eq!(a["parts"][0]["region"], ".region-1.png");
    assert_eq!(a["source"], src);

    // A sidecar without a capture is listed, never deleted.
    fs::write(root.join("captures/0192f3b0-0000-7000-8000-00000000dead.region-1.png"), PNG).unwrap();
    let orphans = call(&app, "captures.orphans", json!({}));
    assert_eq!(
        orphans,
        json!([{ "path": "captures/0192f3b0-0000-7000-8000-00000000dead.region-1.png", "id": "0192f3b0-0000-7000-8000-00000000dead" }])
    );
}
