//! EPUB parsing: the book's metadata and the text of each spine document, in reading order.

use crate::error::{Error, Result};
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;

pub const EXTRACTOR: &str = "librarium-epub 1";
pub const VERSION: u32 = 1;

fn bad(m: impl std::fmt::Display) -> Error {
    Error::invalid(format!("the EPUB could not be read: {m}"))
}

fn entry(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<String> {
    let mut f = zip.by_name(name).map_err(|e| bad(format!("{name}: {e}")))?;
    // Guard against zip bombs: no single document over 64 MB.
    let mut s = String::new();
    f.by_ref().take(64 << 20).read_to_string(&mut s).map_err(bad)?;
    Ok(s)
}

fn resolve(base: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or(href);
    let mut parts: Vec<&str> = base.rsplit_once('/').map(|(d, _)| d.split('/').collect()).unwrap_or_default();
    for p in href.split('/') {
        match p {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            p => parts.push(p),
        }
    }
    parts.join("/")
}

const BLOCKS: &[&str] = &[
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "blockquote",
    "section",
    "article",
    "tr",
    "br",
    "pre",
    "dt",
    "dd",
    "figcaption",
];

/// Visible text of an XHTML document: block elements become paragraphs.
pub fn xhtml_text(xml: &str) -> (Option<String>, String) {
    let doc = match roxmltree::Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() },
    ) {
        Ok(d) => d,
        Err(_) => return (None, strip_tags(xml)),
    };
    let mut title = None;
    let mut out = String::new();
    fn walk(n: roxmltree::Node, out: &mut String, title: &mut Option<String>) {
        let name = n.tag_name().name();
        if matches!(name, "script" | "style" | "head") {
            if name == "head" {
                if let Some(t) = n.descendants().find(|d| d.tag_name().name() == "title") {
                    let t = t.text().unwrap_or("").trim().to_string();
                    if !t.is_empty() {
                        *title = Some(t);
                    }
                }
            }
            return;
        }
        if n.is_text() {
            let t = n.text().unwrap_or("");
            let collapsed: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
            if !collapsed.is_empty() {
                if t.starts_with(char::is_whitespace) && !out.ends_with([' ', '\n']) && !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&collapsed);
                if t.ends_with(char::is_whitespace) {
                    out.push(' ');
                }
            }
        }
        let block = BLOCKS.contains(&name);
        if block && !out.is_empty() && !out.ends_with("\n\n") {
            out.truncate(out.trim_end_matches(' ').len());
            out.push_str("\n\n");
        }
        for c in n.children() {
            walk(c, out, title);
        }
        if block && !out.ends_with("\n\n") {
            out.truncate(out.trim_end_matches(' ').len());
            out.push_str("\n\n");
        }
    }
    walk(doc.root(), &mut out, &mut title);
    (title, out.trim().to_string())
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for c in s.chars() {
        match c {
            '<' => inside = true,
            '>' => inside = false,
            c if !inside => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn parse(path: &Path) -> Result<Value> {
    let f = std::fs::File::open(path).map_err(|e| Error::io(e.to_string()))?;
    let mut zip = zip::ZipArchive::new(f).map_err(bad)?;
    let container = entry(&mut zip, "META-INF/container.xml")?;
    let cdoc = roxmltree::Document::parse(&container).map_err(bad)?;
    let opf_path = cdoc
        .descendants()
        .find(|n| n.tag_name().name() == "rootfile")
        .and_then(|n| n.attribute("full-path"))
        .ok_or_else(|| bad("no rootfile"))?
        .to_string();
    let opf = entry(&mut zip, &opf_path)?;
    let odoc = roxmltree::Document::parse_with_options(
        &opf,
        roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() },
    )
    .map_err(bad)?;
    let meta = |name: &str| {
        odoc.descendants().find(|n| n.tag_name().name() == name).and_then(|n| n.text()).map(|s| s.trim().to_string())
    };
    let manifest: std::collections::HashMap<String, (String, String)> = odoc
        .descendants()
        .filter(|n| n.tag_name().name() == "item")
        .filter_map(|n| {
            Some((
                n.attribute("id")?.to_string(),
                (n.attribute("href")?.to_string(), n.attribute("media-type").unwrap_or("").to_string()),
            ))
        })
        .collect();
    let mut chapters = vec![];
    for itemref in odoc.descendants().filter(|n| n.tag_name().name() == "itemref") {
        let Some((href, media)) = itemref.attribute("idref").and_then(|i| manifest.get(i)) else { continue };
        if !media.contains("html") {
            continue;
        }
        let full = resolve(&opf_path, href);
        let Ok(xml) = entry(&mut zip, &full) else { continue };
        let (title, text) = xhtml_text(&xml);
        chapters.push(json!({ "href": href, "path": full, "title": title, "text": text }));
    }
    Ok(json!({
        "extractor": EXTRACTOR,
        "version": VERSION,
        "title": meta("title"),
        "creator": meta("creator"),
        "publisher": meta("publisher"),
        "date": meta("date"),
        "language": meta("language"),
        "chapters": chapters,
    }))
}
