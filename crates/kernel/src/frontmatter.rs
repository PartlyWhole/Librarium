//! Frontmatter: read as any YAML 1.2, written byte-precisely (BRIEF §5.3).
//!
//! The editor changes only the bytes of the keys it writes: unknown keys, their values, comments
//! and order are preserved exactly. A key whose current value has a form the editor cannot
//! rewrite exactly (a block scalar, a nested map, a multi-line plain scalar, an anchor, alias or
//! tag) is refused with [`FmError::Complex`], and the caller opens the record read-only.

use saphyr_parser::{Event, Parser, ScalarStyle};
use serde_json::{Map, Number, Value};

/// A frontmatter value, as the app writes it (§5.3) or as read from any YAML.
#[derive(Debug, Clone, PartialEq)]
pub enum FmValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    List(Vec<FmValue>),
    /// Anything else YAML allows (maps, nested lists of maps), read-only.
    Other(Value),
}

impl FmValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            FmValue::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            FmValue::Int(i) => Some(*i),
            _ => None,
        }
    }
    pub fn to_json(&self) -> Value {
        match self {
            FmValue::Null => Value::Null,
            FmValue::Bool(b) => Value::Bool(*b),
            FmValue::Int(i) => Value::from(*i),
            FmValue::Float(f) => Number::from_f64(*f).map(Value::Number).unwrap_or(Value::Null),
            FmValue::Str(s) => Value::String(s.clone()),
            FmValue::List(l) => Value::Array(l.iter().map(FmValue::to_json).collect()),
            FmValue::Other(v) => v.clone(),
        }
    }
    /// Converts JSON to a writable value: strings, numbers, booleans, or lists of these.
    pub fn from_json(v: &Value) -> Option<FmValue> {
        Some(match v {
            Value::Null => FmValue::Null,
            Value::Bool(b) => FmValue::Bool(*b),
            Value::Number(n) => match n.as_i64() {
                Some(i) => FmValue::Int(i),
                None => FmValue::Float(n.as_f64()?),
            },
            Value::String(s) => FmValue::Str(s.clone()),
            Value::Array(a) => {
                let mut out = vec![];
                for x in a {
                    match FmValue::from_json(x)? {
                        FmValue::List(_) | FmValue::Other(_) => return None,
                        y => out.push(y),
                    }
                }
                FmValue::List(out)
            }
            Value::Object(_) => return None,
        })
    }
    /// The YAML text the app writes for this value (§5.3).
    pub fn emit(&self) -> String {
        match self {
            FmValue::Null => "null".into(),
            FmValue::Bool(b) => b.to_string(),
            FmValue::Int(i) => i.to_string(),
            FmValue::Float(f) => {
                if f.is_finite() {
                    let s = f.to_string();
                    if s.contains('.') || s.contains('e') {
                        s
                    } else {
                        format!("{s}.0")
                    }
                } else if f.is_nan() {
                    ".nan".into()
                } else if *f > 0.0 {
                    ".inf".into()
                } else {
                    "-.inf".into()
                }
            }
            // JSON string escapes are valid YAML double-quoted escapes.
            FmValue::Str(s) => serde_json::to_string(s).unwrap(),
            FmValue::List(l) => format!("[{}]", l.iter().map(FmValue::emit).collect::<Vec<_>>().join(", ")),
            FmValue::Other(v) => v.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FmError {
    /// The YAML doesn't parse, or isn't a mapping. Shown, never rewritten.
    Invalid(String),
    /// The key's current value can't be rewritten byte-precisely.
    Complex(String),
}

impl std::fmt::Display for FmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FmError::Invalid(m) => write!(f, "frontmatter does not parse: {m}"),
            FmError::Complex(k) => write!(f, "frontmatter key {k:?} has a form the app does not rewrite"),
        }
    }
}

/// How a top-level value is laid out in the source.
#[derive(Debug, Clone, PartialEq)]
enum Layout {
    /// A scalar on the key's line: bytes [start, end).
    Inline { start: usize, end: usize },
    /// A flow sequence `[...]` on the key's line.
    Flow { start: usize, end: usize },
    /// A block sequence on the following lines, items of plain/quoted scalars.
    Block { after_colon: usize, end: usize, indent: String },
    /// Empty value: `key:` and nothing else on the line.
    Empty { after_colon: usize },
    /// Anything else.
    Complex,
}

#[derive(Debug, Clone)]
struct Entry {
    key: String,
    /// Byte offset of the key's line start.
    line_start: usize,
    /// Byte offset just past the entry's last line (including its newline).
    entry_end: usize,
    value: FmValue,
    layout: Layout,
}

/// A parsed frontmatter block (the text between the `---` lines, with its final newline).
#[derive(Debug, Clone)]
pub struct Frontmatter {
    text: String,
    entries: Vec<Entry>,
    newline: &'static str,
}

impl Frontmatter {
    pub fn parse(text: &str) -> Result<Frontmatter, FmError> {
        let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let entries = scan(text)?;
        Ok(Frontmatter { text: text.to_string(), entries, newline })
    }

    pub fn empty() -> Frontmatter {
        Frontmatter { text: String::new(), entries: vec![], newline: "\n" }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn get(&self, key: &str) -> Option<&FmValue> {
        self.entries.iter().find(|e| e.key == key).map(|e| &e.value)
    }

    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(FmValue::as_str)
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|e| e.key.as_str())
    }

    /// All keys and values, in source order.
    pub fn to_json(&self) -> Map<String, Value> {
        self.entries.iter().map(|e| (e.key.clone(), e.value.to_json())).collect()
    }

    /// Sets a key, changing only that key's bytes, or appends it at the end.
    pub fn set(&mut self, key: &str, value: &FmValue) -> Result<(), FmError> {
        if matches!(value, FmValue::Other(_)) || !valid_key(key) {
            return Err(FmError::Complex(key.into()));
        }
        let nl = self.newline;
        let new_text = match self.entries.iter().find(|e| e.key == key) {
            Some(e) => {
                if &e.value == value && !matches!(e.layout, Layout::Complex) {
                    return Ok(());
                }
                let (start, end, replacement) = match (&e.layout, value) {
                    (Layout::Inline { start, end }, v) | (Layout::Flow { start, end }, v) => (*start, *end, v.emit()),
                    (Layout::Empty { after_colon }, v) => (*after_colon, *after_colon, format!(" {}", v.emit())),
                    (Layout::Block { after_colon, end, indent }, FmValue::List(items)) if !items.is_empty() => {
                        let body: String = items.iter().map(|i| format!("{nl}{indent}- {}", i.emit())).collect();
                        (*after_colon, *end, body)
                    }
                    (Layout::Block { after_colon, end, .. }, v) => (*after_colon, *end, format!(" {}", v.emit())),
                    (Layout::Complex, _) => return Err(FmError::Complex(key.into())),
                };
                format!("{}{}{}", &self.text[..start], replacement, &self.text[end..])
            }
            None => {
                let mut t = self.text.clone();
                if !t.is_empty() && !t.ends_with('\n') {
                    t.push_str(nl);
                }
                t.push_str(&format!("{key}: {}{nl}", value.emit()));
                t
            }
        };
        *self = Frontmatter::parse(&new_text)?;
        Ok(())
    }

    /// Removes a key and its value lines.
    pub fn remove(&mut self, key: &str) -> Result<(), FmError> {
        let Some(e) = self.entries.iter().find(|e| e.key == key) else { return Ok(()) };
        if matches!(e.layout, Layout::Complex) {
            return Err(FmError::Complex(key.into()));
        }
        let new_text = format!("{}{}", &self.text[..e.line_start], &self.text[e.entry_end..]);
        *self = Frontmatter::parse(&new_text)?;
        Ok(())
    }
}

fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Splits a Markdown file into (frontmatter text, body). The frontmatter text excludes the
/// `---` lines; `None` when the file has no frontmatter block.
pub fn split(file: &str) -> (Option<(&str, usize)>, &str) {
    let first_nl = match file.find('\n') {
        Some(i) => i,
        None => return (None, file),
    };
    if file[..first_nl].trim_end_matches('\r') != "---" {
        return (None, file);
    }
    let fm_start = first_nl + 1;
    let mut pos = fm_start;
    while pos <= file.len() {
        let line_end = file[pos..].find('\n').map(|i| pos + i).unwrap_or(file.len());
        let line = file[pos..line_end].trim_end_matches('\r');
        if line == "---" || line == "..." {
            let body_start = (line_end + 1).min(file.len());
            return (Some((&file[fm_start..pos], fm_start)), &file[body_start..]);
        }
        if line_end == file.len() {
            break;
        }
        pos = line_end + 1;
    }
    (None, file)
}

/// Joins frontmatter text and a body into a Markdown file.
pub fn join(fm: &str, body: &str, newline: &str) -> String {
    format!("---{newline}{fm}---{newline}{body}")
}

// ---------------------------------------------------------------------------------------------
// Scanning

struct Ev {
    event: Event<'static>,
    start: usize,
}

fn events(text: &str) -> Result<Vec<Ev>, FmError> {
    // saphyr-parser reports positions in chars; convert them to bytes.
    let char_to_byte: Vec<usize> = text.char_indices().map(|(b, _)| b).chain(std::iter::once(text.len())).collect();
    let mut out = vec![];
    let mut p = Parser::new_from_str(text);
    while let Some(r) = p.next_event() {
        let (e, span) = r.map_err(|e| FmError::Invalid(e.to_string()))?;
        let start = *char_to_byte.get(span.start.index()).unwrap_or(&text.len());
        out.push(Ev { event: own(e), start });
    }
    Ok(out)
}

fn own(e: Event<'_>) -> Event<'static> {
    match e {
        Event::Scalar(v, s, a, t) => Event::Scalar(
            std::borrow::Cow::Owned(v.into_owned()),
            s,
            a,
            t.map(|t| std::borrow::Cow::Owned(t.into_owned())),
        ),
        Event::SequenceStart(a, t) => Event::SequenceStart(a, t.map(|t| std::borrow::Cow::Owned(t.into_owned()))),
        Event::MappingStart(a, t) => Event::MappingStart(a, t.map(|t| std::borrow::Cow::Owned(t.into_owned()))),
        Event::Nothing => Event::Nothing,
        Event::StreamStart => Event::StreamStart,
        Event::StreamEnd => Event::StreamEnd,
        Event::DocumentStart(b) => Event::DocumentStart(b),
        Event::DocumentEnd => Event::DocumentEnd,
        Event::Alias(a) => Event::Alias(a),
        Event::SequenceEnd => Event::SequenceEnd,
        Event::MappingEnd => Event::MappingEnd,
    }
}

/// YAML 1.2 core schema resolution of a plain scalar.
pub fn resolve_plain(s: &str) -> FmValue {
    match s {
        "" | "~" | "null" | "Null" | "NULL" => return FmValue::Null,
        "true" | "True" | "TRUE" => return FmValue::Bool(true),
        "false" | "False" | "FALSE" => return FmValue::Bool(false),
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => return FmValue::Float(f64::INFINITY),
        "-.inf" | "-.Inf" | "-.INF" => return FmValue::Float(f64::NEG_INFINITY),
        ".nan" | ".NaN" | ".NAN" => return FmValue::Float(f64::NAN),
        _ => {}
    }
    let b = s.as_bytes();
    let digits = |x: &[u8]| !x.is_empty() && x.iter().all(u8::is_ascii_digit);
    let unsigned = s.strip_prefix(['-', '+']).unwrap_or(s);
    if digits(unsigned.as_bytes()) {
        if let Ok(i) = s.parse::<i64>() {
            return FmValue::Int(i);
        }
    }
    if let Some(o) = s.strip_prefix("0o") {
        if let Ok(i) = i64::from_str_radix(o, 8) {
            return FmValue::Int(i);
        }
    }
    if let Some(h) = s.strip_prefix("0x") {
        if let Ok(i) = i64::from_str_radix(h, 16) {
            return FmValue::Int(i);
        }
    }
    let is_float = {
        let (mant, exp) = match unsigned.find(['e', 'E']) {
            Some(i) => (&unsigned[..i], Some(&unsigned[i + 1..])),
            None => (unsigned, None),
        };
        let mant_ok = match mant.split_once('.') {
            Some((a, c)) => {
                (a.is_empty() || digits(a.as_bytes()))
                    && (c.is_empty() || digits(c.as_bytes()))
                    && !(a.is_empty() && c.is_empty())
            }
            None => digits(mant.as_bytes()),
        };
        let exp_ok = exp.is_none_or(|e| digits(e.strip_prefix(['-', '+']).unwrap_or(e).as_bytes()));
        mant_ok && exp_ok && (mant.contains('.') || exp.is_some())
    };
    if is_float && !b.is_empty() {
        if let Ok(f) = s.parse::<f64>() {
            return FmValue::Float(f);
        }
    }
    FmValue::Str(s.to_string())
}

fn scalar_value(v: &str, style: ScalarStyle) -> FmValue {
    match style {
        ScalarStyle::Plain => resolve_plain(v),
        _ => FmValue::Str(v.to_string()),
    }
}

/// Reads a whole node (scalar, sequence or mapping) as a value, returning the next index.
fn read_node(evs: &[Ev], mut i: usize) -> Result<(FmValue, usize, bool), FmError> {
    // returns (value, next index, has_anchor_or_tag_or_alias)
    match &evs[i].event {
        Event::Scalar(v, style, anchor, tag) => Ok((scalar_value(v, *style), i + 1, *anchor != 0 || tag.is_some())),
        Event::Alias(_) => Ok((FmValue::Other(Value::Null), i + 1, true)),
        Event::SequenceStart(anchor, tag) => {
            let mut fancy = *anchor != 0 || tag.is_some();
            let mut items = vec![];
            i += 1;
            while !matches!(evs[i].event, Event::SequenceEnd) {
                let (v, n, f) = read_node(evs, i)?;
                fancy |= f;
                items.push(v);
                i = n;
            }
            let simple = items.iter().all(|v| !matches!(v, FmValue::List(_) | FmValue::Other(_)));
            let v = if simple {
                FmValue::List(items)
            } else {
                FmValue::Other(Value::Array(items.iter().map(FmValue::to_json).collect()))
            };
            Ok((v, i + 1, fancy))
        }
        Event::MappingStart(anchor, tag) => {
            let mut fancy = *anchor != 0 || tag.is_some();
            let mut map = Map::new();
            i += 1;
            while !matches!(evs[i].event, Event::MappingEnd) {
                let (k, n, f1) = read_node(evs, i)?;
                let (v, n2, f2) = read_node(evs, n)?;
                fancy |= f1 | f2;
                let key = match k {
                    FmValue::Str(s) => s,
                    other => other.emit(),
                };
                map.insert(key, v.to_json());
                i = n2;
            }
            Ok((FmValue::Other(Value::Object(map)), i + 1, fancy))
        }
        other => Err(FmError::Invalid(format!("unexpected {other:?}"))),
    }
}

fn line_start_of(text: &str, at: usize) -> usize {
    text[..at].rfind('\n').map(|i| i + 1).unwrap_or(0)
}

fn line_end_of(text: &str, at: usize) -> usize {
    text[at..].find('\n').map(|i| at + i).unwrap_or(text.len())
}

/// End of a plain scalar on one line: before a ` #comment` and trailing whitespace.
fn plain_end(text: &str, start: usize) -> usize {
    let le = line_end_of(text, start);
    let line = &text[start..le];
    let mut end = line.len();
    let bytes = line.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'#' && i > 0 && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            end = i;
            break;
        }
    }
    start + line[..end].trim_end_matches([' ', '\t', '\r']).len()
}

fn quoted_end(text: &str, start: usize) -> Option<usize> {
    let b = text.as_bytes();
    let q = b[start];
    let mut i = start + 1;
    while i < b.len() {
        if q == b'"' && b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == q {
            if q == b'\'' && b.get(i + 1) == Some(&b'\'') {
                i += 2;
                continue;
            }
            return Some(i + 1);
        }
        i += 1;
    }
    None
}

fn flow_end(text: &str, start: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut depth = 0i32;
    let mut i = start;
    while i < b.len() {
        match b[i] {
            b'"' | b'\'' => {
                i = quoted_end(text, i)?;
                continue;
            }
            b'[' | b'{' => depth += 1,
            b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Byte just past the last non-blank, non-comment content line in [from, to).
fn content_end(text: &str, from: usize, to: usize) -> usize {
    let mut end = from;
    let mut pos = from;
    while pos < to {
        let le = line_end_of(text, pos).min(to);
        let line = text[pos..le].trim();
        if !line.is_empty() && !line.starts_with('#') {
            end = le;
        }
        pos = le + 1;
    }
    end
}

fn scan(text: &str) -> Result<Vec<Entry>, FmError> {
    if text.trim().is_empty() {
        return Ok(vec![]);
    }
    let evs = events(text)?;
    // StreamStart, DocumentStart, MappingStart ... MappingEnd, DocumentEnd, [DocumentStart...], StreamEnd
    let mut i = 0;
    while i < evs.len() && !matches!(evs[i].event, Event::DocumentStart(_)) {
        i += 1;
    }
    i += 1;
    match evs.get(i).map(|e| &e.event) {
        Some(Event::MappingStart(a, t)) if *a == 0 && t.is_none() => {}
        Some(Event::MappingStart(..)) => {
            return Err(FmError::Invalid("the top-level mapping has an anchor or tag".into()))
        }
        Some(Event::Scalar(v, ..)) if v.is_empty() => return Ok(vec![]),
        _ => return Err(FmError::Invalid("frontmatter is not a mapping".into())),
    }
    i += 1;
    let mut raw = vec![];
    while !matches!(evs[i].event, Event::MappingEnd) {
        let key_ev = i;
        let key = match &evs[i].event {
            Event::Scalar(k, ..) => k.to_string(),
            _ => return Err(FmError::Invalid("a top-level key is not a scalar".into())),
        };
        let (value, next, fancy) = read_node(&evs, i + 1)?;
        raw.push((key, key_ev, i + 1, value, fancy));
        i = next;
    }
    if evs[i + 1..].iter().any(|e| matches!(e.event, Event::DocumentStart(_))) {
        return Err(FmError::Invalid("frontmatter holds more than one document".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for (k, ..) in &raw {
        if !seen.insert(k.clone()) {
            return Err(FmError::Invalid(format!("duplicate key {k:?}")));
        }
    }

    let mut entries = vec![];
    for (n, (key, key_ev, val_ev, value, fancy)) in raw.iter().enumerate() {
        let key_start = evs[*key_ev].start;
        let line_start = line_start_of(text, key_start);
        let next_line_start = raw.get(n + 1).map(|r| line_start_of(text, evs[r.1].start)).unwrap_or(text.len());
        let top_level_key = key_start == line_start;
        let key_line_end = line_end_of(text, key_start);
        let colon = text[key_start..key_line_end].find(':').map(|c| key_start + c + 1);
        let entry_end_content = content_end(text, line_start, next_line_start);
        let entry_end =
            if entry_end_content < text.len() { (entry_end_content + 1).min(text.len()) } else { text.len() };
        let vs = evs[*val_ev].start;
        let layout = if let (false, true, Some(colon)) = (*fancy, top_level_key, colon) {
            match (&evs[*val_ev].event, value) {
                (Event::Scalar(v, ScalarStyle::Plain, ..), _) if v.is_empty() => Layout::Empty { after_colon: colon },
                (Event::Scalar(_, ScalarStyle::Plain, ..), _) if vs < key_line_end => {
                    let end = plain_end(text, vs);
                    // A plain scalar continued on more lines is complex.
                    if content_end(text, line_start, next_line_start) > key_line_end {
                        Layout::Complex
                    } else {
                        Layout::Inline { start: vs, end }
                    }
                }
                (Event::Scalar(_, ScalarStyle::SingleQuoted | ScalarStyle::DoubleQuoted, ..), _)
                    if vs < key_line_end =>
                {
                    match quoted_end(text, vs) {
                        Some(end)
                            if content_end(text, line_start, next_line_start)
                                <= line_end_of(text, end.saturating_sub(1)) =>
                        {
                            Layout::Inline { start: vs, end }
                        }
                        _ => Layout::Complex,
                    }
                }
                (Event::SequenceStart(..), FmValue::List(_))
                    if vs < key_line_end && text.as_bytes().get(vs) == Some(&b'[') =>
                {
                    match flow_end(text, vs) {
                        Some(end) if content_end(text, line_start, next_line_start) <= line_end_of(text, end - 1) => {
                            Layout::Flow { start: vs, end }
                        }
                        _ => Layout::Complex,
                    }
                }
                (Event::SequenceStart(..), FmValue::List(items)) if vs >= key_line_end && !items.is_empty() => {
                    // Every item must be a one-line scalar `- value`.
                    let end = content_end(text, key_line_end, next_line_start);
                    let body = &text[key_line_end..end];
                    let item_lines: Vec<&str> = body
                        .split('\n')
                        .map(|l| l.trim_end_matches('\r'))
                        .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
                        .collect();
                    let indent: String =
                        item_lines.first().map(|l| l.chars().take_while(|c| *c == ' ').collect()).unwrap_or_default();
                    if item_lines.len() == items.len() && item_lines.iter().all(|l| l.trim_start().starts_with("- ")) {
                        Layout::Block { after_colon: colon, end, indent }
                    } else {
                        Layout::Complex
                    }
                }
                _ => Layout::Complex,
            }
        } else {
            Layout::Complex
        };
        entries.push(Entry { key: key.clone(), line_start, entry_end, value: value.clone(), layout });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# my own comment\nid: \"0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44\"\nkind: note\nkind-version: 1\ntitle: 'Jacques Ellul'   # kept\nunknown.thing: {a: 1, b: [x, y]}\ntags:\n  - philosophy\n  - \"technique\"\n\n# between\nflow: [1, 'two']\nempty:\nlit: |\n  keep me\n  exactly\nlast: plain value # c\n";

    #[test]
    fn reads_values_in_order() {
        let fm = Frontmatter::parse(SAMPLE).unwrap();
        let keys: Vec<_> = fm.keys().collect();
        assert_eq!(
            keys,
            ["id", "kind", "kind-version", "title", "unknown.thing", "tags", "flow", "empty", "lit", "last"]
        );
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
}
