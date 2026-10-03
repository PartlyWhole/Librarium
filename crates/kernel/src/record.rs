//! Records as read from their files: the envelope (§5.2) and its codecs.

use crate::frontmatter::{self, FmError, FmValue, Frontmatter};
use crate::kinds::{Format, Kinds};
use librarium_contracts::Id;
use serde_json::{Map, Value};

/// Reserved kernel keys (§5.2).
pub const RESERVED: &[&str] = &["id", "kind", "kind-version", "created", "title", "copied-from"];

/// Why a record opens read-only.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadOnly {
    /// Its frontmatter doesn't parse: shown, never rewritten.
    Unparsable(String),
    /// Written by a newer version of its kind.
    NewerKind { found: i64, known: i64 },
    /// No module knows its kind.
    UnknownKind(String),
}

impl ReadOnly {
    pub fn describe(&self) -> String {
        match self {
            ReadOnly::Unparsable(m) => {
                format!("Its frontmatter doesn't parse ({m}), so it is shown but never rewritten.")
            }
            ReadOnly::NewerKind { found, known } => {
                format!("It was written by a newer version (kind-version {found}; this app knows {known}).")
            }
            ReadOnly::UnknownKind(k) => format!("No module here knows the kind {k:?}."),
        }
    }
}

/// A record file, decoded.
#[derive(Debug, Clone)]
pub struct Decoded {
    pub id: Option<Id>,
    /// The ID text when it is present but not canonical (damaged).
    pub damaged_id: Option<String>,
    pub kind: String,
    pub kind_version: i64,
    pub title: String,
    pub created: Option<String>,
    pub copied_from: Option<Id>,
    /// Every field, in order (for Markdown, the frontmatter; for JSON, the object).
    pub fields: Map<String, Value>,
    pub read_only: Option<ReadOnly>,
    pub format: Format,
}

impl Decoded {
    pub fn field(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }
}

/// Finds an ID in frontmatter that doesn't parse, line by line.
fn lenient_id(fm: &str) -> Option<Id> {
    for line in fm.lines() {
        if let Some(rest) = line.strip_prefix("id:") {
            let t = rest.trim().trim_matches(['"', '\'']);
            return Id::parse_canonical(t);
        }
    }
    None
}

/// Decodes a Markdown record. `folder_kind` is the kind owning the folder it was found in.
pub fn decode_markdown(text: &str, folder_kind: &str, kinds: &Kinds) -> Decoded {
    let (fm, _) = frontmatter::split(text);
    let mut d = Decoded {
        id: None,
        damaged_id: None,
        kind: folder_kind.to_string(),
        kind_version: 1,
        title: String::new(),
        created: None,
        copied_from: None,
        fields: Map::new(),
        read_only: None,
        format: Format::Markdown,
    };
    let Some((fm_text, _)) = fm else {
        d.title = first_heading(text).unwrap_or_default();
        return d;
    };
    match Frontmatter::parse(fm_text) {
        Ok(fm) => {
            d.fields = fm.to_json();
            fill_envelope(&mut d, |k| fm.get(k).cloned());
        }
        Err(FmError::Invalid(m)) | Err(FmError::Complex(m)) => {
            d.id = lenient_id(fm_text);
            d.read_only = Some(ReadOnly::Unparsable(m));
        }
    }
    check_kind(&mut d, kinds);
    d
}

fn first_heading(text: &str) -> Option<String> {
    text.lines().find_map(|l| l.strip_prefix("# ").map(|t| t.trim().to_string()))
}

fn fill_envelope(d: &mut Decoded, get: impl Fn(&str) -> Option<FmValue>) {
    match get("id") {
        Some(FmValue::Str(s)) => match Id::parse_canonical(&s) {
            Some(id) => d.id = Some(id),
            None => d.damaged_id = Some(s),
        },
        Some(other) if other != FmValue::Null => d.damaged_id = Some(other.emit()),
        _ => {}
    }
    if let Some(FmValue::Str(k)) = get("kind") {
        d.kind = k;
    }
    if let Some(v) = get("kind-version").and_then(|v| v.as_i64()) {
        d.kind_version = v;
    }
    if let Some(FmValue::Str(t)) = get("title") {
        d.title = t;
    } else if let Some(v) = get("title").filter(|v| *v != FmValue::Null) {
        d.title = v.emit();
    }
    if let Some(FmValue::Str(c)) = get("created") {
        d.created = Some(c);
    }
    if let Some(FmValue::Str(c)) = get("copied-from") {
        d.copied_from = Id::parse_canonical(&c);
    }
}

fn check_kind(d: &mut Decoded, kinds: &Kinds) {
    if d.read_only.is_some() {
        return;
    }
    match kinds.get(&d.kind) {
        None => d.read_only = Some(ReadOnly::UnknownKind(d.kind.clone())),
        Some(def) if d.kind_version > def.version => {
            d.read_only = Some(ReadOnly::NewerKind { found: d.kind_version, known: def.version })
        }
        _ => {}
    }
}

/// Decodes a binary kind's `record.json`.
pub fn decode_json(text: &str, folder_kind: &str, kinds: &Kinds) -> Decoded {
    let mut d = Decoded {
        id: None,
        damaged_id: None,
        kind: folder_kind.to_string(),
        kind_version: 1,
        title: String::new(),
        created: None,
        copied_from: None,
        fields: Map::new(),
        read_only: None,
        format: Format::JsonDir,
    };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => {
            fill_envelope(&mut d, |k| m.get(k).and_then(FmValue::from_json));
            d.fields = m;
        }
        Ok(_) => d.read_only = Some(ReadOnly::Unparsable("record.json is not an object".into())),
        Err(e) => {
            d.read_only = Some(ReadOnly::Unparsable(e.to_string()));
            if let Some(i) = text.find("\"id\"") {
                let rest = &text[i + 4..];
                if let Some(q) = rest.find('"') {
                    d.id = rest.get(q + 1..q + 37).and_then(Id::parse_canonical);
                }
            }
        }
    }
    check_kind(&mut d, kinds);
    d
}

/// The frontmatter text for a new record: the envelope, then the given fields in order.
pub fn new_frontmatter(
    id: Id,
    kind: &str,
    kind_version: i64,
    created: &str,
    title: &str,
    fields: &[(String, FmValue)],
) -> String {
    let mut s = format!(
        "id: \"{id}\"\nkind: {}\nkind-version: {kind_version}\ncreated: {}\ntitle: {}\n",
        FmValue::Str(kind.into()).emit(),
        FmValue::Str(created.into()).emit(),
        FmValue::Str(title.into()).emit()
    );
    for (k, v) in fields {
        s.push_str(&format!("{k}: {}\n", v.emit()));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kinds::RecordKindDef;

    fn kinds() -> Kinds {
        let mut k = Kinds::new();
        k.add(
            "test",
            RecordKindDef {
                kind: "note".into(),
                version: 1,
                format: Format::Markdown,
                folder: "pages".into(),
                slugged: true,
                subfolder_field: None,
            },
        )
        .unwrap();
        k
    }

    #[test]
    fn decodes_the_envelope() {
        let t = "---\nid: \"0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44\"\nkind: \"note\"\nkind-version: 1\ncreated: \"2026-10-02T09:14:00Z\"\ntitle: \"Jacques Ellul\"\nx.folder: \"Thinkers\"\n---\nBody\n";
        let d = decode_markdown(t, "note", &kinds());
        assert_eq!(d.id.unwrap().to_string(), "0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44");
        assert_eq!(d.title, "Jacques Ellul");
        assert_eq!(d.fields["x.folder"], "Thinkers");
        assert!(d.read_only.is_none());
    }

    #[test]
    fn read_only_cases() {
        let k = kinds();
        let newer = decode_markdown(
            "---\nid: \"0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44\"\nkind: note\nkind-version: 9\n---\n",
            "note",
            &k,
        );
        assert_eq!(newer.read_only, Some(ReadOnly::NewerKind { found: 9, known: 1 }));
        let unknown = decode_markdown("---\nkind: poem\n---\n", "note", &k);
        assert_eq!(unknown.read_only, Some(ReadOnly::UnknownKind("poem".into())));
        let bad = decode_markdown("---\nid: \"0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44\"\ntitle: [oops\n---\n", "note", &k);
        assert!(matches!(bad.read_only, Some(ReadOnly::Unparsable(_))));
        assert!(bad.id.is_some(), "the ID is still found");
        let damaged = decode_markdown("---\nid: \"0192F3A4\"\n---\n", "note", &k);
        assert_eq!(damaged.damaged_id.as_deref(), Some("0192F3A4"));
        let plain = decode_markdown("# A heading\ntext", "note", &k);
        assert!(plain.id.is_none());
        assert_eq!(plain.title, "A heading");
    }
}
