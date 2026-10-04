//! TypeScript type generation. `src/generated/` is written from this list and nothing else.

use std::path::Path;
use ts_rs::{Config, TS};

macro_rules! roots {
    ($cfg:expr; $($t:ty),* $(,)?) => {{
        $( <$t as TS>::export_all($cfg).map_err(|e| e.to_string())?; )*
    }};
}

/// Writes every exported type into `dir`.
pub fn export_types(dir: &Path) -> Result<(), String> {
    let cfg = Config::new().with_out_dir(dir).with_large_int("number");
    roots!(&cfg;
        crate::Id,
        crate::error::BackendError,
        crate::error::ErrorCode,
        crate::rpc::RpcRequest,
        crate::rpc::RpcResponse,
        crate::rpc::RpcNotification,
        crate::events::Change,
        crate::slots::SlotDef,
        crate::api::AppInfo,
        crate::api::WorkerPong,
        crate::api::RecordInfo,
        crate::api::RecordText,
        crate::api::SaveResult,
        crate::api::StoreStatus,
        crate::api::LibraryStatus,
        crate::api::OpenLibraryParams,
        crate::api::IdParams,
        crate::api::ListParams,
        crate::api::CreateParams,
        crate::api::SaveParams,
        crate::api::SetFieldsParams,
        crate::api::RelocateParams,
        crate::api::Written,
        crate::api::SettingsParams,
        crate::api::FolderInfo,
        crate::api::LogParams,
        crate::api::Draft,
        crate::api::JobInfo,
        crate::api::JobsList,
        crate::api::SearchHit,
        crate::api::Backlink,
        crate::api::Unresolved,
        crate::api::CapturePart,
        crate::api::CaptureParams,
        crate::api::OrphanSidecar,
        crate::api::ExportParams,
        crate::api::StoredText,
        crate::api::FoldersList,
        crate::api::HistoryVersion,
        crate::api::DiffLine,
        crate::api::DeletedNote,
        crate::api::FolderSpace,
        crate::api::FolderPathParams,
        crate::api::FolderOrderParams,
        crate::api::FolderMoveParams,
        crate::api::FolderMoved,
        crate::api::MoveRecordsParams,
        crate::api::MoveFailure,
        crate::api::MovedRecords,
    );
    Ok(())
}
