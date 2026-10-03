//! Slot definitions. A slot is a named place where modules contribute.
//!
//! Every slot is defined here, so a module can fill a slot without depending on its host.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SlotHost {
    Kernel,
    Shell,
    Feature,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SlotDef {
    pub id: String,
    pub host: SlotHost,
    pub description: String,
}

macro_rules! slots {
    ($( $konst:ident = $id:literal, $host:ident, $desc:literal; )*) => {
        $( pub const $konst: &str = $id; )*
        /// Every slot, in a fixed order.
        pub fn all() -> Vec<SlotDef> {
            vec![$( SlotDef { id: $id.into(), host: SlotHost::$host, description: $desc.into() } ),*]
        }
    };
}

slots! {
    RECORD_KINDS = "kernel.record-kinds", Kernel, "Kinds of record, with their format and folder";
    DERIVED_VIEWS = "kernel.derived-views", Kernel, "Disposable views computed from records";
    JOB_KINDS = "kernel.job-kinds", Kernel, "Kinds of background job";
    PART_USERS = "kernel.part-users", Kernel, "Who uses which part of a record (e.g. captures of a snapshot), so it isn't removed";
    IMPORTERS = "kernel.importers", Kernel, "Importers of outside files into the store";
    API_METHODS = "kernel.api-methods", Kernel, "API calls a module offers through the API";
    PAGES = "shell.pages", Shell, "Pages shown in the workspace";
    ACTIONS = "shell.actions", Shell, "User-facing commands";
    KEYS = "shell.keys", Shell, "Keyboard shortcuts bound to actions";
    MENU_ITEMS = "shell.menu-items", Shell, "Native menu items";
    SIDEBAR_SECTIONS = "shell.sidebar-sections", Shell, "Sections of the sidebar";
    SIDE_PANEL_SECTIONS = "shell.side-panel-sections", Shell, "Sections of the side panel";
    EDITOR_EXTENSIONS = "shell.editor-extensions", Shell, "CodeMirror extensions";
    READER_ENGINES = "shell.reader-engines", Shell, "One reader engine per format";
}
