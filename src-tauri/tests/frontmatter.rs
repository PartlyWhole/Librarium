//! Frontmatter round trips: edits change only the bytes of the key edited.

use librarium::store::frontmatter::{join, resolve_plain, split, FmError, FmValue, Frontmatter};

const SAMPLE: &str = "# my own comment\nid: \"0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44\"\nkind: note\nkind-version: 1\ntitle: 'Jacques Ellul'   # kept\nunknown.thing: {a: 1, b: [x, y]}\ntags:\n  - philosophy\n  - \"technique\"\n\n# between\nflow: [1, 'two']\nempty:\nlit: |\n  keep me\n  exactly\nlast: plain value # c\n";

#[test]
fn reads_values_in_order() {
    let fm = Frontmatter::parse(SAMPLE).unwrap();
    let keys: Vec<_> = fm.keys().collect();
    assert_eq!(keys, ["id", "kind", "kind-version", "title", "unknown.thing", "tags", "flow", "empty", "lit", "last"]);
    assert_eq!(fm.get_str("title"), Some("Jacques Ellul"));
    assert_eq!(fm.get("kind-version"), Some(&FmValue::Int(1)));
    assert_eq!(
        fm.get("tags"),
        Some(&FmValue::List(vec![FmValue::Str("philosophy".into()), FmValue::Str("technique".into())]))
    );
    assert_eq!(fm.get("empty"), Some(&FmValue::Null));
    assert_eq!(fm.get_str("lit"), Some("keep me\nexactly\n"));
    assert_eq!(fm.get_str("last"), Some("plain value"));
}

fn edit(src: &str, key: &str, v: FmValue) -> String {
    let mut fm = Frontmatter::parse(src).unwrap();
    fm.set(key, &v).unwrap();
    fm.text().to_string()
}

#[test]
fn set_changes_only_that_value() {
    let out = edit(SAMPLE, "title", FmValue::Str("Ellul, J.".into()));
    assert_eq!(out, SAMPLE.replace("'Jacques Ellul'", "\"Ellul, J.\""));
    let out = edit(SAMPLE, "kind-version", FmValue::Int(2));
    assert_eq!(out, SAMPLE.replace("kind-version: 1", "kind-version: 2"));
    let out = edit(SAMPLE, "last", FmValue::Bool(true));
    assert_eq!(out, SAMPLE.replace("last: plain value # c", "last: true # c"));
    let out = edit(SAMPLE, "empty", FmValue::Str("x".into()));
    assert_eq!(out, SAMPLE.replace("empty:\n", "empty: \"x\"\n"));
    let out = edit(SAMPLE, "flow", FmValue::List(vec![FmValue::Int(3)]));
    assert_eq!(out, SAMPLE.replace("[1, 'two']", "[3]"));
}

#[test]
fn block_lists_keep_their_style() {
    let out = edit(SAMPLE, "tags", FmValue::List(vec![FmValue::Str("a".into()), FmValue::Str("b c".into())]));
    assert_eq!(out, SAMPLE.replace("  - philosophy\n  - \"technique\"", "  - \"a\"\n  - \"b c\""));
}

#[test]
fn unchanged_value_is_a_no_op_and_new_keys_append() {
    assert_eq!(edit(SAMPLE, "title", FmValue::Str("Jacques Ellul".into())), SAMPLE);
    let out = edit(SAMPLE, "x.date", FmValue::Str("2026-10-02".into()));
    assert_eq!(out, format!("{SAMPLE}x.date: \"2026-10-02\"\n"));
}

#[test]
fn remove_takes_only_that_entry() {
    let mut fm = Frontmatter::parse(SAMPLE).unwrap();
    fm.remove("tags").unwrap();
    assert_eq!(fm.text(), SAMPLE.replace("tags:\n  - philosophy\n  - \"technique\"\n", ""));
}

#[test]
fn complex_values_are_refused() {
    for key in ["lit", "unknown.thing"] {
        let mut fm = Frontmatter::parse(SAMPLE).unwrap();
        assert_eq!(fm.set(key, &FmValue::Int(1)), Err(FmError::Complex(key.into())));
    }
    let multi = "title: a long\n  plain title\n";
    let mut fm = Frontmatter::parse(multi).unwrap();
    assert_eq!(fm.get_str("title"), Some("a long plain title"));
    assert!(fm.set("title", &FmValue::Str("x".into())).is_err());
    let anchored = "a: &x 1\nb: *x\n";
    let mut fm = Frontmatter::parse(anchored).unwrap();
    assert!(fm.set("a", &FmValue::Int(2)).is_err());
    assert!(fm.set("b", &FmValue::Int(2)).is_err());
}

#[test]
fn invalid_yaml_is_an_error() {
    assert!(matches!(Frontmatter::parse("a: [1, 2\n"), Err(FmError::Invalid(_))));
    assert!(matches!(Frontmatter::parse("- a\n- b\n"), Err(FmError::Invalid(_))));
    assert!(matches!(Frontmatter::parse("a: 1\na: 2\n"), Err(FmError::Invalid(_))));
}

#[test]
fn unicode_positions_are_bytes() {
    let src = "title: \"Éllul — ü\"\nnote: ok\n";
    assert_eq!(edit(src, "note", FmValue::Str("ß".into())), "title: \"Éllul — ü\"\nnote: \"ß\"\n");
    assert_eq!(edit(src, "title", FmValue::Str("x".into())), "title: \"x\"\nnote: ok\n");
}

#[test]
fn crlf_is_preserved() {
    let src = "a: 1\r\nb: 2\r\n";
    assert_eq!(edit(src, "c", FmValue::Int(3)), "a: 1\r\nb: 2\r\nc: 3\r\n");
    assert_eq!(edit(src, "a", FmValue::Int(9)), "a: 9\r\nb: 2\r\n");
}

#[test]
fn core_schema() {
    assert_eq!(resolve_plain("2026-10-02"), FmValue::Str("2026-10-02".into()));
    assert_eq!(resolve_plain("1.5e3"), FmValue::Float(1500.0));
    assert_eq!(resolve_plain("0x1F"), FmValue::Int(31));
    assert_eq!(resolve_plain("yes"), FmValue::Str("yes".into()));
    assert_eq!(resolve_plain("~"), FmValue::Null);
}

#[test]
fn split_and_join() {
    let file = "---\nid: \"x\"\n---\n# Body\n";
    let (fm, body) = split(file);
    assert_eq!(fm.unwrap().0, "id: \"x\"\n");
    assert_eq!(body, "# Body\n");
    assert_eq!(join("id: \"x\"\n", body, "\n"), file);
    assert_eq!(split("no frontmatter\n").0, None);
    assert_eq!(split("---\nunterminated\n").0, None);
    let (fm, body) = split("---\n---\nbody");
    assert_eq!(fm.unwrap().0, "");
    assert_eq!(body, "body");
}

#[test]
fn emitted_strings_read_back() {
    for s in ["plain", "with \"quotes\"", "back\\slash", "new\nline", "tab\there", "ünï — 😀", "#hash", ": colon"]
    {
        let src = format!("k: {}\n", FmValue::Str(s.into()).emit());
        assert_eq!(Frontmatter::parse(&src).unwrap().get_str("k"), Some(s), "{src}");
    }
}
