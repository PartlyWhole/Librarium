use librarium_api::{Api, Deps};
use librarium_contracts::rpc::{RpcHandler, RpcRequest, METHOD_NOT_FOUND};
use librarium_testkit::worker::FakeWorkerHost;
use std::sync::Arc;

fn api() -> Api {
    Api::new(Deps { worker: Arc::new(FakeWorkerHost::new()) })
}

#[test]
fn pings_the_worker() {
    assert_eq!(api().worker_ping().unwrap().worker_version, "fake");
}

#[test]
fn speaks_json_rpc() {
    let r = api().handle(RpcRequest::new(7, "app.info", serde_json::json!(null)));
    assert_eq!(r.id, 7);
    assert_eq!(r.result.unwrap()["name"], "Librarium");
    let r = api().handle(RpcRequest::new(8, "nope", serde_json::json!(null)));
    let e = r.error.unwrap();
    assert_eq!(e.code, METHOD_NOT_FOUND);
    assert_eq!(e.data.unwrap().code, librarium_contracts::ErrorCode::NotFound);
}
