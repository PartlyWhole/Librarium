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

/** Feature-hosted slot, offered by Notes: groups of notes shown apart in the sidebar. */
export const NOTE_GROUPS = "notes.groups";
export interface NoteGroup {
  id: string;
  title: string;
  /** Notes this group shows (and Notes' folder tree then leaves out). */
  claims(r: RecordInfo): boolean;
  compare(a: RecordInfo, b: RecordInfo): number;
  label(r: RecordInfo): string;
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
  /** A feature-hosted slot by its ID (defined in slots.ts). */
  slot<T>(id: string): Registry<T>;
  router: Router;
  prefs: Prefs;
  records: Records;
  status: StatusBar;
  folder: Signal<LibraryStatus | null>;
  /** Opens a record on the page registered for its kind. */
  openRecord(id: string): void;
  /** shell.editor-extensions */
  editorExtensions: Registry<EditorContribution>;
  undo: Undo;
  /** Work to finish before the window closes (e.g. a last save). */
  beforeClose(fn: () => Promise<void>): () => void;
}

/** Every interface slot, for the architecture report. */
export const SHELL_SLOTS = ["shell.pages", "shell.actions", "shell.keys", "shell.menu-items", "shell.sidebar-sections", "shell.side-panel-sections", "shell.settings-sections", "shell.editor-extensions", "shell.reader-engines", "shell.openers", NOTE_GROUPS] as const;
