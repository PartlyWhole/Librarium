//! The link grammar (cases shared with the interface in `tests/links.json`), slugs, IDs and
//! dates: all decide what is written into the user's files.

use librarium::links::{format_link, parse_links};
use librarium::util::{iso_utc, local_date, parse_id, slugify};
use serde_json::{json, Value};

#[test]
fn links_follow_the_shared_cases() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/links.json");
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(cases.len() >= 10);
    for c in cases {
        let input = c["input"].as_str().unwrap();
        let got: Vec<Value> = parse_links(input)
            .into_iter()
            .map(|l| json!({ "raw": &input[l.range.clone()], "label": l.label, "id": l.id.map(|i| i.to_string()), "embed": l.embed }))
            .collect();
        assert_eq!(Value::Array(got), c["links"], "case: {}", c["name"]);
    }
}

#[test]
fn written_links_read_back() {
    let id = parse_id("0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44").unwrap();
    for (label, read) in [
        ("plain", "plain"),
        ("a|b", "a|b"),
        ("[x]", "[x]"),
        ("back\\slash", "back\\slash"),
        ("two\n\nlines", "two lines"),
    ] {
        let l = &parse_links(&format_link(label, id, true))[0];
        assert_eq!((l.id, l.label.as_str(), l.embed), (Some(id), read, true));
    }
}

#[test]
fn slugs() {
    assert_eq!(slugify("Jacques Ellul"), "jacques-ellul");
    assert_eq!(slugify("  Éthique — et  Technique! "), "ethique-et-technique");
    assert_eq!(slugify("2026-10-02"), "2026-10-02");
    assert_eq!(slugify("技術と社会"), "技術と社会");
    assert_eq!(slugify("???"), "");
    assert!(slugify(&"word ".repeat(40)).chars().count() <= 64);
}

#[test]
fn ids_and_dates() {
    assert!(parse_id("0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44").is_some());
    assert!(parse_id("0192F3A4-7C1E-7B2A-9F00-3E5D8C1A2B44").is_none(), "uppercase is damaged");
    assert!(parse_id("0192f3a47c1e7b2a9f003e5d8c1a2b44").is_none(), "short forms are damaged");
    assert_eq!(iso_utc(1_790_932_440_000), "2026-10-02T09:14:00Z");
    // 09:14Z in UTC-7 is 02:14 local: before the day starts at 4, so still the 1st.
    assert_eq!(local_date(1_790_932_440_000, -7 * 3600, 4), "2026-10-01");
    assert_eq!(local_date(1_790_932_440_000, -7 * 3600, 0), "2026-10-02");
}
