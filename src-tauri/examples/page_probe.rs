//! Saves web pages with the real WebKit PageSaver, in a windowless Tauri app.
//!
//! - `page_probe suite`: serves tests/fixtures/pages on a local port and runs the shared
//!   PageSaver suite (used by tests/pagesaver_real.rs).
//! - `page_probe check <worker> <url>…`: saves each page and reports whether the text and
//!   images visible in the webview appear in the PDF (the milestone 7 check on real pages).
use librarium_contracts::ports::{PageSaver, WorkerHost};
use librarium_pagesaver_webkit::WebKitPageSaver;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::Duration;

fn serve_fixtures() -> String {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/pages");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let path = req.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
            let (status, ctype, body) = if path == "factory.png" {
                (200, "image/png", std::fs::read(dir.join("../library/gradient.png")).unwrap())
            } else if let Ok(b) = std::fs::read(dir.join(&path)) {
                (200, "text/html; charset=utf-8", b)
            } else {
                (404, "text/html; charset=utf-8", std::fs::read(dir.join("not-found.html")).unwrap())
            };
            let head = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = s.write_all(head.as_bytes()).and_then(|_| s.write_all(&body));
        }
    });
    format!("http://{addr}")
}

fn words(s: &str) -> HashSet<String> {
    s.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 4).map(|w| w.to_lowercase()).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut ctx: tauri::Context<tauri::Wry> = tauri::generate_context!();
    ctx.config_mut().app.windows.clear();
    let app = tauri::Builder::default().build(ctx).expect("tauri");
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        eprintln!("probe: started with {args:?}");
        let saver = WebKitPageSaver::new(handle.clone());
        let code = match args.first().map(String::as_str) {
            Some("suite") => {
                let base = serve_fixtures();
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    librarium_testkit::suites::pagesaver::run(&saver, &base)
                }));
                // A long page is captured in slices and joined.
                let long = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let p = saver.save(&format!("{base}/long.html"), Duration::from_secs(60)).unwrap();
                    assert!(p.pdf.starts_with(b"%PDF"));
                    p.pdf.windows(10).filter(|w| w == b"/Type /Pag" || w == b"/Type/Page").count()
                }));
                println!("long page: {long:?}");
                if r.is_ok() && long.is_ok() {
                    0
                } else {
                    1
                }
            }
            Some("check") => {
                let worker = librarium_worker_process::ProcessWorkerHost::new(args[1].clone(), 2 << 30);
                let mut failed = 0;
                for url in &args[2..] {
                    match saver.save(url, Duration::from_secs(90)) {
                        Ok(p) => {
                            let tmp = std::env::temp_dir().join(format!("librarium-check-{}.pdf", std::process::id()));
                            std::fs::write(&tmp, &p.pdf).unwrap();
                            let text = worker
                                .call("pdf.text", serde_json::json!({ "path": tmp }), Duration::from_secs(60))
                                .map(|v| {
                                    v["pages"]
                                        .as_array()
                                        .map(|ps| {
                                            ps.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" ")
                                        })
                                        .unwrap_or_default()
                                })
                                .unwrap_or_default();
                            let info = worker
                                .call("pdf.info", serde_json::json!({ "path": tmp }), Duration::from_secs(60))
                                .unwrap_or_default();
                            let (seen, inpdf) = (words(&p.visible_text), words(&text));
                            let cover = if seen.is_empty() {
                                1.0
                            } else {
                                seen.intersection(&inpdf).count() as f64 / seen.len() as f64
                            };
                            let images_pdf = info["images"].as_u64().unwrap_or(0);
                            let ok = cover >= 0.9 && images_pdf as u32 >= p.images.min(1);
                            if !ok {
                                failed += 1;
                            }
                            println!("{} {url}: text {:.0}% of {} words; images visible {} / in PDF {}; {} pages; checks {:?}", if ok { "✓" } else { "✗" }, cover * 100.0, seen.len(), p.images, images_pdf, info["pages"], p.status);
                        }
                        Err(e) => {
                            failed += 1;
                            println!("✗ {url}: {}", e.message);
                        }
                    }
                }
                failed
            }
            _ => {
                eprintln!("usage: page_probe suite | check <worker> <url>…");
                2
            }
        };
        eprintln!("probe: done, code {code}");
        let _ = std::io::stdout().flush();
        handle.exit(code);
    });
    // Closing the saver's hidden windows must not end the app; only `exit(code)` does.
    app.run(|_, e| {
        if let tauri::RunEvent::ExitRequested { code: None, api, .. } = e {
            api.prevent_exit();
        }
    });
}
