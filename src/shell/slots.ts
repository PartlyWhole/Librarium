/**
 * Interface slot definitions. Like the backend's `contracts`, this file lets a module fill a
 * slot without depending on whoever hosts it — including feature-hosted slots.
 */
import type { IconNode } from "../kit/icon";
import type { TreeNode } from "../kit/tree";
import type { RecordInfo } from "../generated/RecordInfo";
import type { LibraryStatus } from "../generated/LibraryStatus";
import type { Registry } from "../kit/registry";
import type { Signal } from "../kit/signal";
import type { Actions } from "./actions";
import type { Prefs } from "./prefs";
import type { Records } from "./records";
import type { Router } from "./router";
import type { Undo } from "./undo";
import type { EditorContribution } from "../editor/editor";
import type { ReaderEngine } from "../reader/host";

/** shell.pages */
export interface Page {
  id: string;
  title: string;
  icon: IconNode;
  /** Shown in the ribbon, in this order. */
  ribbon?: number;
  /** Opens this page; registered as an action `go.<id>`. */
  keys?: string;
  /** Renders into `host`; returns a disposer. */
  render(host: HTMLElement, params: Record<string, string>, ctx: PageContext): (() => void) | void;
}

export interface PageContext {
  shell: ShellApi;
  setTitle(title: string): void;
  setHeaderActions(nodes: Node[]): void;
}

/** shell.sidebar-sections */
export interface SidebarSection {
  id: string;
  title: string;
  /** The section's items (read inside an effect: may read signals). */
  nodes(): TreeNode[];
  emptyText: string;
  /** Things can be dropped on the section's heading. */
  drop?: import("../kit/dnd").DropTarget;
}

/** A kind kept in folders, as the feature that owns it presents it (Notes, Library). */
export interface FolderSpace {
  kind: string;
  /** The page showing one of its folders (params: `{ folder }`). */
  page: string;
  /** Its name, also the name of its top level ("Notes", "Library"). */
  title: string;
  /** What a record holds, shown under it in the sidebar (an item's captures). */
  children?(r: RecordInfo): TreeNode[];
  /** Buttons for its page's header, before "New folder". */
  headerActions?(): Node[];
  /** What its empty top level says. */
  emptyText?: string;
}

/** The folders service: a page and a sidebar tree for each kind kept in folders. */
export interface Folders {
  add(space: FolderSpace): void;
  /** Renders a space's page: one of its folders, as in Finder. */
  render(kind: string, host: HTMLElement, params: Record<string, string>, ctx: PageContext): () => void;
  /** A space's sidebar tree: its folders and records (read inside an effect). */
  tree(kind: string): TreeNode[];
  /** Drops on a space's top level (for its sidebar heading). */
  dropOnTop(kind: string): import("../kit/dnd").DropTarget;
  /** Asks for a folder, then moves the records there. */
  moveTo(rs: RecordInfo[]): Promise<void>;
}

/** shell.side-panel-sections */
export interface SidePanelSection {
  id: string;
  title: string;
  /** Whether this section has something to say about the current route. */
  applies(route: { page: string; params: Record<string, string> }): boolean;
  render(host: HTMLElement, route: { page: string; params: Record<string, string> }): (() => void) | void;
}

/** shell.settings-sections */
export interface SettingsSection {
  id: string;
  title: string;
  render(host: HTMLElement): (() => void) | void;
}

/** shell.record-actions: an entry in a record's context menu (for one record or several). */
export interface RecordAction {
  /** The menu label, given how many records it acts on. */
  label: string | ((n: number) => string);
  /** Whether it is offered for this record (with several, for every one of them). */
  applies(r: RecordInfo): boolean;
  run(rs: RecordInfo[]): void | Promise<void>;
  destructive?: boolean;
  /** With several selected, offered when it applies to some of them, and run on those. */
  partial?: boolean;
}

/** shell.record-looks: how records of a kind look in lists of files (icon, kind name). */
export interface RecordLook {
  kind: string;
  icon(r: RecordInfo): IconNode;
  /** "Note", "PDF", "Web page"… */
  kindName(r: RecordInfo): string;
  /** A short line under the name (e.g. a web page's site), if any. */
  detail?(r: RecordInfo): string;
}

/** What the shell offers features: its registries, navigation, prefs and records. */
export interface StatusBar {
  /** A calm message on the left; cleared after `ms`. */
  show(text: string, ms?: number): void;
  readonly message: Signal<string>;
  readonly right: Signal<string>;
}

export interface ShellApi {
  actions: Actions;
  pages: Registry<Page>;
  sidebar: Registry<SidebarSection>;
  sidePanel: Registry<SidePanelSection>;
  settings: Registry<SettingsSection>;
  /** Which page opens a record of a kind. */
  openers: Registry<string>;
  /** shell.hiding-fields: records with any of these fields set (e.g. archived ones) are left
   * out of lists and search unless asked for. */
  hidingFields: Registry<string>;
  /** shell.record-actions: what a record's context menu offers (Archive, Restore…). */
  recordActions: Registry<RecordAction>;
  /** shell.record-looks, by record kind. */
  looks: Registry<RecordLook>;
  /** The folder being looked at (`""`: a kind's top level), where new things of that kind go;
   * `null` when no page shows a folder. */
  here: Signal<{ kind: string; folder: string } | null>;
  /** Folders: each kind kept in folders (notes, library items) as a feature presents it. */
  folders: Folders;
  /** Opens the context menu of a record, or of several selected, at a point. */
  showRecordMenu(rs: RecordInfo | RecordInfo[], at: { x: number; y: number }): void;
  /** Opens the side panel at one of its sections (e.g. "jobs"). */
  showPanelSection(id: string): void;
  /** What can be done with these records (the context menu's entries, without Open). */
  recordActionsFor(rs: RecordInfo[]): { label: string; destructive?: boolean; run(): void }[];
  /** A feature-hosted slot by its ID (defined in slots.ts). */
  slot<T>(id: string): Registry<T>;
  router: Router;
  prefs: Prefs;
  records: Records;
  status: StatusBar;
  folder: Signal<LibraryStatus | null>;
  /** Opens a record on the page registered for its kind (with optional extra params), in the
   * active tab or a new one. */
  openRecord(id: string, params?: Record<string, string>, opts?: { newTab?: boolean }): void;
  /** The highest change sequence number the index has applied. */
  indexed: Signal<number>;
  /** shell.editor-extensions */
  editorExtensions: Registry<EditorContribution>;
  /** shell.reader-engines */
  readerEngines: Registry<ReaderEngine>;
  /** shell.embeds, by record kind */
  embeds: Registry<EmbedRenderer>;
  undo: Undo;
  /** Work to finish before the window closes (e.g. a last save). */
  beforeClose(fn: () => Promise<void>): () => void;
}

/** Feature-hosted slot, offered by Library: what an item holds, shown under it (captures). */
export const ITEM_CHILDREN = "library.item-children";
export interface ItemChildren {
  children(item: RecordInfo): TreeNode[];
}

/** Feature-hosted slot, offered by Library: tools in the reader's toolbar (e.g. capturing). */
export const READER_TOOLS = "library.reader-tools";
export interface ReaderToolContext {
  source: RecordInfo;
  /** The version of the source shown (a web page's snapshot), if any. */
  part?: string;
  view: import("../reader/host").ReaderView;
  /** The stored text anchors refer to. */
  text(): Promise<string>;
  /** A column beside the document for a tool's panel (hidden while empty). */
  aside: HTMLElement;
}
export interface ReaderTool {
  id: string;
  /** Builds the tool's controls for one open item; returns a disposer. */
  mount(toolbar: HTMLElement, ctx: ReaderToolContext): (() => void) | void;
}

/** shell.embeds: how a record embedded with `![[label|id]]` reads (in the editor and exports). */
export interface EmbedRenderer {
  kind: string;
  /** A block shown in place of the embed. */
  render(r: RecordInfo, open: (id: string, params?: Record<string, string>) => void): HTMLElement;
  /** Plain Markdown for "Export with quotations". */
  markdown(r: RecordInfo): string;
}

/** Every interface slot, for the architecture report. */
export const SHELL_SLOTS = ["shell.pages", "shell.actions", "shell.keys", "shell.menu-items", "shell.sidebar-sections", "shell.side-panel-sections", "shell.settings-sections", "shell.editor-extensions", "shell.reader-engines", "shell.openers", "shell.embeds", "shell.hiding-fields", "shell.record-actions", "shell.record-looks", READER_TOOLS, ITEM_CHILDREN] as const;
