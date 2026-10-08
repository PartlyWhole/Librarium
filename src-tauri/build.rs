fn main() {
    // The icons are baked into the binary (the Dock icon in development), so rebuild when they change.
    println!("cargo:rerun-if-changed=icons");
    // Only the main window gets command permissions (see capabilities/main.json).
    let attrs = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "rpc",
        "subscribe",
        "bytes",
        "restart",
        "quit",
    ]));
    tauri_build::try_build(attrs).expect("tauri build script");
}
