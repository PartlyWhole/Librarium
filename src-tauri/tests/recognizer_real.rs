//! The Vision recognizer (in the real worker) passes the shared TextRecognizer suite.
#[test]
fn vision_passes_the_shared_suite() {
    let worker = std::sync::Arc::new(librarium_worker_process::ProcessWorkerHost::new(
        librarium_testkit::binaries::worker_binary(),
        2 << 30,
    ));
    librarium_testkit::suites::recognizer::run(&librarium_recognizer_vision::VisionRecognizer::new(worker));
}
