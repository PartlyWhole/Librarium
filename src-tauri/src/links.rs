//! Links between records: `[[label|uuid]]` and embeds `![[label|uuid]]`, and keeping their
//! labels fresh.
//!
//! - The ID follows the last unescaped `|` and must be canonical. In a table cell the
//!   separator is written `\|`, so with no unescaped `|` left, a final `\|<uuid>` works too.
//! - Labels escape `\`, `[`, `]` and `|` with `\`; newlines become spaces.
//! - Nothing in code, fenced blocks or HTML is a link. Code is found with a real Markdown
//!   parser, and indented lines are never code.

use crate::error::{Error, Result};
use crate::jobs::JobCtx;
use crate::store::{record, Library};
use crate::types::{ResolveParams, Resolved};
use crate::util::{parse_id, Id};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde_json::Value;
use std::ops::Range;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// Byte range of the whole link (including `!` for an embed).
    pub range: Range<usize>,
    pub label: String,
    pub id: Option<Id>,
    pub embed: bool,
}

/// Byte ranges of code (spans and fenced blocks) and HTML in Markdown text.
///
/// pulldown-cmark can't turn indented code off, so it reads the text with each line's leading
/// whitespace removed, and the ranges are mapped back.
pub fn code_ranges(text: &str) -> Vec<Range<usize>> {
    let mut flat = String::with_capacity(text.len());
    // For each line of `flat`: (its start there, bytes removed up to and including it).
    let mut lines: Vec<(usize, usize)> = vec![];
    let mut removed = 0;
    for line in text.split_inclusive('\n') {
        let rest = line.trim_start_matches([' ', '\t']);
        removed += line.len() - rest.len();
        lines.push((flat.len(), removed));
        flat.push_str(rest);
    }
    let back = |p: usize| {
        let i = lines.partition_point(|&(start, _)| start <= p).saturating_sub(1);
        p + lines.get(i).map_or(0, |&(_, r)| r)
    };
    let mut out = vec![];
    let mut block_start = None;
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for (ev, r) in Parser::new_ext(&flat, opts).into_offset_iter() {
        match ev {
            Event::Code(_) | Event::Html(_) | Event::InlineHtml(_) => out.push(back(r.start)..back(r.end)),
            Event::Start(Tag::CodeBlock(_)) => block_start = Some(r.start),
            Event::End(TagEnd::CodeBlock) => {
                if let Some(s) = block_start.take() {
                    out.push(back(s)..back(r.end));
                }
            }
            _ => {}
        }
    }
    out
}

/// Escapes a label for writing inside `[[…]]`.
pub fn escape_label(label: &str) -> String {
    let mut s = String::with_capacity(label.len());
    let mut newline = false;
    for c in label.chars() {
        match c {
            '\n' | '\r' => {
                if !newline {
                    s.push(' ');
                }
                newline = true;
                continue;
            }
            '\\' | '[' | ']' | '|' => s.push('\\'),
            _ => {}
        }
        newline = false;
        s.push(c);
    }
    s
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some(n @ ('\\' | '[' | ']' | '|')) => out.push(n),
            Some(n) => {
                out.push('\\');
                out.push(n);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Writes a link (or an embed).
pub fn format_link(label: &str, id: Id, embed: bool) -> String {
    format!("{}[[{}|{id}]]", if embed { "!" } else { "" }, escape_label(label))
}

/// Splits the inside of `[[…]]` into (label, id).
fn split_inner(inner: &str) -> (String, Option<Id>) {
    let b = inner.as_bytes();
    let (mut bar, mut escaped_bar) = (None, None);
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            if b[i + 1] == b'|' {
                escaped_bar = Some(i);
            }
            i += 2;
            continue;
        }
        if b[i] == b'|' {
            bar = Some(i);
        }
        i += 1;
    }
    let found = match (bar, escaped_bar) {
        (Some(p), _) => parse_id(&inner[p + 1..]).map(|id| (p, id)),
        (None, Some(p)) => parse_id(&inner[p + 2..]).map(|id| (p, id)),
        _ => None,
    };
    match found {
        Some((p, id)) => (unescape(&inner[..p]), Some(id)),
        None => (unescape(inner), None),
    }
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
            if let Some(end) = closing(b, i + 2) {
                let inner = &text[i + 2..end];
                let embed = i > 0 && b[i - 1] == b'!' && !(i > 1 && b[i - 2] == b'\\');
                if !inner.is_empty() {
                    let (label, id) = split_inner(inner);
                    out.push(Link { range: if embed { i - 1..end + 2 } else { i..end + 2 }, label, id, embed });
                }
                i = end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// The `]]` closing a link opened before `from`, on the same line; a `[` or a lone `]` first
/// means it isn't a link.
fn closing(b: &[u8], from: usize) -> Option<usize> {
    let mut j = from;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b']' if b.get(j + 1) == Some(&b']') => return Some(j),
            b'\n' | b'\r' | b'[' | b']' => return None,
            _ => j += 1,
        }
    }
    None
}

/// The line holding a link, with links shown as labels, shortened.
pub fn context(text: &str, range: Range<usize>) -> String {
    let start = text[..range.start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let end = text[range.end..].find('\n').map(|i| range.end + i).unwrap_or(text.len());
    let line = &text[start..end];
    let mut out = String::new();
    let mut last = 0;
    for l in parse_links(line) {
        out.push_str(&line[last..l.range.start]);
        out.push_str(&l.label);
        last = l.range.end;
    }
    out.push_str(&line[last..]);
    let out = out.trim().trim_start_matches(['#', '>', '-', '*', ' ']).trim();
    if out.chars().count() > 200 {
        out.chars().take(199).collect::<String>() + "…"
    } else {
        out.to_string()
    }
}

/// The user chose the target of an unresolved link: each `[[label]]` in the source becomes
/// `[[label|target]]`.
pub fn resolve(lib: &Library, p: ResolveParams) -> Result<Resolved> {
    let e = lib.index.get(p.source).ok_or_else(|| Error::not_found("That note can’t be found."))?;
    if lib.index.get(p.target).is_none() {
        return Err(Error::not_found("That record can’t be found."));
    }
    let w = lib.write();
    let changed = record::rewrite_body(&w, p.source, &e.hash, |body| {
        let mut out = body.to_string();
        let mut changed = false;
        for l in parse_links(body).into_iter().rev() {
            if l.id.is_none() && l.label == p.label {
                out.replace_range(l.range.clone(), &format_link(&l.label, p.target, l.embed));
                changed = true;
            }
        }
        changed.then_some(out)
    })?;
    Ok(Resolved { changed })
}

/// The `links.repair` job, after a record changed: labels that were its old title follow a
/// rename (labels in the writer's own words stay), and missing IDs are filled in where exactly
/// one record has the label as its title. It waits for a quiet folder and never writes into a
/// note with unsaved text; labels are only a cache, so giving up is never an error.
pub fn repair(lib: &Library, payload: &Value, job: &JobCtx) -> Result<()> {
    let id: Id = payload["id"].as_str().and_then(parse_id).ok_or_else(|| Error::invalid("no record"))?;
    for _ in 0..100 {
        if lib.quiet() {
            break;
        }
        job.check_cancelled()?;
        std::thread::sleep(Duration::from_millis(100));
    }
    if !lib.quiet() {
        return Ok(());
    }
    let Some(e) = lib.index.get(id) else { return Ok(()) };
    if let Some(old) = payload["old_title"].as_str().filter(|old| *old != e.title) {
        for b in lib.index.backlinks(id)? {
            if !b.embed {
                repair_source(lib, b.source, Some((id, &e.title, old)))?;
            }
        }
    }
    for source in lib.index.unresolved_sources(&e.title)? {
        repair_source(lib, source, None)?;
    }
    if lib.index.has_resolvable(id) {
        repair_source(lib, id, None)?;
    }
    Ok(())
}

/// Rewrites one source's links: labels of links to the renamed target that were its old title,
/// and missing IDs whose label names exactly one record. Returns whether it wrote.
fn repair_source(lib: &Library, source: Id, renamed: Option<(Id, &str, &str)>) -> Result<bool> {
    let Some(e) = lib.index.get(source) else { return Ok(false) };
    if e.read_only.is_some() || lib.drafts.get(source).is_some() {
        return Ok(false);
    }
    let w = lib.write();
    let result = record::rewrite_body(&w, source, &e.hash, |body| {
        let mut out = body.to_string();
        let mut changed = false;
        for l in parse_links(body).into_iter().rev() {
            let replacement = match (l.id, renamed) {
                (Some(id), Some((t, title, old))) if id == t && !l.embed && l.label == old && !title.is_empty() => {
                    Some(format_link(title, id, false))
                }
                (None, _) => only_titled(lib, &l.label).map(|id| format_link(&l.label, id, l.embed)),
                _ => None,
            };
            if let Some(r) = replacement {
                out.replace_range(l.range.clone(), &r);
                changed = true;
            }
        }
        changed.then_some(out)
    });
    match result {
        Err(e) if e.code == crate::error::Code::Conflict => Ok(false),
        r => r,
    }
}

/// The one record with this title, if exactly one has it.
fn only_titled(lib: &Library, title: &str) -> Option<Id> {
    match lib.index.with_title(title).ok()?.as_slice() {
        [only] if !title.is_empty() => Some(only.id),
        _ => None,
    }
}
