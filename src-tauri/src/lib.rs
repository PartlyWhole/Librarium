//! The composition root: the only crate that names adapters and features.
//!
//! It builds each feature with the narrow dependencies that feature uses, wires them into
//! the API, and hands Tauri one managed value: [`App`].

pub mod compose;

use compose::App;
use librarium_contracts::rpc::{RpcNotification, RpcRequest, RpcResponse};
use serde_json::json;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WindowEvent};

#[tauri::command]
fn rpc(app: tauri::State<'_, App>, request: RpcRequest) -> RpcResponse {
    app.transport.handle(request)
}

/// File bytes (an item's original, for the reader), scoped to the item's folder.
#[tauri::command]
fn bytes(
    app: tauri::State<'_, App>,
    id: String,
    name: Option<String>,
) -> Result<tauri::ipc::Response, librarium_contracts::BackendError> {
    let lib = app.api.library()?;
    let id = id.parse().map_err(librarium_contracts::BackendError::invalid)?;
    let path = librarium_feature_library::file_path(&lib.store, id, name.as_deref())?;
    let b = lib.store.fs.read(&path).map_err(|e| librarium_contracts::BackendError::io(e.to_string()))?;
    Ok(tauri::ipc::Response::new(b))
}

#[tauri::command]
fn subscribe(app: tauri::State<'_, App>, channel: Channel<RpcNotification>) {
    app.transport.subscribe(channel);
}

/// Whether the app's own window may go to an address: only its own pages (the bundled app, or
/// the dev server), never the web. A link to the web is stopped and offered to the browser.
fn stays_in_app(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "about" | "data" | "blob" => true,
        "http" | "https" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "tauri.localhost")),
        _ => false,
    }
}

/// The settings key for the main window's frame.
const WINDOW_KEY: &str = "window.main";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("librarium".into()),
                }))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        // The main window never leaves the app: a link to the web is stopped, and the interface
        // asks whether to open it in the browser. (The page saver's hidden window is its own.)
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("stay-in-app")
                .on_navigation(|webview, url| {
                    if webview.label() != "main" || stays_in_app(url) {
                        return true;
                    }
                    log::info!("a link to {url} was stopped; the interface offers it to the browser");
                    if let Some(app) = webview.try_state::<App>() {
                        if matches!(url.scheme(), "http" | "https" | "mailto") {
                            app.api.link_stopped(url.as_str());
                        }
                    }
                    false
                })
                .build(),
        )
        .setup(|app| {
            std::panic::set_hook(Box::new(|info| log::error!("panic: {info}")));
            let app_support = app.path().app_data_dir()?;
            let logs = app.path().app_log_dir()?;
            let saver = Arc::new(librarium_pagesaver_webkit::WebKitPageSaver::new(app.handle().clone()));
            // Its hidden window is made now, while the app is starting in front: making one
            // later would bring the app forward in the middle of whatever the user is doing.
            saver.warm();
            let composed = App::compose_with(compose::worker_binary()?, app_support, logs, saver);
            match composed.api.worker_ping() {
                Ok(p) => log::info!("worker {} answered (pid {}) in {} µs", p.worker_version, p.pid, p.round_trip_us),
                Err(e) => log::error!("worker did not answer: {e}"),
            }
            // Restore the window's frame (per-device, saved by the backend).
            if let (Some(w), Some(f)) = (app.get_webview_window("main"), composed.api.settings_value(WINDOW_KEY)) {
                if let (Some(x), Some(y), Some(wd), Some(ht)) =
                    (f["x"].as_i64(), f["y"].as_i64(), f["width"].as_u64(), f["height"].as_u64())
                {
                    let _ = w.set_size(PhysicalSize::new(wd as u32, ht as u32));
                    let _ = w.set_position(PhysicalPosition::new(x as i32, y as i32));
                }
                if f["maximized"].as_bool() == Some(true) {
                    let _ = w.maximize();
                }
            }
            let api = composed.api.clone();
            std::thread::spawn(move || api.open_saved_library());
            app.manage(composed);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { .. } = event {
                if let (Ok(pos), Ok(size), Ok(max)) =
                    (window.outer_position(), window.inner_size(), window.is_maximized())
                {
                    let app = window.state::<App>();
                    let frame =
                        json!({ "x": pos.x, "y": pos.y, "width": size.width, "height": size.height, "maximized": max });
                    if let Err(e) = app.api.settings_set_internal(WINDOW_KEY, frame) {
                        log::warn!("could not save the window frame: {e}");
                    }
                    app.api.close_library();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![rpc, subscribe, bytes])
        .run(tauri::generate_context!())
        .expect("error while running Librarium");
}

#[cfg(test)]
mod tests {
    use super::stays_in_app;

    #[test]
    fn the_window_stays_in_the_app() {
        for ok in [
            "tauri://localhost/index.html",
            "http://localhost:1420/",
            "http://tauri.localhost/x",
            "about:blank",
            "asset://localhost/x.pdf",
        ] {
            assert!(stays_in_app(&ok.parse().unwrap()), "{ok}");
        }
        for away in [
            "https://example.org/",
            "http://localhost.evil.org/",
            "mailto:a@b.org",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(!stays_in_app(&away.parse().unwrap()), "{away}");
        }
    }
}
