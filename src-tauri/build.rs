fn main() {
    // Only the main window gets command permissions (see capabilities/main.json).
    let attrs =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["rpc", "subscribe"]));
    tauri_build::try_build(attrs).expect("tauri build script");
}
