//! Captures and pictures travel with the shared boards they're on. When a page pushes a board,
//! each capture its elements refer to (a card, a link, an embed in a text box) that the board's
//! document doesn't hold yet goes into it: title, fields, words, anchor and region pictures. So
//! does each picture on it (an image item) that isn't in a shared folder, which colleagues get
//! through Syncthing instead. Where the document arrives, each capture or picture missing from
//! that library is written there as an ordinary one with the same ID, marked `sharing.from` (the
//! board's document); pictures go to Library ▸ Attachments. It is then that person's copy: later
//! edits on either side stay where they're made.

use crate::captures::{self, ANCHOR};
use crate::error::Result;
use crate::store::frontmatter::FmValue;
use crate::store::{record, save, Library};
use crate::util::{parse_id, Id};
use automerge::transaction::Transactable;
use automerge::{ObjType, ReadDoc, ScalarValue, Value as AmValue, ROOT};
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};

/// The frontmatter field marking a capture received from a shared board: that board's document.
pub const FROM: &str = "sharing.from";
/// The capture's fields that travel with it.
const FIELDS: [&str; 4] = [captures::SOURCE, captures::QUOTE, captures::PARTS, captures::LOCATOR];

/// Pictures larger than this don't travel with a board: they reach colleagues through a shared
/// folder.
const MAX_PICTURE: u64 = 50 * 1024 * 1024;

/// A capture as a shared document carries it.
pub struct Carried {
    title: String,
    fields: Map<String, Value>,
    words: String,
    anchor: String,
    regions: Vec<(String, Vec<u8>)>,
}

/// The record IDs a board refers to: its cards' and linked elements' IDs, and the links and
/// embeds written in its text boxes (`[[label|id]]`).
pub fn referenced(elements: &[Value], boxes: &HashMap<String, String>) -> BTreeSet<Id> {
    let mut out = BTreeSet::new();
    for e in elements.iter().filter(|e| e["isDeleted"] != Value::Bool(true)) {
        for l in e.pointer("/customData/librarium/links").and_then(Value::as_array).into_iter().flatten() {
            out.extend(l["id"].as_str().and_then(parse_id));
        }
        out.extend(e["link"].as_str().and_then(|l| l.strip_prefix("librarium://record/")).and_then(parse_id));
        let text = e.pointer("/customData/librarium/text").and_then(Value::as_str).unwrap_or("");
        out.extend(ids_in(text));
    }
    for text in boxes.values() {
        out.extend(ids_in(text));
    }
    out
}

/// The IDs in `[[label|id]]` links and embeds.
fn ids_in(text: &str) -> Vec<Id> {
    text.split("]]").filter_map(|s| s.rsplit_once('|')).filter_map(|(_, id)| parse_id(id.trim())).collect()
}

/// A capture of this library, as it travels; `None` for anything else.
pub fn carried(lib: &Library, id: Id) -> Option<Carried> {
    let e = lib.index.get(id).filter(|e| e.kind == captures::KIND)?;
    let text = std::fs::read_to_string(lib.root.join(&e.path)).ok()?;
    let anchor = captures::anchor(lib, id).ok()?;
    let dir = e.dir(lib);
    let regions = anchor["parts"].as_array().into_iter().flatten()
        .filter_map(|p| p["region"].as_str())
        .filter_map(|suffix| std::fs::read(dir.join(format!("{id}{suffix}"))).ok().map(|b| (suffix.to_string(), b)))
        .collect();
    Some(Carried {
        title: e.title.clone(),
        fields: FIELDS.iter().filter_map(|k| e.fields.get(*k).map(|v| (k.to_string(), v.clone()))).collect(),
        words: record::body(&text).trim().to_string(),
        anchor: anchor.to_string(),
        regions,
    })
}

/// The captures (`"captures"`) or pictures (`"pictures"`) the document holds already, by ID.
pub fn held(doc: &impl ReadDoc, key: &str) -> BTreeSet<Id> {
    match doc.get(ROOT, key) {
        Ok(Some((AmValue::Object(ObjType::Map), m))) => doc.keys(&m).filter_map(|k| parse_id(&k)).collect(),
        _ => BTreeSet::new(),
    }
}

/// Puts a capture into the document.
pub fn put(doc: &mut impl Transactable, id: Id, c: &Carried) -> std::result::Result<(), automerge::AutomergeError> {
    let caps = match doc.get(ROOT, "captures")? {
        Some((AmValue::Object(ObjType::Map), m)) => m,
        _ => doc.put_object(ROOT, "captures", ObjType::Map)?,
    };
    let one = doc.put_object(&caps, id.to_string(), ObjType::Map)?;
    doc.put(&one, "title", c.title.as_str())?;
    doc.put(&one, "fields", Value::Object(c.fields.clone()).to_string())?;
    doc.put(&one, "words", c.words.as_str())?;
    doc.put(&one, "anchor", c.anchor.as_str())?;
    let regions = doc.put_object(&one, "regions", ObjType::Map)?;
    for (suffix, png) in &c.regions {
        doc.put(&regions, suffix.as_str(), ScalarValue::Bytes(png.clone()))?;
    }
    Ok(())
}

/// Every capture the document holds.
pub fn all(doc: &impl ReadDoc) -> Vec<(Id, Carried)> {
    let Ok(Some((AmValue::Object(ObjType::Map), caps))) = doc.get(ROOT, "captures") else { return vec![] };
    let s = |obj: &automerge::ObjId, k: &str| match doc.get(obj, k) {
        Ok(Some((AmValue::Scalar(v), _))) => match v.as_ref() {
            ScalarValue::Str(t) => Some(t.to_string()),
            _ => None,
        },
        _ => None,
    };
    doc.keys(&caps)
        .filter_map(|k| {
            let id = parse_id(&k)?;
            let Ok(Some((AmValue::Object(ObjType::Map), one))) = doc.get(&caps, k.as_str()) else { return None };
            let regions = match doc.get(&one, "regions") {
                Ok(Some((AmValue::Object(ObjType::Map), r))) => doc
                    .keys(&r)
                    .filter_map(|suffix| match doc.get(&r, suffix.as_str()) {
                        Ok(Some((AmValue::Scalar(v), _))) => match v.as_ref() {
                            ScalarValue::Bytes(b) => Some((suffix.clone(), b.clone())),
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect(),
                _ => vec![],
            };
            Some((id, Carried {
                title: s(&one, "title").unwrap_or_default(),
                fields: s(&one, "fields").and_then(|f| serde_json::from_str(&f).ok()).unwrap_or_default(),
                words: s(&one, "words").unwrap_or_default(),
                anchor: s(&one, "anchor")?,
                regions,
            }))
        })
        .collect()
}

/// Writes the captures this library hasn't got, each with its ID, marked as from `doc_url`.
/// Returns how many were written.
pub fn receive(lib: &Library, doc_url: &str, carried: Vec<(Id, Carried)>) -> Result<usize> {
    let mut n = 0;
    for (id, c) in carried {
        if lib.index.get(id).is_some() {
            continue;
        }
        let mut fields: Vec<(String, FmValue)> = c.fields.iter().filter_map(|(k, v)| match v {
            Value::String(s) => Some((k.clone(), FmValue::Str(s.clone()))),
            Value::Number(x) => x.as_i64().map(|i| (k.clone(), FmValue::Int(i))),
            _ => None,
        }).collect();
        fields.push((FROM.to_string(), FmValue::Str(doc_url.to_string())));
        let mut sidecars = vec![(ANCHOR.to_string(), c.anchor.into_bytes())];
        sidecars.extend(c.regions);
        let words = if c.words.is_empty() { String::new() } else { format!("{}\n", c.words) };
        let w = lib.write();
        match save::create_with_sidecars(&w, id, captures::KIND, &c.title, fields, &words, None, &sidecars) {
            Ok(_) => n += 1,
            Err(e) => log::warn!("a capture from a shared board ({id}) wasn’t written: {e}"),
        }
    }
    Ok(n)
}

// ---- Pictures ----

/// A picture (an image item) as a shared document carries it.
pub struct Picture {
    title: String,
    /// The file's name when it was added, for the colleague's copy.
    name: String,
    bytes: Vec<u8>,
}

/// Whether an item is in a folder Syncthing shares (it has `.stfolder`).
fn in_shared_folder(lib: &Library, e: &record::Entry) -> bool {
    let top = lib.root.join("items");
    e.dir(lib).ancestors().skip(1).take_while(|d| d.starts_with(&top)).any(|d| d.join(".stfolder").exists())
}

/// A picture of this library, as it travels; `None` for anything else, a picture in a shared
/// folder, or one too large.
pub fn picture(lib: &Library, id: Id) -> Option<Picture> {
    let e = lib.index.get(id).filter(|e| e.kind == crate::library::KIND && e.field_str(crate::library::FORMAT) == Some("image"))?;
    if in_shared_folder(lib, &e) {
        return None;
    }
    let path = e.dir(lib).join(e.field_str(crate::library::ORIGINAL)?);
    if std::fs::metadata(&path).ok()?.len() > MAX_PICTURE {
        log::warn!("the picture {id} is too large to travel with a shared board");
        return None;
    }
    let name = e.fields.get("provenance").and_then(|p| p["original-name"].as_str()).unwrap_or(&e.title).to_string();
    Some(Picture { title: e.title.clone(), name, bytes: std::fs::read(path).ok()? })
}

/// Puts a picture into the document.
pub fn put_picture(doc: &mut impl Transactable, id: Id, p: &Picture) -> std::result::Result<(), automerge::AutomergeError> {
    let pics = match doc.get(ROOT, "pictures")? {
        Some((AmValue::Object(ObjType::Map), m)) => m,
        _ => doc.put_object(ROOT, "pictures", ObjType::Map)?,
    };
    let one = doc.put_object(&pics, id.to_string(), ObjType::Map)?;
    doc.put(&one, "title", p.title.as_str())?;
    doc.put(&one, "name", p.name.as_str())?;
    doc.put(&one, "bytes", ScalarValue::Bytes(p.bytes.clone()))?;
    Ok(())
}

/// The pictures the document holds that this library hasn't got.
pub fn missing_pictures(lib: &Library, doc: &impl ReadDoc) -> Vec<(Id, Picture)> {
    let Ok(Some((AmValue::Object(ObjType::Map), pics))) = doc.get(ROOT, "pictures") else { return vec![] };
    let scalar = |obj: &automerge::ObjId, k: &str| match doc.get(obj, k) {
        Ok(Some((AmValue::Scalar(v), _))) => Some(v.into_owned()),
        _ => None,
    };
    doc.keys(&pics)
        .filter_map(|k| {
            let id = parse_id(&k).filter(|id| lib.index.get(*id).is_none())?;
            let Ok(Some((AmValue::Object(ObjType::Map), one))) = doc.get(&pics, k.as_str()) else { return None };
            let text = |key: &str| match scalar(&one, key) {
                Some(ScalarValue::Str(t)) => t.to_string(),
                _ => String::new(),
            };
            let Some(ScalarValue::Bytes(bytes)) = scalar(&one, "bytes") else { return None };
            Some((id, Picture { title: text("title"), name: text("name"), bytes }))
        })
        .collect()
}

/// Writes the pictures this library hasn't got into Attachments, each with its ID, marked as
/// from `doc_url`.
pub fn receive_pictures(lib: &Library, doc_url: &str, pictures: Vec<(Id, Picture)>) {
    for (id, p) in pictures {
        if let Err(e) = crate::library::import::receive(lib, id, &p.bytes, &p.name, &p.title, doc_url) {
            log::warn!("a picture from a shared board ({id}) wasn’t written: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn references() {
        let a = "01a16f80-3dc5-734e-8ee4-b39e78db3c3f";
        let b = "01a16f81-6fef-774f-8034-2540a6d7e8eb";
        let c = "01a16fbe-77b8-769f-ba5a-cfd95153f3cd";
        let elements = vec![
            json!({ "id": "x", "link": format!("librarium://record/{a}"), "customData": { "librarium": { "links": [{ "id": a, "label": "A" }] } } }),
            json!({ "id": "y", "link": "librarium://text", "customData": { "librarium": { "text": format!("see [[B|{b}]] and ![[C|{c}]]") } } }),
            json!({ "id": "z", "isDeleted": true, "link": format!("librarium://record/{c}") }),
        ];
        let got: Vec<String> = referenced(&elements, &HashMap::new()).iter().map(ToString::to_string).collect();
        assert_eq!(got, vec![a, b, c]);
    }

    #[test]
    fn carried_round_trip() {
        let mut doc = automerge::AutoCommit::new();
        let id = parse_id("01a16f80-3dc5-734e-8ee4-b39e78db3c3f").unwrap();
        let c = Carried { title: "A quote".into(), fields: json!({ "captures.quote": "words", "captures.parts": 1 }).as_object().unwrap().clone(), words: "mine".into(), anchor: "{}".into(), regions: vec![(".region-1.png".into(), vec![137, 80, 78, 71])] };
        put(&mut doc, id, &c).unwrap();
        assert!(held(&doc, "captures").contains(&id));
        let back = all(&doc);
        assert_eq!(back.len(), 1);
        assert_eq!((back[0].1.title.as_str(), back[0].1.words.as_str(), back[0].1.regions[0].1.len()), ("A quote", "mine", 4));
        assert_eq!(back[0].1.fields["captures.parts"], 1);
    }

    #[test]
    fn picture_round_trip() {
        let mut doc = automerge::AutoCommit::new();
        let id = parse_id("01a16f80-3dc5-734e-8ee4-b39e78db3c3f").unwrap();
        put_picture(&mut doc, id, &Picture { title: "A view".into(), name: "view.png".into(), bytes: vec![137, 80, 78, 71] }).unwrap();
        assert!(held(&doc, "pictures").contains(&id));
    }
}
