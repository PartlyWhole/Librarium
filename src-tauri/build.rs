fn main() {
    // The icons are baked into the binary (the Dock icon in development).
    println!("cargo:rerun-if-changed=icons");
    // The one app command; only the main window may call it (capabilities/main.json).
    let attrs = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["call"]));
    tauri_build::try_build(attrs).expect("tauri build script");
}
