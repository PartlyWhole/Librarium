//! Transport port: carries JSON-RPC API messages over Tauri commands and channels.
//!
//! The composition root declares the Tauri commands (they need its managed `App`) and
//! forwards to this type. Notifications go to every subscribed channel of the main window.

use librarium_contracts::rpc::{NotificationSink, RpcHandler, RpcNotification, RpcRequest, RpcResponse};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

pub struct TauriTransport {
    handler: Arc<dyn RpcHandler>,
    channels: Mutex<Vec<Channel<RpcNotification>>>,
}

impl TauriTransport {
    pub fn new(handler: Arc<dyn RpcHandler>) -> Self {
        TauriTransport { handler, channels: Mutex::new(Vec::new()) }
    }

    /// Answers one API request.
    pub fn handle(&self, request: RpcRequest) -> RpcResponse {
        self.handler.handle(request)
    }

    /// Adds a channel that receives every notification from now on.
    pub fn subscribe(&self, channel: Channel<RpcNotification>) {
        self.channels.lock().unwrap().push(channel);
    }
}

impl NotificationSink for TauriTransport {
    fn notify(&self, n: RpcNotification) {
        // A closed channel (reloaded page) fails to send and is dropped.
        self.channels.lock().unwrap().retain(|c| c.send(n.clone()).is_ok());
    }
}
