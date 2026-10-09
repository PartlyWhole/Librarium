//! A door to the backend for a plain browser, in development builds only.
//!
//! With `LIBRARIUM_BRIDGE=<port>`, the interface served by `npm run dev` can be opened in a
//! browser at `http://localhost:1420/?bridge=<port>` and drives the real backend, so the
//! interface can be tried and tested without the app's window. It listens on 127.0.0.1 only
//! and is compiled out of release builds.
//!
//! - `POST /call` `{method, params}` → `{ok}` or `{error: {code, message}}`
//! - `GET /bytes?id=…&name=…` → an item's file
//! - `GET /file?path=…` → a file inside the open library (what `asset:` URLs serve)
//! - `GET /events` → server-sent events, named as the app's events are

use crate::app::App;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};

static LISTENERS: Mutex<Vec<TcpStream>> = Mutex::new(Vec::new());

/// Starts the bridge if `LIBRARIUM_BRIDGE` names a port.
pub fn start(app: Arc<App>) {
    let Some(port) = std::env::var("LIBRARIUM_BRIDGE").ok().and_then(|p| p.parse::<u16>().ok()) else { return };
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => return log::warn!("the development bridge couldn’t listen on {port}: {e}"),
    };
    log::info!("development bridge on http://127.0.0.1:{port}");
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = answer(&app, stream) {
                    log::debug!("bridge request failed: {e}");
                }
            });
        }
    });
}

/// Sends an event to every browser listening.
pub fn broadcast(name: &str, payload: &Value) {
    let message = format!("event: {name}\ndata: {payload}\n\n");
    LISTENERS
        .lock()
        .expect("bridge listeners")
        .retain_mut(|s| s.write_all(message.as_bytes()).and_then(|_| s.flush()).is_ok());
}

fn answer(app: &App, mut stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));
    let mut length = 0;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = header.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let query: HashMap<String, String> = query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .filter_map(|(k, v)| Some((k.to_string(), crate::reader::percent_decode(&v.replace('+', " "))?)))
        .collect();

    match (method, path) {
        ("OPTIONS", _) => respond(&mut stream, 204, "text/plain", b""),
        ("GET", "/events") => {
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: *\r\n\r\n")?;
            stream.flush()?;
            LISTENERS.lock().expect("bridge listeners").push(stream);
            Ok(())
        }
        ("POST", "/call") => {
            let request: Value = serde_json::from_slice(&body).unwrap_or_default();
            let method = request["method"].as_str().unwrap_or_default();
            let reply = match crate::commands::dispatch(app, method, request["params"].clone()) {
                Ok(v) => json!({ "ok": v }),
                Err(e) => json!({ "error": e }),
            };
            respond(&mut stream, 200, "application/json", reply.to_string().as_bytes())
        }
        ("GET", "/bytes") => {
            let file = app.library().ok().and_then(|lib| {
                let id = crate::util::parse_id(query.get("id")?)?;
                crate::library::file_path(&lib, id, query.get("name").map(String::as_str)).ok()
            });
            send_file(&mut stream, file.as_deref())
        }
        ("GET", "/file") => {
            let file =
                app.library().ok().and_then(|lib| crate::reader::inside(&lib.root, Path::new(query.get("path")?)));
            send_file(&mut stream, file.as_deref())
        }
        _ => respond(&mut stream, 404, "text/plain", b"not found"),
    }
}

fn send_file(stream: &mut TcpStream, file: Option<&Path>) -> std::io::Result<()> {
    match file.and_then(|f| Some((f, std::fs::read(f).ok()?))) {
        Some((f, bytes)) => respond(stream, 200, crate::reader::mime(f), &bytes),
        None => respond(stream, 404, "text/plain", b"not found"),
    }
}

fn respond(stream: &mut TcpStream, status: u16, kind: &str, body: &[u8]) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
