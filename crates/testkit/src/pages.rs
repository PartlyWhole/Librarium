//! A PageSaver that answers from stored fixture pages (HTML files), with a stand-in PDF.

use librarium_contracts::ports::{PageSaver, SavedPage};
use librarium_contracts::{BackendError, Result};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
pub struct FixturePages {
    /// url → (status, html)
    pages: Mutex<HashMap<String, (u16, String)>>,
    pub saves: Mutex<Vec<String>>,
}

impl FixturePages {
    pub fn with(self, url: &str, status: u16, html: &str) -> Self {
        self.pages.lock().unwrap().insert(url.into(), (status, html.into()));
        self
    }
}

fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let i = s.find(a)? + a.len();
    let j = s[i..].find(b)? + i;
    Some(&s[i..j])
}

/// Visible text of simple HTML: tags removed, script and style dropped.
pub fn html_text(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let tag = rest[i + 1..].split(|c: char| c.is_whitespace() || c == '>').next().unwrap_or("").to_lowercase();
        if tag == "script" || tag == "style" || tag == "title" {
            let close = format!("</{tag}>");
            rest = rest[i..].find(&close).map(|j| &rest[i + j + close.len()..]).unwrap_or("");
            continue;
        }
        rest = rest[i..].find('>').map(|j| &rest[i + j + 1..]).unwrap_or("");
        out.push(' ');
    }
    out.push_str(rest);
    // As the real saver does: soft hyphens and zero-width characters don't split words.
    out.retain(|c| !matches!(c, '\u{AD}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}'));
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl PageSaver for FixturePages {
    fn save(&self, url: &str, _timeout: Duration) -> Result<SavedPage> {
        self.saves.lock().unwrap().push(url.into());
        let (status, html) = self
            .pages
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or_else(|| BackendError::io(format!("could not connect to {url}")))?;
        let text = html_text(&html);
        let meta = |name: &str| between(&html, &format!("<meta name=\"{name}\" content=\""), "\"").map(str::to_string);
        Ok(SavedPage {
            final_url: url.into(),
            status: Some(status),
            title: between(&html, "<title>", "</title>").unwrap_or("").trim().to_string(),
            author: meta("author"),
            publication: between(&html, "<meta property=\"og:site_name\" content=\"", "\"").map(str::to_string),
            published: between(&html, "<meta property=\"article:published_time\" content=\"", "\"").map(str::to_string),
            language: between(&html, "<html lang=\"", "\"").map(str::to_string),
            text: text.clone(),
            visible_text: text,
            html: html.clone(),
            images: html.matches("<img").count() as u32,
            // The stand-in reads a canvas's share of the page from `data-drawn`.
            complete: true,
            drawn: between(&html, "data-drawn=\"", "\"").and_then(|s| s.parse().ok()).unwrap_or(0.0),
            // The stand-in differs when the page does.
            pdf: format!(
                "%PDF-1.4\n% stand-in for {url}, {} bytes of HTML, checksum {}\n%%EOF\n",
                html.len(),
                html.bytes().fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32))
            )
            .into_bytes(),
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn passes_the_shared_suite() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/pages/");
        let read = |f: &str| std::fs::read_to_string(format!("{dir}{f}")).unwrap();
        let saver = super::FixturePages::default()
            .with("http://fixture.test/article.html", 200, &read("article.html"))
            .with("http://fixture.test/missing.html", 404, &read("not-found.html"))
            .with("http://fixture.test/canvas.html", 200, &read("canvas.html"));
        crate::suites::pagesaver::run(&saver, "http://fixture.test");
    }
}
