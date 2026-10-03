//! The WebKit PageSaver passes the shared suite on locally served fixture pages.
#[test]
fn the_webkit_page_saver_passes_the_shared_suite() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let target = root.join("target/test-worker");
    let st = std::process::Command::new(env!("CARGO"))
        .current_dir(&root)
        .args(["build", "-q", "-p", "librarium-app", "--example", "page_probe", "--target-dir"])
        .arg(&target)
        .status()
        .unwrap();
    assert!(st.success());
    let out = std::process::Command::new(target.join("debug/examples/page_probe")).arg("suite").output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{stdout}\n{stderr}");
    assert!(stdout.contains("long page: Ok("), "{stdout}");
}
