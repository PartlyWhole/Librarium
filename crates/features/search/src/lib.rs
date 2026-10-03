//! Search: one search over everything, ranked, with highlighted passages that open at the
//! exact place. Text is indexed in passages of up to about 120 words.

use librarium_contracts::api::SearchHit;
use librarium_contracts::ports::{Passage, TextQuery, ViewIndex, ViewSpec};
use librarium_contracts::{BackendError, Id, Result};
use librarium_kernel::links::parse_links;
use librarium_kernel::methods::{ApiMethod, MethodCtx};
use librarium_kernel::registry::{DuplicateId, Registry};
use librarium_kernel::views::{DerivedView, ViewRecord};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

pub const ID: &str = "search";
pub const VIEW: &str = "search";
pub const PASSAGE_WORDS: usize = 120;

#[derive(Clone, Debug, Deserialize)]
struct QueryParams {
    text: String,
    #[serde(default)]
    kinds: Vec<String>,
    #[serde(default)]
    limit: Option<u32>,
}

/// Splits text into passages of up to `max` words, at paragraph and then sentence ends.
/// Links show their labels. Returns (code-point offset, passage text).
pub fn passages(text: &str, max: usize) -> Vec<(i64, String)> {
    // Links become their labels (UUIDs would only add noise).
    let mut plain = String::with_capacity(text.len());
    let mut map: Vec<usize> = Vec::with_capacity(text.len()); // plain char index -> source char index
    let links = parse_links(text);
    let mut li = 0;
    let mut src_char = 0usize;
    let mut i = 0usize;
    let bytes_to_char: Vec<usize> = {
        let mut v = vec![0; text.len() + 1];
        let mut c = 0;
        for (b, ch) in text.char_indices() {
            for k in 0..ch.len_utf8() {
                v[b + k] = c;
            }
            c += 1;
        }
        v[text.len()] = c;
        v
    };
    while i < text.len() {
        if let Some(l) = links.get(li) {
            if l.range.start == i {
                for ch in l.label.chars() {
                    plain.push(ch);
                    map.push(bytes_to_char[i]);
                }
                i = l.range.end;
                src_char = bytes_to_char[i];
                li += 1;
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap();
        plain.push(ch);
        map.push(src_char);
        src_char += 1;
        i += ch.len_utf8();
    }
    // Paragraphs, then sentences, then words.
    let chars: Vec<char> = plain.chars().collect();
    let mut units: Vec<(usize, String)> = vec![]; // (plain char start, text)
    let mut start = 0;
    let mut k = 0;
    while k <= chars.len() {
        let blank = k == chars.len() || (chars[k] == '\n' && chars.get(k + 1).is_some_and(|c| *c == '\n'));
        if blank {
            let para: String = chars[start..k].iter().collect();
            if !para.trim().is_empty() {
                units.extend(split_long(&para, start, max));
            }
            while k < chars.len() && chars[k] == '\n' {
                k += 1;
            }
            start = k;
            if k == chars.len() {
                break;
            }
        } else {
            k += 1;
        }
    }
    // Group small units up to the limit.
    let mut out: Vec<(i64, String)> = vec![];
    let mut cur: Option<(usize, String, usize)> = None;
    for (s, t) in units {
        let w = t.split_whitespace().count();
        match &mut cur {
            Some((_, text, words)) if *words + w <= max => {
                text.push_str("\n\n");
                text.push_str(&t);
                *words += w;
            }
            _ => {
                if let Some((s0, t0, _)) = cur.take() {
                    out.push((map.get(s0).copied().unwrap_or(0) as i64, t0));
                }
                cur = Some((s, t, w));
            }
        }
    }
    if let Some((s0, t0, _)) = cur {
        out.push((map.get(s0).copied().unwrap_or(0) as i64, t0));
    }
    out
}

fn split_long(para: &str, start: usize, max: usize) -> Vec<(usize, String)> {
    if para.split_whitespace().count() <= max {
        return vec![(start, para.trim_end().to_string())];
    }
    let chars: Vec<char> = para.chars().collect();
    let mut out = vec![];
    let mut s = 0;
    let mut words = 0;
    let mut last_sentence_end = None;
    let mut in_word = false;
    for (i, c) in chars.iter().enumerate() {
        if c.is_whitespace() {
            if in_word {
                words += 1;
            }
            in_word = false;
            if i > 0 && matches!(chars[i - 1], '.' | '!' | '?' | '…') {
                last_sentence_end = Some(i);
            }
        } else {
            in_word = true;
        }
        if words >= max {
            let cut = last_sentence_end.filter(|e| *e > s).unwrap_or(i);
            out.push((start + s, chars[s..cut].iter().collect::<String>().trim().to_string()));
            s = cut;
            while s < chars.len() && chars[s].is_whitespace() {
                s += 1;
            }
            words = chars[s..=i.max(s)].iter().collect::<String>().split_whitespace().count().saturating_sub(1);
            last_sentence_end = None;
        }
    }
    if s < chars.len() {
        let rest: String = chars[s..].iter().collect();
        if !rest.trim().is_empty() {
            out.push((start + s, rest.trim().to_string()));
        }
    }
    out
}

pub struct SearchView;

impl DerivedView for SearchView {
    fn spec(&self) -> ViewSpec {
        ViewSpec { name: VIEW.into(), schema_version: 2, tables: vec![], text: true }
    }
    fn apply(&self, idx: &mut dyn ViewIndex, rec: &ViewRecord) -> Result<()> {
        let id = rec.entry.id.to_string();
        let mut ps: Vec<Passage> = passages(rec.text, PASSAGE_WORDS)
            .into_iter()
            .enumerate()
            .map(|(n, (offset, body))| Passage {
                record: id.clone(),
                kind: rec.entry.kind.clone(),
                ordinal: n as i64,
                title: rec.entry.title.clone(),
                body,
                offset,
            })
            .collect();
        if ps.is_empty() {
            // The title alone is still findable.
            ps.push(Passage {
                record: id.clone(),
                kind: rec.entry.kind.clone(),
                ordinal: 0,
                title: rec.entry.title.clone(),
                body: String::new(),
                offset: 0,
            });
        }
        idx.put_passages(&id, &ps)
    }
    fn remove(&self, idx: &mut dyn ViewIndex, id: Id) -> Result<()> {
        idx.delete_passages(&id.to_string())
    }
}

pub fn contribute_views(v: &mut Vec<(String, Arc<dyn DerivedView>)>) {
    v.push((ID.into(), Arc::new(SearchView)));
}

pub fn query(ctx: &MethodCtx, text: &str, kinds: Vec<String>, limit: u32) -> Result<Vec<SearchHit>> {
    let views = ctx
        .views
        .ok_or_else(|| BackendError::new(librarium_contracts::ErrorCode::NotReady, "The index is starting."))?;
    let hits = views.query(VIEW, |idx| idx.search(&TextQuery { text: text.into(), kinds, limit }))?;
    Ok(hits
        .into_iter()
        .filter_map(|h| {
            let id: Id = h.record.parse().ok()?;
            let title = ctx.library.store.get(id).map(|e| e.title).unwrap_or(h.title);
            Some(SearchHit { id, kind: h.kind, title, snippet: h.snippet, offset: h.offset, score: h.score })
        })
        .collect())
}

pub fn contribute_methods(r: &mut Registry<ApiMethod>) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "search.query",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: QueryParams = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            Ok(serde_json::to_value(query(ctx, &p.text, p.kinds, p.limit.unwrap_or(50).min(500))?).unwrap())
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passages_follow_paragraphs_and_stay_short() {
        let text = "First paragraph.\n\nSecond one, with [[a link|0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44]].\n\n";
        let p = passages(text, 120);
        assert_eq!(p.len(), 1, "small paragraphs group: {p:?}");
        assert!(p[0].1.contains("with a link."));
        let long: String = (0..300).map(|i| if i % 20 == 19 { format!("w{i}. ") } else { format!("w{i} ") }).collect();
        let p = passages(&format!("Intro.\n\n{long}"), 120);
        assert!(p.len() >= 3, "{}", p.len());
        for (_, t) in &p {
            assert!(t.split_whitespace().count() <= 121, "{}", t.split_whitespace().count());
        }
        // Offsets are code points into the original text.
        let t = "Ünïcode first.\n\nSecond paragraph here.";
        let p = passages(t, 3);
        assert_eq!(p[1].0, 16);
        assert!(t.chars().skip(p[1].0 as usize).collect::<String>().starts_with("Second"));
    }
}
