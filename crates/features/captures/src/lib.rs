//! Captures: a passage or a region kept with your own words, pointing back to its exact place.
//!
//! - `captures/<id>.md`: the user's words as the body; the quotation, its source and its place
//!   in the frontmatter (readable without the app).
//! - `captures/<id>.anchor.json`: `{id, source, snapshot, text, parts}` in the W3C Web
//!   Annotation model; `captures/<id>.region-N.png` for regions. Sidecars are written first
//!   (the `.md` is the commit point) and paired by the ID inside them; a sidecar without a
//!   capture is listed as an orphan, never deleted.

use base64::Engine as _;
use librarium_contracts::api::{CaptureParams, OrphanSidecar, Written};
use librarium_contracts::{BackendError, Id, Result};
use librarium_kernel::frontmatter::FmValue;
use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::methods::{ApiMethod, MethodCtx};
use librarium_kernel::registry::{DuplicateId, Registry};
use librarium_kernel::store::Store;
use librarium_kernel::writer::Lane;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub const ID: &str = "captures";
pub const KIND: &str = "capture";
pub const SOURCE: &str = "captures.source";
pub const QUOTE: &str = "captures.quote";
pub const LOCATOR: &str = "captures.locator";
pub const PARTS: &str = "captures.parts";
pub const ANCHOR: &str = ".anchor.json";
const FOLDER: &str = "captures";

pub fn contribute_kinds(k: &mut Kinds) -> Result<(), DuplicateId> {
    k.add(
        ID,
        RecordKindDef {
            kind: KIND.into(),
            version: 1,
            format: Format::Markdown,
            folder: FOLDER.into(),
            slugged: false,
            subfolder_field: None,
        },
    )?;
    // A capture of a saved page keeps the snapshot it was made from.
    k.add_part_user(
        ID,
        Arc::new(|store: &Store, source: Id| {
            let src = source.to_string();
            store
                .list(Some(KIND))
                .into_iter()
                .filter(|c| c.fields.get(SOURCE).and_then(|v| v.as_str()) == Some(src.as_str()))
                .filter_map(|c| {
                    let a = anchor(store, c.id).ok()?;
                    Some((a["snapshot"].as_str()?.to_string(), c.id))
                })
                .collect()
        }),
    )
}

/// The first words of a quotation, for a title and an embed's label.
pub fn first_words(quote: &str, n: usize) -> String {
    let words: Vec<&str> = quote.split_whitespace().collect();
    if words.len() <= n {
        words.join(" ")
    } else {
        format!("{}…", words[..n].join(" "))
    }
}

pub fn create(ctx: &MethodCtx, p: CaptureParams) -> Result<Written> {
    let store = &ctx.library.store;
    let source = store.get(p.source).ok_or_else(|| BackendError::not_found("the source can't be found"))?;
    if p.parts.is_empty() {
        return Err(BackendError::invalid("a capture needs at least one part"));
    }
    let quotes: Vec<&str> = p.parts.iter().map(|x| x.quote.trim()).filter(|q| !q.is_empty()).collect();
    let quote = quotes.join(" […] ");
    let title = if quote.is_empty() { format!("A region of {}", source.title) } else { first_words(&quote, 8) };
    // The anchor and region images go first; the record's own file is the commit point.
    let mut sidecars = vec![];
    let mut parts = vec![];
    for (i, part) in p.parts.iter().enumerate() {
        let mut v = json!({ "selector": part.selector });
        if !part.boxes.is_empty() {
            v["boxes"] = json!(part.boxes);
        }
        if let Some(b64) = &part.region_png {
            let png = base64::engine::general_purpose::STANDARD
                .decode(b64.trim_start_matches("data:image/png;base64,"))
                .map_err(|e| BackendError::invalid(format!("the region image is damaged: {e}")))?;
            if !png.starts_with(b"\x89PNG") {
                return Err(BackendError::invalid("the region image is not a PNG"));
            }
            let suffix = format!(".region-{}.png", i + 1);
            v["region"] = json!(suffix);
            sidecars.push((suffix, png));
        }
        parts.push(v);
    }
    let mut anchor_body =
        json!({ "id": Value::Null, "source": p.source, "snapshot": p.snapshot, "text": p.text, "parts": parts });
    let locator = p.parts.iter().find_map(|x| x.locator.clone());
    let mut fields = vec![
        (SOURCE.to_string(), FmValue::Str(p.source.to_string())),
        (QUOTE.into(), FmValue::Str(quote)),
        (PARTS.into(), FmValue::Int(p.parts.len() as i64)),
    ];
    if let Some(l) = &locator {
        fields.push((LOCATOR.into(), FmValue::Str(l.clone())));
    }
    let words = if p.words.trim().is_empty() { String::new() } else { format!("{}\n", p.words.trim_end()) };
    // The anchor holds the capture's ID; it is written with the ID the record will get.
    let store2 = store.clone();
    let (e, seq) = ctx.library.write(Lane::Interactive, move |tx| {
        let id_probe = store2.ids.next_id();
        let mut sc = sidecars;
        anchor_body["id"] = json!(id_probe);
        sc.insert(0, (ANCHOR.into(), serde_json::to_vec_pretty(&anchor_body).unwrap()));
        tx.create_with_sidecars_id(id_probe, KIND, &title, fields, &words, sc)
    })?;
    Ok(Written { info: e.info(), seq })
}

/// A capture's anchor, paired by the ID inside the sidecar (its name is only a convention).
pub fn anchor(store: &Store, id: Id) -> Result<Value> {
    let dir = store.root.join(FOLDER);
    let read = |name: &str| -> Option<Value> {
        store.fs.read(&dir.join(name)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    };
    let mine = |v: &Value| v["id"].as_str() == Some(&id.to_string());
    if let Some(v) = read(&format!("{id}{ANCHOR}")).filter(mine) {
        return Ok(v);
    }
    for e in store.fs.list(&dir).unwrap_or_default() {
        if e.name.ends_with(ANCHOR) {
            if let Some(v) = read(&e.name).filter(mine) {
                return Ok(v);
            }
        }
    }
    Err(BackendError::not_found("this capture's anchor can't be found"))
}

/// The captures of a source (of one snapshot of it, or of the source itself), with where to
/// highlight each part: its stored boxes, a region's rectangle, or an EPUB part's CFI.
pub fn for_source(store: &Store, source: Id, snapshot: Option<&str>) -> Vec<Value> {
    let src = source.to_string();
    let mut out = vec![];
    for c in store.list(Some(KIND)) {
        if c.fields.get(SOURCE).and_then(|v| v.as_str()) != Some(src.as_str()) {
            continue;
        }
        let Ok(a) = anchor(store, c.id) else { continue };
        if a["snapshot"].as_str() != snapshot {
            continue;
        }
        let parts: Vec<Value> = a["parts"]
            .as_array()
            .map(|ps| {
                ps.iter()
                    .map(|p| {
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
                        let cfi = fragment("epubcfi(");
                        let region = fragment("xywh=percent:");
                        let mut boxes = p["boxes"].as_array().cloned().unwrap_or_default();
                        if boxes.is_empty() {
                            if let Some(r) = &region {
                                let n: Vec<f64> = r[13..].split(',').filter_map(|x| x.parse().ok()).collect();
                                if n.len() == 4 {
                                    let mut b = json!({ "x": n[0], "y": n[1], "w": n[2], "h": n[3] });
                                    if let Some(pg) = page {
                                        b["page"] = json!(pg);
                                    }
                                    boxes.push(b);
                                }
                            }
                        }
                        json!({ "boxes": boxes, "cfi": cfi, "region": region.is_some() })
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(json!({ "id": c.id, "title": c.title, "parts": parts }));
    }
    out
}

/// Sidecars whose capture doesn't exist: listed, never deleted.
pub fn orphans(store: &Store) -> Vec<OrphanSidecar> {
    let dir = store.root.join(FOLDER);
    let mut out = vec![];
    for e in store.fs.list(&dir).unwrap_or_default() {
        if e.is_dir || e.name.starts_with('.') || e.name.ends_with(".md") {
            continue;
        }
        let id: Option<Id> = if e.name.ends_with(ANCHOR) {
            store
                .fs
                .read(&dir.join(&e.name))
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .and_then(|v| v["id"].as_str().and_then(|s| s.parse().ok()))
        } else {
            e.name.get(..36).and_then(|s| s.parse().ok())
        };
        if id.is_none_or(|i| store.get(i).is_none_or(|r| r.kind != KIND)) {
            out.push(OrphanSidecar { path: format!("{FOLDER}/{}", e.name), id });
        }
    }
    out
}

#[derive(Deserialize)]
struct IdParam {
    id: Id,
}

#[derive(Deserialize)]
struct UpdateAnchor {
    id: Id,
    parts: Vec<Value>,
}

pub fn contribute_methods(r: &mut Registry<ApiMethod>) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "captures.create",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: CaptureParams = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            Ok(serde_json::to_value(create(ctx, p)?).unwrap())
        }),
    )?;
    r.add(
        ID,
        "captures.forSource",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let source: Id =
                serde_json::from_value(p["source"].clone()).map_err(|e| BackendError::invalid(e.to_string()))?;
            Ok(Value::Array(for_source(&ctx.library.store, source, p["snapshot"].as_str())))
        }),
    )?;
    r.add(
        ID,
        "captures.anchor",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: IdParam = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            anchor(&ctx.library.store, p.id)
        }),
    )?;
    r.add(
        ID,
        "captures.updateAnchor",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            // The user confirmed where a moved part is now.
            let p: UpdateAnchor = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            let mut a = anchor(&ctx.library.store, p.id)?;
            a["parts"] = Value::Array(p.parts);
            let bytes = serde_json::to_vec_pretty(&a).unwrap();
            let seq = ctx.library.write(Lane::Interactive, move |tx| tx.write_sidecar(p.id, ANCHOR, &bytes))?;
            Ok(json!({ "seq": seq }))
        }),
    )?;
    r.add(
        ID,
        "captures.orphans",
        Arc::new(|ctx: &MethodCtx, _p: Value| Ok(serde_json::to_value(orphans(&ctx.library.store)).unwrap())),
    )?;
    r.add(
        ID,
        "captures.region",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            // A region image, as base64 (small; shown in panels and embeds).
            #[derive(Deserialize)]
            struct R {
                id: Id,
                n: u32,
            }
            let p: R = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            let bytes = ctx
                .library
                .store
                .fs
                .read(&ctx.library.store.root.join(FOLDER).join(format!("{}.region-{}.png", p.id, p.n)))
                .map_err(|e| BackendError::not_found(e.to_string()))?;
            Ok(json!(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
        }),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn first_words() {
        assert_eq!(super::first_words("one two three", 8), "one two three");
        assert_eq!(super::first_words("a b c d e f g h i j", 8), "a b c d e f g h…");
    }
}
