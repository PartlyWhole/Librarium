//! Saving web pages: the `library.savePage` job. Each save makes a faithful PDF and clean text
//! in `snapshots/<at>/`, as a new item, or as a new snapshot of the item already saved from the
//! same address (unless that item is archived). A page that never reached the web is never kept.

pub mod checks;
pub mod webkit;

use crate::error::{Error, Result};
use crate::jobs::JobCtx;
use crate::library::{item, saved_with, FOLDER, FORMAT, KIND, SNAPSHOT, SNAPSHOTS};
use crate::store::frontmatter::FmValue;
use crate::store::record::Entry;
use crate::store::{files, folders, Library};
use crate::types::{JobInfo, SavePageParams};
use crate::util::{iso_utc, json_bytes, new_id, now_ms, sha256};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

/// How long one page may take.
const TIMEOUT: Duration = Duration::from_secs(90);
/// What `text.json` says made it.
pub const PAGE_EXTRACTOR: &str = "webkit-page 1";

static SAVER: OnceLock<webkit::Saver> = OnceLock::new();

/// Makes the page saver, and its hidden window now, while the app is starting in front: making
/// one later would bring the app forward in the middle of whatever the user is doing.
pub fn init(app: tauri::AppHandle) {
    SAVER.get_or_init(|| webkit::Saver::new(app)).warm();
}

/// An http(s) address with a host: the only kind a saved page can come from.
pub fn is_web_address(u: &str) -> bool {
    let lower = u.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
    rest.and_then(|r| r.split(['/', '?', '#']).next()).is_some_and(|host| !host.is_empty())
}

/// The item already saved from this address (its source or final address, ignoring the
/// `#fragment` and a trailing `/`), passing over items with any of the `hide` fields set.
pub fn item_for_url(lib: &Library, url: &str, hide: &[String]) -> Option<Entry> {
    let norm = |u: &str| u.split('#').next().unwrap_or("").trim_end_matches('/').to_string();
    if !is_web_address(url) {
        return None;
    }
    let want = norm(url);
    lib.index.list(Some(KIND)).ok()?.into_iter().find(|e| {
        let hidden = hide.iter().any(|f| e.fields.get(f).is_some_and(|v| !v.is_null()));
        let p = e.fields.get("provenance");
        let urls = [p.and_then(|p| p["source"].as_str()), p.and_then(|p| p["final-url"].as_str())];
        !hidden && urls.iter().flatten().any(|u| norm(u) == want)
    })
}

/// Queues a save (one job per address at a time).
pub fn enqueue(lib: &Library, p: SavePageParams) -> Result<JobInfo> {
    let url = p.url.trim();
    if !is_web_address(url) {
        return Err(Error::invalid("That isn’t a web address (it should start with https://)."));
    }
    let folder = p.folder.as_deref().map(str::trim).filter(|f| !f.is_empty()).map(folders::clean_folder).transpose()?;
    let mut hide = p.hide;
    if !hide.iter().any(|h| h == crate::archive::AT) {
        hide.push(crate::archive::AT.into());
    }
    let payload = json!({ "url": url, "hide": hide, "folder": folder });
    lib.jobs.enqueue(lib, "library.savePage", url, payload).ok_or_else(|| Error::io("The save couldn’t be queued."))
}

pub fn run(lib: &Library, payload: &Value, job: &JobCtx) -> Result<()> {
    let url = payload["url"].as_str().ok_or_else(|| Error::invalid("no address"))?;
    let saver = SAVER.get().ok_or_else(|| Error::io("Pages can only be saved while the app’s window is open."))?;
    job.progress(None, Some("Loading the page"));
    let page = saver.save(url, TIMEOUT, job.cancelled())?;
    job.check_cancelled()?;
    // A page that ended anywhere but on the web (about:blank, an error page of the browser…)
    // wasn't loaded: never kept, and never matched to another item.
    if !is_web_address(&page.final_url) {
        return Err(Error::io(format!("The page didn’t load (it ended at {}).", page.final_url)));
    }
    let checks = checks::check(&page);
    let ms = now_ms();
    let at = iso_utc(ms).replace(':', "");
    let sha = sha256(&page.pdf);
    let snapshot =
        json!({ "at": at, "checks": checks, "final-url": page.final_url, "sha256": sha, "status": page.status });
    let text = json!({
        "checks": checks,
        "extractor": PAGE_EXTRACTOR,
        "final_url": page.final_url,
        "images": page.images,
        "language": page.language,
        "status": page.status,
        "text": page.text,
        "title": page.title,
        "version": 1,
    });
    let hide: Vec<String> =
        payload["hide"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
    job.progress(Some(0.9), Some("Storing the snapshot"));
    let stage = files::stage_dir(lib)?;
    let saved = (|| -> Result<()> {
        let snap_dir = format!("snapshots/{at}");
        files::stage_file(&stage, &format!("{snap_dir}/page.pdf"), &page.pdf)?;
        files::stage_file(&stage, &format!("{snap_dir}/text.json"), &json_bytes(&text, false))?;
        let w = lib.write();
        let existing = item_for_url(lib, url, &hide).or_else(|| item_for_url(lib, &page.final_url, &hide));
        match existing {
            Some(e) => add_snapshot(&w, e.id, &stage.join(&snap_dir), &snap_dir, snapshot, &sha),
            None => {
                let title = if page.title.trim().is_empty() { url.to_string() } else { page.title.clone() };
                let mut rec = json!({
                    "id": new_id(),
                    "kind": KIND,
                    "kind-version": 1,
                    "created": iso_utc(ms),
                    "title": title,
                    "provenance": {
                        "author": page.author,
                        "final-url": page.final_url,
                        "publication": page.publication,
                        "published": page.published,
                        "saved-at": iso_utc(ms),
                        "saved-with": saved_with("WebKit"),
                        "source": url,
                    },
                    FORMAT: "web",
                    SNAPSHOT: at,
                    SNAPSHOTS: [snapshot],
                });
                if let Some(f) = payload["folder"].as_str().and_then(|f| folders::clean_folder(f).ok()) {
                    rec[FOLDER] = json!(f);
                }
                files::stage_file(&stage, "record.json", &json_bytes(&rec, true))?;
                files::import_item(&w, &stage).map(drop)
            }
        }
    })();
    let _ = std::fs::remove_dir_all(&stage);
    saved
}

/// Moves a staged snapshot into an existing item, then lists it in `record.json`. A snapshot
/// with the same PDF already listed (the same job, run again) isn't added twice.
fn add_snapshot(
    w: &crate::store::Write,
    id: crate::util::Id,
    staged: &std::path::Path,
    rel_dir: &str,
    snapshot: Value,
    sha: &str,
) -> Result<()> {
    let e = item(w.lib, id)?;
    let mut all = e.fields.get(SNAPSHOTS).and_then(Value::as_array).cloned().unwrap_or_default();
    if all.iter().any(|s| s["sha256"] == sha) {
        return Ok(());
    }
    files::move_into_item(w, &e, staged, rel_dir)?;
    let at = snapshot["at"].as_str().unwrap_or_default().to_string();
    all.push(snapshot);
    let edits = [
        (SNAPSHOTS.to_string(), Some(FmValue::Other(Value::Array(all)))),
        (SNAPSHOT.to_string(), Some(FmValue::Str(at))),
    ];
    crate::store::record::set_fields(w, id, None, &edits).map(drop)
}
