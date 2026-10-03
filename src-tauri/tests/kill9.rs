//! Words typed up to a moment before `kill -9` are there after reopening (§8, milestone 3).
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn a_draft_survives_kill_9() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let target = root.join("target/test-worker");
    let st = Command::new(env!("CARGO"))
        .current_dir(&root)
        .args(["build", "-q", "-p", "librarium-app", "--example", "draft_probe", "--target-dir"])
        .arg(&target)
        .status()
        .unwrap();
    assert!(st.success());
    let worker = librarium_testkit::binaries::worker_binary();
    let dir = std::env::temp_dir().join(format!("librarium-kill9-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("lib")).unwrap();

    let mut child = Command::new(target.join("debug/examples/draft_probe"))
        .arg(&dir)
        .arg(&worker)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert!(line.starts_with("ready "), "{line}");
    // SIGKILL: no cleanup runs.
    unsafe { libc_kill(child.id() as i32, 9) };
    child.wait().unwrap();

    let app = librarium_app::compose::App::compose(worker, dir.join("support"), dir.join("logs"));
    app.api.open_library(&dir.join("lib")).unwrap();
    assert_eq!(app.api.library().unwrap().startup.reason.as_deref(), Some("the app did not close cleanly"));
    let drafts = app.api.drafts_list().unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].body, "saved text\ntyped just before the kill\n");
    app.api.close_library();
    let _ = std::fs::remove_dir_all(&dir);
}

extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}
