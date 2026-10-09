//! The reader's access to the open library's files.
//!
//! - `bytes`: an item's file through IPC, as raw bytes (how the PDF and EPUB readers load
//!   originals and snapshot PDFs).
//! - `asset:` URLs (`convertFileSrc`): files inside the open library folder, for pictures and
//!   region PNGs. Served only to the main window, never dot-entries, and nothing at all once
//!   the library is closed: the check is made against the open library on every request.

use crate::app::App;
use crate::error::{Context, Error, Result};
use crate::util::parse_id;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::http::{header, Request, Response, StatusCode};

/// An item's original (`name` absent) or a file in its folder (`snapshots/<at>/page.pdf`).
#[tauri::command]
pub async fn bytes(app: tauri::State<'_, Arc<App>>, id: String, name: Option<String>) -> Result<tauri::ipc::Response> {
    let app = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lib = app.library()?;
        let id = parse_id(&id).ok_or_else(|| Error::invalid("not an ID"))?;
        let path = crate::library::file_path(&lib, id, name.as_deref())?;
        Ok(tauri::ipc::Response::new(std::fs::read(path).ctx("reading the file")?))
    })
    .await
    .map_err(|e| Error::io(format!("the read stopped: {e}")))?
}

/// Registers the `asset:` protocol on the app.
pub fn protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol("asset", |ctx, request, responder| {
        if ctx.webview_label() != "main" {
            return responder.respond(status(StatusCode::FORBIDDEN));
        }
        let Some(app) = tauri::Manager::try_state::<Arc<App>>(ctx.app_handle()).map(|s| s.inner().clone()) else {
            return responder.respond(status(StatusCode::SERVICE_UNAVAILABLE));
        };
        std::thread::spawn(move || responder.respond(serve(&app, &request)));
    })
}

fn status(s: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(s).body(vec![]).expect("a plain response")
}

/// `asset://localhost/<percent-encoded absolute path>`
fn serve(app: &App, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(path) = percent_decode(request.uri().path().trim_start_matches('/')) else {
        return status(StatusCode::BAD_REQUEST);
    };
    let Some(file) = app.library().ok().and_then(|lib| inside(&lib.root, Path::new(&path))) else {
        return status(StatusCode::FORBIDDEN);
    };
    let Ok(body) = std::fs::read(&file) else { return status(StatusCode::NOT_FOUND) };
    let origin = request.headers().get(header::ORIGIN).and_then(|o| o.to_str().ok()).unwrap_or("*").to_string();
    Response::builder()
        .header(header::CONTENT_TYPE, mime(&file))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .body(body)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

/// The file, if it is inside the library folder (links resolved) and no part of its path
/// inside starts with a dot.
fn inside(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let file = path.canonicalize().ok().filter(|f| f.is_file())?;
    let rel = file.strip_prefix(&root).ok()?;
    let hidden = rel.components().any(|c| !matches!(c, Component::Normal(n) if !n.to_string_lossy().starts_with('.')));
    (!hidden).then_some(file)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn mime(p: &Path) -> &'static str {
    match p.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("pdf") => "application/pdf",
        Some("epub") => "application/epub+zip",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic") => "image/heic",
        Some("tif" | "tiff") => "image/tiff",
        Some("svg") => "image/svg+xml",
        Some("json" | "excalidraw") => "application/json",
        _ => "application/octet-stream",
    }
}
