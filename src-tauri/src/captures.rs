//! Captures: a passage or a region kept with your own words, pointing back to its exact place.
//!
//! - `captures/<id>.md`: the user's words as the body; the quotation, its source and its place
//!   in the frontmatter, readable without the app.
//! - `captures/<id>.anchor.json`: `{id, parts, snapshot, source, text}` in the W3C Web
//!   Annotation model, and `captures/<id>.region-<N>.png` for regions. Sidecars are written
//!   first (the `.md` is the commit point) and paired by the ID inside them; a sidecar without
//!   a capture is an orphan, listed and never deleted.

use crate::error::{Error, Result};
use crate::store::frontmatter::FmValue;
use crate::store::{files, record, Library};
use crate::types::{
    AnchorUpdated, CaptureParams, CapturePart, CaptureUpdateParams, MarkPart, OrphanSidecar, SavedMarks, Written,
};
use crate::util::{json_bytes, new_id, parse_id, Id};
use base64::Engine as _;
use serde_json::{json, Value};
use std::fs;

pub const KIND: &str = "capture";
pub const SOURCE: &str = "captures.source";
pub const QUOTE: &str = "captures.quote";
pub const PARTS: &str = "captures.parts";
pub const LOCATOR: &str = "captures.locator";
pub const ANCHOR: &str = ".anchor.json";
const FOLDER: &str = "captures";

/// Files written beside a capture: `(suffix, bytes)`.
type Sidecars = Vec<(String, Vec<u8>)>;

/// The first `n` words of a quotation, with "…" if there were more.
pub fn first_words(quote: &str, n: usize) -> String {
    let words: Vec<&str> = quote.split_whitespace().collect();
    if words.len() <= n {
        words.join(" ")
    } else {
        format!("{}…", words[..n].join(" "))
    }
}

/// The title a capture gets by itself: its first 8 words, or "A region of <source>".
fn auto_title(quote: &str, source_title: &str) -> String {
    if quote.is_empty() {
        format!("A region of {source_title}")
    } else {
        first_words(quote, 8)
    }
}

/// The parts' quotes, each trimmed, the empty ones left out, joined with " […] ".
fn quote_of(parts: &[CapturePart]) -> String {
    parts.iter().map(|p| p.quote.trim()).filter(|q| !q.is_empty()).collect::<Vec<_>>().join(" […] ")
}

/// The anchor's parts, and the region pictures to write beside them (`.region-<N>.png`,
/// numbered from 1 by the part's place).
fn anchor_parts(parts: &[CapturePart]) -> Result<(Vec<Value>, Sidecars)> {
    if parts.is_empty() {
        return Err(Error::invalid("A capture needs at least one part."));
    }
    let mut out = vec![];
    let mut regions = vec![];
    for (i, part) in parts.iter().enumerate() {
        let mut v = json!({ "selector": part.selector });
        if !part.boxes.is_empty() {
            v["boxes"] = json!(part.boxes);
        }
        if let Some(b64) = &part.region_png {
            let png = base64::engine::general_purpose::STANDARD
                .decode(b64.trim_start_matches("data:image/png;base64,"))
                .map_err(|e| Error::invalid(format!("The region’s picture is damaged: {e}")))?;
            if !png.starts_with(b"\x89PNG") {
                return Err(Error::invalid("The region’s picture isn’t a PNG."));
            }
            let suffix = format!(".region-{}.png", i + 1);
            v["region"] = json!(suffix);
            regions.push((suffix, png));
        }
        out.push(v);
    }
    Ok((out, regions))
}

fn source_title(lib: &Library, e: &record::Entry) -> String {
    e.field_str(SOURCE).and_then(parse_id).and_then(|s| lib.index.get(s)).map(|s| s.title).unwrap_or_default()
}

pub fn create(lib: &Library, p: CaptureParams) -> Result<Written> {
    let source = lib.index.get(p.source).ok_or_else(|| Error::not_found("The source can’t be found."))?;
    let (parts, regions) = anchor_parts(&p.parts)?;
    let quote = quote_of(&p.parts);
    let title = auto_title(&quote, &source.title);
    let id = new_id();
    let anchor = json!({ "id": id, "source": p.source, "snapshot": p.snapshot, "text": p.text, "parts": parts });
    let mut sidecars = vec![(ANCHOR.to_string(), json_bytes(&anchor, false))];
    sidecars.extend(regions);
    let mut fields = vec![
        (SOURCE.to_string(), FmValue::Str(p.source.to_string())),
        (QUOTE.to_string(), FmValue::Str(quote)),
        (PARTS.to_string(), FmValue::Int(p.parts.len() as i64)),
    ];
    if let Some(l) = p.parts.iter().find_map(|x| x.locator.clone()) {
        fields.push((LOCATOR.to_string(), FmValue::Str(l)));
    }
    let words = if p.words.trim().is_empty() { String::new() } else { format!("{}\n", p.words.trim_end()) };
    let w = lib.write();
    let e = record::create_with_sidecars(&w, id, KIND, &title, fields, &words, None, &sidecars)?;
    Ok(Written { info: record::info(lib, &e), seq: w.seq() })
}

/// New parts for a capture (its selection edited). The user's words stay, and the title
/// follows the new quote only if it was still the automatic one.
pub fn update(lib: &Library, p: CaptureUpdateParams) -> Result<Written> {
    let e = capture(lib, p.id)?;
    let (parts, regions) = anchor_parts(&p.parts)?;
    let quote = quote_of(&p.parts);
    let source = source_title(lib, &e);
    let old_quote = e.field_str(QUOTE).unwrap_or("");
    let title = (e.title == auto_title(old_quote, &source)).then(|| auto_title(&quote, &source));
    let mut a = anchor(lib, p.id)?;
    a["parts"] = Value::Array(parts);
    let locator = p.parts.iter().find_map(|x| x.locator.clone());
    let w = lib.write();
    files::write_sidecar(&w, p.id, ANCHOR, &json_bytes(&a, false))?;
    for (suffix, png) in &regions {
        files::write_sidecar(&w, p.id, suffix, png)?;
    }
    let edits = [
        (QUOTE.to_string(), Some(FmValue::Str(quote))),
        (PARTS.to_string(), Some(FmValue::Int(p.parts.len() as i64))),
        (LOCATOR.to_string(), locator.map(FmValue::Str)),
    ];
    let mut e = record::set_fields(&w, p.id, None, &edits)?;
    if let Some(t) = title.filter(|t| *t != e.title) {
        e = record::relocate(&w, p.id, None, Some(&t), None)?;
    }
    Ok(Written { info: record::info(lib, &e), seq: w.seq() })
}

/// The user confirmed where moved parts are now: the anchor's parts are replaced.
pub fn update_anchor(lib: &Library, id: Id, parts: Vec<Value>) -> Result<AnchorUpdated> {
    capture(lib, id)?;
    let mut a = anchor(lib, id)?;
    a["parts"] = Value::Array(parts);
    let w = lib.write();
    files::write_sidecar(&w, id, ANCHOR, &json_bytes(&a, false))?;
    Ok(AnchorUpdated { seq: w.changed(id) })
}

fn capture(lib: &Library, id: Id) -> Result<record::Entry> {
    lib.index.get(id).filter(|e| e.kind == KIND).ok_or_else(|| Error::not_found("This capture can’t be found."))
}

fn read_json(name: &str, lib: &Library) -> Option<Value> {
    serde_json::from_slice(&fs::read(lib.root.join(FOLDER).join(name)).ok()?).ok()
}

/// Sidecar names in `captures/`.
fn sidecar_names(lib: &Library) -> Vec<String> {
    let list = fs::read_dir(lib.root.join(FOLDER)).into_iter().flatten().flatten();
    let mut names: Vec<String> = list
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.') && !n.ends_with(".md"))
        .collect();
    names.sort();
    names
}

/// A capture's anchor, paired by the ID inside the sidecar: `<id>.anchor.json` first, then any.
pub fn anchor(lib: &Library, id: Id) -> Result<Value> {
    let mine = |v: &Value| v["id"].as_str() == Some(id.to_string().as_str());
    if let Some(v) = read_json(&format!("{id}{ANCHOR}"), lib).filter(mine) {
        return Ok(v);
    }
    sidecar_names(lib)
        .into_iter()
        .filter(|n| n.ends_with(ANCHOR))
        .find_map(|n| read_json(&n, lib).filter(mine))
        .ok_or_else(|| Error::not_found("This capture’s anchor can’t be found."))
}

/// The captures of a source, with their anchors.
fn of_source(lib: &Library, source: Id) -> Vec<(record::Entry, Value)> {
    let src = source.to_string();
    let list = lib.index.list(Some(KIND)).unwrap_or_default();
    list.into_iter()
        .filter(|c| c.field_str(SOURCE) == Some(src.as_str()))
        .filter_map(|c| anchor(lib, c.id).ok().map(|a| (c, a)))
        .collect()
}

/// The snapshots of a saved page that captures were made from: (snapshot, capture).
pub fn snapshots_in_use(lib: &Library, source: Id) -> Vec<(String, Id)> {
    of_source(lib, source).into_iter().filter_map(|(c, a)| Some((a["snapshot"].as_str()?.to_string(), c.id))).collect()
}

/// The captures of a source (of one snapshot of it), with where to highlight each part: its
/// stored boxes, a region's rectangle, or an EPUB part's CFI.
pub fn for_source(lib: &Library, source: Id, snapshot: Option<&str>) -> Vec<SavedMarks> {
    of_source(lib, source)
        .into_iter()
        .filter(|(_, a)| a["snapshot"].as_str() == snapshot)
        .map(|(c, a)| SavedMarks {
            id: c.id,
            title: c.title,
            parts: a["parts"].as_array().map(|ps| ps.iter().map(mark).collect()).unwrap_or_default(),
        })
        .collect()
}

fn mark(p: &Value) -> MarkPart {
    let sels = p["selector"].as_array().cloned().unwrap_or_default();
    let fragment = |prefix: &str| {
        sels.iter().find_map(|s| {
            [s["value"].as_str(), s["refinedBy"]["value"].as_str()]
                .into_iter()
                .flatten()
                .find(|v| v.starts_with(prefix))
                .map(str::to_string)
        })
    };
    let page = fragment("page=").and_then(|v| v[5..].parse::<u32>().ok());
    let region = fragment("xywh=percent:");
    let mut boxes = p["boxes"].as_array().cloned().unwrap_or_default();
    if let (true, Some(r)) = (boxes.is_empty(), &region) {
        let n: Vec<f64> = r[13..].split(',').filter_map(|x| x.parse().ok()).collect();
        if n.len() == 4 {
            let mut b = json!({ "x": n[0], "y": n[1], "w": n[2], "h": n[3] });
            if let Some(pg) = page {
                b["page"] = json!(pg);
            }
            boxes.push(b);
        }
    }
    MarkPart { boxes, cfi: fragment("epubcfi("), region: region.is_some() }
}

/// Sidecars in `captures/` whose capture doesn't exist.
pub fn orphans(lib: &Library) -> Vec<OrphanSidecar> {
    let mut out = vec![];
    for name in sidecar_names(lib) {
        let id = if name.ends_with(ANCHOR) {
            read_json(&name, lib).and_then(|v| v["id"].as_str().and_then(parse_id))
        } else {
            name.get(..36).and_then(parse_id)
        };
        if id.is_none_or(|i| lib.index.get(i).is_none_or(|r| r.kind != KIND)) {
            out.push(OrphanSidecar { path: format!("{FOLDER}/{name}"), id });
        }
    }
    out
}

/// A region's picture, as a `data:` URL (small; shown in panels and embeds).
pub fn region(lib: &Library, id: Id, n: u32) -> Result<String> {
    let bytes = fs::read(lib.root.join(FOLDER).join(format!("{id}.region-{n}.png")))
        .map_err(|_| Error::not_found("That region’s picture can’t be found."))?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}
