//! The link parser (§5.4): `[[label|uuid]]` and embeds `![[label|uuid]]`.
//!
//! - The ID follows the last unescaped `|` and must be a canonical UUID. In a table cell the
//!   separator is written `\|`, so when no unescaped `|` is left, a final `\|` before a
//!   canonical UUID is the separator.
//! - In labels, `\`, `[`, `]` and `|` are escaped with `\`; newlines become spaces.
//! - Links inside code spans and code blocks are not links: code is found with a real
//!   Markdown parser (pulldown-cmark), not a regex.

use librarium_contracts::Id;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use std::ops::Range;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// Byte range of the whole link (including `!` for an embed).
    pub range: Range<usize>,
    pub label: String,
    pub id: Option<Id>,
    pub embed: bool,
}

/// Byte ranges of code (spans and blocks) in Markdown text.
pub fn code_ranges(text: &str) -> Vec<Range<usize>> {
    let mut out = vec![];
    let mut block_start: Option<usize> = None;
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for (ev, r) in Parser::new_ext(text, opts).into_offset_iter() {
        match ev {
            Event::Code(_) => out.push(r),
            Event::Start(Tag::CodeBlock(_)) => block_start = Some(r.start),
            Event::End(TagEnd::CodeBlock) => {
                if let Some(s) = block_start.take() {
                    out.push(s..r.end);
                }
            }
            Event::Html(_) | Event::InlineHtml(_) => out.push(r),
            _ => {}
        }
    }
    out
}

/// Escapes a label for writing inside `[[…]]`.
pub fn escape_label(label: &str) -> String {
    let mut s = String::with_capacity(label.len());
    for c in label.chars() {
        match c {
            '\\' | '[' | ']' | '|' => {
                s.push('\\');
                s.push(c);
            }
            '\n' | '\r' => s.push(' '),
            _ => s.push(c),
        }
    }
    s
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some(n @ ('\\' | '[' | ']' | '|')) => out.push(n),
                Some(n) => {
                    out.push('\\');
                    out.push(n);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Writes a link (or an embed).
pub fn format_link(label: &str, id: Id, embed: bool) -> String {
    format!("{}[[{}|{id}]]", if embed { "!" } else { "" }, escape_label(label))
}

/// Parses the inside of `[[…]]` into (label, id).
fn split_inner(inner: &str) -> (String, Option<Id>) {
    let b = inner.as_bytes();
    // Positions of unescaped and escaped bars.
    let (mut last_bar, mut last_escaped_bar) = (None, None);
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            if b[i + 1] == b'|' {
                last_escaped_bar = Some(i);
            }
            i += 2;
            continue;
        }
        if b[i] == b'|' {
            last_bar = Some(i);
        }
        i += 1;
    }
    if let Some(p) = last_bar {
        if let Some(id) = Id::parse_canonical(&inner[p + 1..]) {
            return (unescape(&inner[..p]), Some(id));
        }
    } else if let Some(p) = last_escaped_bar {
        if let Some(id) = Id::parse_canonical(&inner[p + 2..]) {
            return (unescape(&inner[..p]), Some(id));
        }
    }
    (unescape(inner), None)
}

/// Every link and embed in Markdown text, in order.
pub fn parse_links(text: &str) -> Vec<Link> {
    let code = code_ranges(text);
    let in_code = |p: usize| code.iter().any(|r| r.contains(&p));
    let b = text.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == b'[' && b[i + 1] == b'[' && !in_code(i) {
            // Scan to the closing ]] on the same line, honouring escapes.
            let mut j = i + 2;
            let mut end = None;
            while j < b.len() {
                match b[j] {
                    b'\\' => j += 2,
                    b'\n' | b'\r' => break,
                    b'[' => break,
                    b']' if j + 1 < b.len() && b[j + 1] == b']' => {
                        end = Some(j);
                        break;
                    }
                    b']' => break,
                    _ => j += 1,
                }
            }
            if let Some(e) = end {
                let inner = &text[i + 2..e];
                let embed = i > 0 && b[i - 1] == b'!' && !(i > 1 && b[i - 2] == b'\\');
                let (label, id) = split_inner(inner);
                if !inner.is_empty() {
                    out.push(Link { range: if embed { i - 1..e + 2 } else { i..e + 2 }, label, id, embed });
                }
                i = e + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn shared_fixtures() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/links.json");
        let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(cases.len() >= 10);
        for c in cases {
            let input = c["input"].as_str().unwrap();
            let got: Vec<Value> = parse_links(input)
                .into_iter()
                .map(|l| serde_json::json!({ "raw": &input[l.range.clone()], "label": l.label, "id": l.id.map(|i| i.to_string()), "embed": l.embed }))
                .collect();
            assert_eq!(Value::Array(got), c["links"], "case: {}", c["name"]);
        }
    }

    #[test]
    fn format_round_trips() {
        let id: Id = "0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44".parse().unwrap();
        for label in ["plain", "a|b", "[x]", "back\\slash", "two\nlines"] {
            let s = format_link(label, id, false);
            let l = &parse_links(&s)[0];
            assert_eq!(l.id, Some(id));
            assert_eq!(l.label, label.replace('\n', " "));
        }
    }
}
