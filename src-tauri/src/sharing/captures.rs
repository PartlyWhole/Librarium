//! Captures travel with the shared boards they're on. When a page pushes a board, each capture
//! its elements refer to (a card, a link, an embed in a text box) that the board's document
//! doesn't hold yet goes into it: title, fields, words, anchor and region pictures. Where the
//! document arrives, each capture missing from that library is written there as an ordinary
//! capture with the same ID, marked `sharing.from` (the board's document). It is then that
//! person's copy: later edits on either side stay where they're made.

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

/// The captures the document holds already, by ID.
pub fn held(doc: &impl ReadDoc) -> BTreeSet<Id> {
    match doc.get(ROOT, "captures") {
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
        assert!(held(&doc).contains(&id));
        let back = all(&doc);
        assert_eq!(back.len(), 1);
        assert_eq!((back[0].1.title.as_str(), back[0].1.words.as_str(), back[0].1.regions[0].1.len()), ("A quote", "mine", 4));
        assert_eq!(back[0].1.fields["captures.parts"], 1);
    }
}
