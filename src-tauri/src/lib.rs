//! The composition root: the only crate that names adapters and features.
//!
//! It builds each feature with the narrow dependencies that feature uses, wires them into
//! the API, and hands Tauri one managed value: [`App`].

pub mod compose;

use compose::App;
use librarium_contracts::rpc::{RpcNotification, RpcRequest, RpcResponse};
use tauri::ipc::Channel;
use tauri::Manager;

#[tauri::command]
fn rpc(app: tauri::State<'_, App>, request: RpcRequest) -> RpcResponse {
    app.transport.handle(request)
}

#[tauri::command]
fn subscribe(app: tauri::State<'_, App>, channel: Channel<RpcNotification>) {
    app.transport.subscribe(channel);
}

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
        .setup(|app| {
            let composed = App::compose(compose::worker_binary()?);
            match composed.api.worker_ping() {
                Ok(p) => log::info!("worker {} answered (pid {}) in {} µs", p.worker_version, p.pid, p.round_trip_us),
                Err(e) => log::error!("worker did not answer: {e}"),
            }
            app.manage(composed);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc, subscribe])
        .run(tauri::generate_context!())
        .expect("error while running Librarium");
}
