//! Page checks: is a saved page really the page, or an error page, a paywall, a
//! human-verification challenge, a sign-in wall, or empty? A snapshot is always kept; its
//! checks are stored with it and shown, so the user decides.

use librarium_contracts::ports::SavedPage;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Check {
    /// "error", "not-found", "paywall", "verification", "sign-in", "drawn", "incomplete",
    /// "empty".
    pub kind: String,
    pub reason: String,
}

fn push(out: &mut Vec<Check>, kind: &str, reason: String) {
    out.push(Check { kind: kind.into(), reason });
}

fn has_any(hay: &str, needles: &[&str]) -> Option<String> {
    needles.iter().find(|n| hay.contains(*n)).map(|n| n.to_string())
}

pub fn check(p: &SavedPage) -> Vec<Check> {
    let mut out = vec![];
    let html = p.html.to_lowercase();
    let title = p.title.to_lowercase();
    let text = p.visible_text.to_lowercase();
    let words = p.visible_text.split_whitespace().count();

    if let Some(s) = p.status.filter(|s| *s >= 400) {
        push(&mut out, if s == 404 || s == 410 { "not-found" } else { "error" }, format!("The server answered {s}."));
    } else if words < 400
        && (has_any(&title, &["404", "not found", "page not found", "page introuvable"]).is_some()
            || has_any(
                &text,
                &[
                    "couldn’t find that page",
                    "couldn't find that page",
                    "page you requested",
                    "this page doesn’t exist",
                    "this page doesn't exist",
                ],
            )
            .is_some())
    {
        push(&mut out, "not-found", "The page says it can’t be found.".into());
    } else if words < 400
        && has_any(&title, &["500 internal", "502 bad gateway", "503 service", "504 gateway"]).is_some()
    {
        push(&mut out, "error", "The page is a server error.".into());
    }

    // The article's own words: a challenge page or a paywall teaser has few. Full articles
    // often load captcha scripts (for comment or sign-up forms) or mark themselves as
    // subscriber content in metadata while showing everything, so those signs alone aren't
    // enough.
    let article_words = p.text.split_whitespace().count();
    if let Some(m) = has_any(
        &html,
        &[
            "challenge-platform",
            "_cf_chl_opt",
            "cf-browser-verification",
            "cf-turnstile",
            "g-recaptcha",
            "h-captcha",
            "hcaptcha.com",
            "recaptcha/api",
            "px-captcha",
            "datadome",
        ],
    )
    .filter(|_| article_words < 400)
    {
        push(&mut out, "verification", format!("The page asks to verify a human ({m})."));
    } else if words < 400
        && (has_any(&title, &["just a moment", "are you a robot", "attention required", "access denied"]).is_some()
            || has_any(
                &text,
                &[
                    "verify you are human",
                    "checking your browser",
                    "checking if the site connection is secure",
                    "unusual traffic",
                ],
            )
            .is_some())
    {
        push(&mut out, "verification", "The page asks to verify a human.".into());
    }

    let schema_locked = article_words < 500
        && (html.contains("\"isaccessibleforfree\":false")
            || html.contains("\"isaccessibleforfree\": false")
            || html.contains("\"isaccessibleforfree\":\"false\"")
            || html.contains("content_tier\" content=\"locked\""));
    let gate = has_any(
        &text,
        &[
            "subscribe to continue",
            "subscribe to read",
            "subscribers only",
            "for subscribers",
            "already a subscriber",
            "reached your limit of free",
            "free articles this month",
            "become a member to keep reading",
            "become a member to read",
            "to continue reading, subscribe",
            "sign up to continue reading",
        ],
    );
    if schema_locked || gate.is_some() {
        push(
            &mut out,
            "paywall",
            match (schema_locked, gate) {
                (true, _) => "The page marks its content as for subscribers only.".into(),
                (_, Some(g)) => format!("The page says “{g}”."),
                _ => unreachable!(),
            },
        );
    }

    if words < 150
        && has_any(&text, &["sign in to continue", "log in to continue", "login to continue", "sign in to read"])
            .is_some()
    {
        push(&mut out, "sign-in", "The page asks to sign in.".into());
    }
    if !p.complete {
        push(&mut out, "incomplete", "The page was still loading when it was saved, so parts may be missing.".into());
    }
    if p.drawn >= 0.3 && p.text.split_whitespace().count() < 300 {
        push(
            &mut out,
            "drawn",
            "Most of this page is drawn as a picture (as in apps like Google Docs), so its text can’t be searched or quoted. If the site can export the document, add that file instead.".into(),
        );
    }
    if words < 20 && p.images == 0 && out.is_empty() {
        out.push(Check {
            kind: "empty".into(),
            reason: "The page shows almost nothing (it may need scripts that didn’t run).".into(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use librarium_contracts::ports::PageSaver;
    use librarium_testkit::pages::FixturePages;
    use std::time::Duration;

    fn page(file: &str, status: u16) -> SavedPage {
        let html =
            std::fs::read_to_string(format!("{}/../../../tests/fixtures/pages/{file}", env!("CARGO_MANIFEST_DIR")))
                .unwrap();
        FixturePages::default()
            .with("https://x.test/", status, &html)
            .save("https://x.test/", Duration::from_secs(1))
            .unwrap()
    }

    fn kinds(file: &str, status: u16) -> Vec<String> {
        check(&page(file, status)).into_iter().map(|c| c.kind).collect()
    }

    #[test]
    fn stored_fixture_pages() {
        assert_eq!(
            kinds("article.html", 200),
            Vec::<String>::new(),
            "an ordinary article passes (it mentions subscribing, but isn't gated)"
        );
        assert_eq!(kinds("not-found.html", 404), ["not-found"]);
        assert_eq!(kinds("soft-404.html", 200), ["not-found"]);
        assert_eq!(kinds("server-error.html", 502), ["error"]);
        assert_eq!(kinds("server-error.html", 200), ["error"]);
        assert_eq!(kinds("paywall-schema.html", 200), ["paywall"]);
        assert_eq!(kinds("paywall-text.html", 200), ["paywall"]);
        assert_eq!(kinds("cloudflare.html", 403), ["error", "verification"]);
        assert_eq!(kinds("cloudflare.html", 200), ["verification"]);
        assert_eq!(kinds("captcha.html", 200), ["verification"]);
        assert_eq!(kinds("login-wall.html", 200), ["sign-in"]);
        assert_eq!(kinds("empty.html", 200), ["empty"]);
        assert_eq!(kinds("canvas.html", 200), ["drawn"]);
        assert_eq!(
            kinds("full-with-widgets.html", 200),
            Vec::<String>::new(),
            "a full article with a comment-form captcha and subscriber metadata is not flagged"
        );
        let mut slow = page("article.html", 200);
        slow.complete = false;
        assert_eq!(check(&slow).into_iter().map(|c| c.kind).collect::<Vec<_>>(), ["incomplete"]);
    }
}
