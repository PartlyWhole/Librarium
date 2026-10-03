//! Used by tests/kill9.rs: opens a library with the real adapters, keeps a draft the way the
//! editor does, says "ready", and waits to be killed with SIGKILL.
fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("a folder"));
    let worker = std::path::PathBuf::from(std::env::args().nth(2).expect("the worker"));
    let app = librarium_app::compose::App::compose(worker, dir.join("support"), dir.join("logs"));
    app.api.open_library(&dir.join("lib")).unwrap();
    let w = app.api.call("notes.create", serde_json::json!({ "title": "Typed", "body": "saved text\n" })).unwrap();
    let id = w["info"]["id"].as_str().unwrap().to_string();
    let version = w["info"]["version"].as_str().unwrap().to_string();
    // The editor sends this about 300 ms after the last keystroke.
    app.api.call("drafts.put", serde_json::json!({ "id": id, "base_version": version, "base_body": "saved text\n", "body": "saved text\ntyped just before the kill\n" })).unwrap();
    println!("ready {id}");
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}
