//! Librarium's backend: app setup (plugins, the window, quitting) and the modules.

pub mod app;
pub mod archive;
pub mod bible;
pub mod boards;
pub mod captures;
pub mod commands;
pub mod daily;
pub mod dataset;
#[cfg(debug_assertions)]
pub mod devbridge;
pub mod error;
pub mod etymology;
pub mod history;
pub mod index;
pub mod jobs;
pub mod library;
pub mod links;
pub mod notes;
pub mod reader;
pub mod settings;
pub mod store;
pub mod types;
pub mod util;
pub mod websave;

use app::App;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, WindowEvent};

/// The settings key for the main window's frame.
const FRAME: &str = "window.main";
/// How long the interface has to save its work when the window closes.
const QUIT_WAIT: Duration = Duration::from_secs(3);

/// Event names are written `records.changed`; Tauri allows no dots, so they go out as
/// `records:changed`.
fn emitter(handle: tauri::AppHandle) -> store::Emit {
    Arc::new(move |name: &str, payload: Value| {
        #[cfg(debug_assertions)]
        devbridge::broadcast(&name.replace('.', ":"), &payload);
        if let Err(e) = handle.emit(&name.replace('.', ":"), payload) {
            log::warn!("the event {name} wasn’t sent: {e}");
        }
    })
}

/// Remembers the main window's frame for the next start.
fn save_frame(handle: &tauri::AppHandle) {
    let Some(w) = handle.get_webview_window("main") else { return };
    if let (Ok(pos), Ok(size), Ok(max)) = (w.outer_position(), w.inner_size(), w.is_maximized()) {
        let frame = json!({ "x": pos.x, "y": pos.y, "width": size.width, "height": size.height, "maximized": max });
        let mut v = serde_json::Map::new();
        v.insert(FRAME.into(), frame);
        if let Err(e) = handle.state::<Arc<App>>().settings.set(v) {
            log::warn!("the window frame wasn’t saved: {e}");
        }
    }
}

/// Saves the frame half a second after the window last moved or changed size.
fn save_frame_soon(handle: &tauri::AppHandle) {
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    let mine = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if GENERATION.load(Ordering::SeqCst) == mine {
            save_frame(&handle);
        }
    });
}

fn restore_frame(w: &tauri::WebviewWindow, frame: &Value) {
    if let (Some(x), Some(y), Some(width), Some(height)) =
        (frame["x"].as_i64(), frame["y"].as_i64(), frame["width"].as_u64(), frame["height"].as_u64())
    {
        let _ = w.set_size(PhysicalSize::new(width as u32, height as u32));
        let _ = w.set_position(PhysicalPosition::new(x as i32, y as i32));
    }
    if frame["maximized"].as_bool() == Some(true) {
        let _ = w.maximize();
    }
}

/// Quits once the interface has saved: the frame is remembered, the library closed cleanly.
pub fn quit(handle: &tauri::AppHandle) {
    log::info!("quitting");
    save_frame(handle);
    handle.state::<Arc<App>>().close();
    handle.exit(0);
}

/// Whether the window may go to an address: only the app's own pages, never the web.
fn stays_in_app(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "about" | "data" | "blob" => true,
        "http" | "https" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "tauri.localhost")),
        _ => false,
    }
}

/// Whether the window shows the app itself (not a page of a book, which only frames may show).
fn stays_on_page(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "tauri" | "http" | "https")
}

pub fn run() {
    reader::protocol(tauri::Builder::default())
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // The window never leaves the app: a link to the web is stopped, and the interface asks
        // whether to open it in the browser.
        .plugin({
            // The app's own page, as last loaded. Book pages (blob: URLs, in frames) must be let
            // through, and the check can't tell a frame from the window; so should the window
            // itself land on one (a link dropped on it, say), it is sent back to the app, which
            // reopens where it was.
            let home: Arc<Mutex<Option<tauri::Url>>> = Arc::default();
            tauri::plugin::Builder::<tauri::Wry, ()>::new("stay-in-app")
                .on_navigation(|webview, url| {
                    if webview.label() != "main" || stays_in_app(url) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = webview.app_handle().emit("app:openLink", json!({ "url": url.as_str() }));
                    }
                    false
                })
                .on_page_load(move |webview, payload| {
                    if webview.label() != "main" || payload.event() != PageLoadEvent::Started {
                        return;
                    }
                    let url = payload.url();
                    let mut home = home.lock().unwrap();
                    if stays_on_page(url) {
                        *home = Some(url.clone());
                    } else if let Some(home) = home.clone() {
                        log::warn!("the window left the app for a {} page; going back", url.scheme());
                        // Back finds the app as it was (WebKit keeps the page); if that fails, it
                        // is loaded afresh.
                        let _ = webview.eval("history.back()");
                        let webview = webview.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(1500));
                            if webview.url().is_ok_and(|u| !stays_on_page(&u)) {
                                let _ = webview.navigate(home);
                            }
                        });
                    }
                })
                .build()
        })
        .setup(|app| {
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                log::error!("panic: {info}");
                default_hook(info);
            }));
            // LIBRARIUM_DATA points a development run at its own settings and library.
            let data = match std::env::var_os("LIBRARIUM_DATA") {
                Some(dir) => dir.into(),
                None => app.path().app_data_dir()?,
            };
            let state = Arc::new(App::new(data, app.path().app_log_dir()?, emitter(app.handle().clone())));
            if let (Some(w), Some(frame)) = (app.get_webview_window("main"), state.settings.get(FRAME)) {
                restore_frame(&w, &frame);
            }
            #[cfg(debug_assertions)]
            devbridge::start(state.clone());
            state.open_saved_soon();
            app.manage(state);
            websave::init(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => save_frame_soon(window.app_handle()),
                // Closing the window quits, after the interface has saved (it calls `app.quit`),
                // or after a few seconds if it doesn't answer.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let handle = window.app_handle().clone();
                    let _ = handle.emit("app:quitting", Value::Null);
                    std::thread::spawn(move || {
                        std::thread::sleep(QUIT_WAIT);
                        log::warn!("the interface didn’t answer; quitting anyway");
                        quit(&handle);
                    });
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![commands::call, reader::bytes])
        .build(tauri::generate_context!())
        .expect("error while starting Librarium")
        // Quit from the Dock or at log-out exits at once: the library is closed cleanly, and
        // unsaved typing is in its draft.
        .run(|handle, event| {
            if let RunEvent::Exit = event {
                handle.state::<Arc<App>>().close();
            }
        });
}
