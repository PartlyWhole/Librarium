/**
 * Excalidraw, mounted for a board: the only place React is used, loaded (with this module) the
 * first time a board is opened or drawn in a note. The page talks to it through `BoardEngine`.
 */
import { createElement, Fragment, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { CaptureUpdateAction, convertToExcalidrawElements, Excalidraw, FONT_FAMILY, reconcileElements, sceneCoordsToViewportCoords, Sidebar, exportToBlob, exportToSvg, getSceneVersion, restore, restoreElements, serializeAsJSON, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { passThrough } from "../ui/keys";
import { boxText, hasRefs, isTextBox, RECORD_LINK, recordOf, TEXT_BOX, UUID, wordsAndLinks, type BoardElement, type BoardLink } from "./links";

type Api = Parameters<NonNullable<Parameters<typeof Excalidraw>[0]["excalidrawAPI"]>>[0];
type AppState = ReturnType<Api["getAppState"]>;

/** A picture's data and size. */
export interface Picture {
  dataURL: string;
  mimeType: string;
  width: number;
  height: number;
}

interface EngineOptions {
  /** The drawing, in Excalidraw's file format. */
  scene: string;
  theme: "light" | "dark";
  readOnly: boolean;
  /** The drawing changed (not by `load`, undo or redo). */
  onChange(): void;
  /** A step Excalidraw's own undo would undo: a shape drawn or moved, a text typed… */
  onStep(): void;
  /** Pictures pasted: the page makes them library items, then inserts them. */
  onFiles(files: File[]): void;
  /** Draws a record's card into `host`; returns how to stop. */
  renderCard(id: string, host: HTMLElement): () => void;
  /** Draws a text box's editor into `host`, written in as a note is. */
  renderTextBox(host: HTMLElement, box: TextBoxHost): TextBoxView;
  /** A picture's data (a library item, by ID). */
  imageOf(id: string): Promise<Picture | null>;
  /** A link was asked for in a text being written (this element), at `at` in its words: by
   * typing `[[` (just before `at`), or by its Link button. The page offers what to link to. */
  onLinkStart(elementId: string, at: number, typed: boolean): void;
  /** A link on the board was clicked (with ⌘: in a new tab); `links` when it holds several. */
  onOpenLink(link: string, newTab: boolean, more: { links: BoardLink[]; at: { x: number; y: number } }): void;
  /** Text pasted onto the drawing that holds links or embeds (`[[…]]`, `![[…]]`). */
  onPasteLinks(text: string, at: { x: number; y: number } | undefined): void;
  /** The page's own buttons at the canvas's top right (shown on read-only boards too). */
  buttons?(host: HTMLElement): void;
  /** A panel of the page's own beside the drawing, opened by a button at the canvas's top right. */
  sidebar?: {
    title: string;
    icon(): Element;
    /** Draws the panel into `host`; returns how to stop. */
    render(host: HTMLElement): () => void;
    docked: boolean;
    onDock(docked: boolean): void;
  };
}

/** What a text box's editor is given: its Markdown, and where its changes go. */
export interface TextBoxHost {
  text: string;
  readOnly: boolean;
  /** The words changed (kept, not yet a step to undo). */
  changed(text: string): void;
  /** Writing ended (the editor was left): a step to undo, if anything changed. */
  done(): void;
}

export interface TextBoxView {
  /** Puts the cursor in it: at a point on screen, or where it was. */
  focus(at?: { x: number; y: number }): void;
  /** Shows other words (undo, redo, or a drawing changed elsewhere). */
  set(text: string): void;
  hasFocus(): boolean;
  stop(): void;
}

/** A record to put on the board, or words with links in them. */
export type BoardInsert =
  | {
      id: string;
      label: string;
      picture: boolean;
      /** Written `![[…]]` in the readable page (a capture's quotation, a picture). */
      embed: boolean;
    }
  | { words: string; links: BoardLink[] };

export interface BoardEngine {
  /** The element holding the canvas (keys and focus). */
  readonly el: HTMLElement;
  /** The drawing now, in Excalidraw's file format, and its elements. */
  current(): { scene: string; elements: readonly BoardElement[] };
  /** Shows another drawing (changed elsewhere), not as a step to undo. */
  load(scene: string): void;
  /** Puts records on the board as one step: at a point on screen, or in the middle. */
  insert(items: BoardInsert[], at?: { x: number; y: number }): Promise<void>;
  /** The IDs of the elements selected. */
  selected(): string[];
  /** Whether Escape has something to do on the board first: a tool to leave, text or a line
   * being made, a menu or dialog open. (It doesn't let go of a selection.) */
  busy(): boolean;
  /**
   * Links elements to a record (one step); a shape's text links its shape. In a text, the
   * record's name goes in at `at` (in place of the `[[` typed just before it, if `typed`). An
   * element keeps each of its links; a click on one with several offers them all.
   */
  link(ids: string[], to: BoardLink, opts?: { at?: number; typed?: boolean }): boolean;
  /** Takes back a `[[` typed just before `at` in a text (the link wasn't chosen). */
  untype(id: string, at: number): void;
  /** A new text box in the middle of what is in view, ready to write in. */
  addTextBox(): void;
  /** Excalidraw's own undo and redo. */
  undo(): boolean;
  redo(): boolean;
  setTheme(theme: "light" | "dark"): void;
  /**
   * Takes in a shared board's elements (each kept here when this one is newer, as Excalidraw's
   * collaboration does) and its text boxes' Markdown, not as a step to undo. Returns whether the
   * drawing changed.
   */
  applyRemote(elements: readonly unknown[], boxes: Record<string, string>): boolean;
  /** Colleagues' pointers and names, by who they are. */
  setPeers(peers: Map<string, Peer>): void;
  /** The board is shared (or no longer is). */
  setShared(on: boolean): void;
  /** Tells `to` where the pointer is on the drawing (in its coordinates), and when it is pressed
   * or let go; `undefined` stops. */
  followPointer(to: ((p: { x: number; y: number; button: "down" | "up"; tool: PointerTool }) => void) | undefined): void;
  destroy(): void;
}

/** Excalidraw's pointer, or its laser (a trail colleagues see while the button is down). */
export type PointerTool = "pointer" | "laser";

/** A colleague on a shared board: where their pointer is, which tool it is, and who they are. */
export interface Peer {
  x: number;
  y: number;
  button: "down" | "up";
  tool: PointerTool;
  name: string;
  color: string;
}

/** The page's own DOM, held by React where Excalidraw puts it (a card, the sidebar, its button's icon). */
function Host(props: { render: (host: HTMLElement) => (() => void) | void; className: string; tag?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => props.render(ref.current!) ?? undefined, [props.render]);
  return createElement(props.tag ?? "div", { ref, className: props.className });
}

const SIDEBAR = "librarium";

/** A gesture in progress: its step is counted when it ends. */
const busy = (s: AppState) =>
  !!(s.newElement || s.resizingElement || s.multiElement || s.editingTextElement || s.isResizing || s.isRotating || s.selectedElementsAreBeingDragged || s.editingLinearElement);

function parse(scene: string) {
  try {
    return restore(JSON.parse(scene) as Parameters<typeof restore>[0], null, null);
  } catch {
    return restore(null, null, null);
  }
}

const cardId = () => `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type Drawn = BoardElement & { version: number };
const linksOf = (e: { customData?: unknown } | undefined): BoardLink[] => (e?.customData as BoardElement["customData"])?.librarium?.links ?? [];
const touched = (e: { version: number }) => ({ version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() });
/** An element with these links, Excalidraw's own link following the first. */
function withLinks<E extends Drawn>(e: E, links: BoardLink[]): E {
  const mine = e.customData?.librarium;
  return { ...e, ...touched(e), link: links[0] ? `${RECORD_LINK}${links[0].id}` : recordOf(e.link) ? null : e.link, customData: { ...(e.customData ?? {}), librarium: { ...(mine ?? {}), links } } };
}

/**
 * Words with a name put in at `at`: in place of a `[[` typed just before it (or the last `[[`,
 * if the words changed since), else at `at`, else at the end; spaced from the words beside it.
 */
function putName(words: string, name: string, at: number | undefined, typed: boolean): string {
  let to = Math.min(at ?? words.length, words.length);
  let from = to;
  if (typed) {
    if (words.slice(to - 2, to) === "[[") from = to - 2;
    else if (words.includes("[[")) [from, to] = [words.lastIndexOf("[["), words.lastIndexOf("[[") + 2];
  }
  // A space either side where it would run into a word.
  const before = /[\p{L}\p{N}]$/u.test(words.slice(0, from)) ? " " : "";
  const after = /^[\p{L}\p{N}]/u.test(words.slice(to)) ? " " : "";
  return words.slice(0, from) + before + name + after + words.slice(to);
}

export function mountBoard(host: HTMLElement, o: EngineOptions): Promise<BoardEngine> {
  const el = document.createElement("div");
  el.className = "board-canvas";
  host.appendChild(el);
  const root = createRoot(el);
  let api: Api | null = null;
  let theme = o.theme;
  const initial = parse(o.scene);
  // Changes that aren't new steps: undo and redo (saved, not counted), and a drawing loaded
  // from disk (neither).
  let quietUntil = 0;
  let quiet: "replay" | "load" = "replay";
  let version = getSceneVersion(initial.elements);
  let stepPending = false;
  /** Whether the board is shared (its text boxes' words are then no steps to undo). */
  let shared = false;
  /** Who is told where the pointer is (a shared board). */
  let pointerTo: ((p: { x: number; y: number; button: "down" | "up"; tool: PointerTool }) => void) | undefined;

  const onChange = (elements: Parameters<typeof getSceneVersion>[0], state: AppState) => {
    keepLinks(state);
    placeChip();
    drawNames(state);
    syncBoxes(state);
    if (wanted.size && !busy(state)) queueMicrotask(fit);
    const v = getSceneVersion(elements);
    if (performance.now() < quietUntil) {
      if (v !== version && quiet === "replay") o.onChange();
      version = v;
      return;
    }
    if (v !== version) {
      version = v;
      stepPending = true;
      o.onChange();
    }
    if (stepPending && !busy(state)) {
      stepPending = false;
      o.onStep();
    }
  };

  const render = () =>
    root.render(
      createElement(Excalidraw, {
        initialData: { elements: initial.elements, appState: { ...initial.appState, viewModeEnabled: o.readOnly }, files: initial.files },
        excalidrawAPI: (a: Api) => void (api = a),
        theme,
        viewModeEnabled: o.readOnly,
        aiEnabled: false,
        onChange,
        onPointerUpdate: (p: { pointer: { x: number; y: number; tool: PointerTool }; button: "down" | "up" }) => pointerTo?.({ x: p.pointer.x, y: p.pointer.y, button: p.button, tool: p.pointer.tool }),
        onLinkOpen: (element: { id: string; link: string | null; customData?: unknown }, event: CustomEvent<{ nativeEvent: MouseEvent | { metaKey?: boolean; clientX?: number; clientY?: number } }>) => {
          if (!element.link) return;
          event.preventDefault();
          // A text box's corner button writes in it.
          if (element.link === TEXT_BOX) return writeInBox(element.id);
          const n = event.detail?.nativeEvent;
          o.onOpenLink(element.link, !!n?.metaKey, { links: linksOf(element), at: { x: n?.clientX ?? 0, y: n?.clientY ?? 0 } });
        },
        // Saving, opening, exporting and pictures go through Librarium. Sidebars can dock beside
        // the drawing on any window wider than a phone.
        UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false }, tools: { image: false }, dockedSidebarBreakpoint: 700 },
        onPaste: (data: { files?: object; elements?: readonly { type: string }[] | null; text?: string }, event: ClipboardEvent | null) => {
          const files = [...(event?.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (files.length) {
            o.onFiles(files);
            return false;
          }
          // Links and embeds copied from a note or the Library become linked words and cards.
          const text = data.text ?? event?.clipboardData?.getData("text/plain") ?? "";
          if (!data.elements?.length && hasRefs(text)) {
            o.onPasteLinks(text, pointer);
            return false;
          }
          // Pictures copied from another board come back by their IDs (their data isn't copied).
          return !(Object.keys(data.files ?? {}).length > 0 && !data.elements?.length);
        },
        // Cards are Librarium's records only (no web pages, videos or posts), and text boxes.
        validateEmbeddable: (link: string) => recordOf(link) !== null || link === TEXT_BOX,
        renderEmbeddable: (element: { id: string; link: string | null }) => {
          if (element.link === TEXT_BOX) return createElement(Host, { key: element.id, render: boxRender(element.id), className: "board-text-host" });
          const id = recordOf(element.link);
          return id ? createElement(Host, { key: element.id, render: cardRender(element.id, id), className: "board-card-host" }) : null;
        },
        renderTopRightUI: () =>
          createElement(Fragment, null,
            o.buttons ? createElement(Host, { render: o.buttons, className: "board-buttons" }) : null,
            side ? createElement(Sidebar.Trigger, { name: SIDEBAR, title: side.title, icon: createElement(Host, { render: sideIcon, className: "board-sidebar-icon", tag: "span" }) }) : null),
      },
      side ? createElement(Sidebar, { name: SIDEBAR, docked, onDock: (d: boolean) => ((docked = d), side.onDock(d), render()), className: "board-sidebar", children: [createElement(Sidebar.Header, { key: "head" }, side.title), createElement(Host, { key: "body", render: side.render, className: "board-sidebar-body" })] }) : null),
    );
  // The same functions each time, so React keeps what they drew.
  const cards = new Map<string, (host: HTMLElement) => () => void>();
  const cardRender = (elementId: string, id: string) => cards.get(elementId) ?? cards.set(elementId, (host) => fitted(elementId, host, (inner) => o.renderCard(id, inner))).get(elementId)!;

  // ---- Text boxes: written in as a note is, with links and embeds ----
  /** Each box shown: its editor, and the words it last had. */
  const boxes = new Map<string, { view: TextBoxView; text: string; dirty: boolean; host: HTMLElement }>();
  /** A box just made, to write in as soon as it is shown. */
  let writeIn: string | null = null;
  const boxRender = (elementId: string) =>
    cards.get(elementId) ??
    cards.set(elementId, (host) =>
      fitted(elementId, host, (inner) => {
        const e = api?.getSceneElementsIncludingDeleted().find((x) => x.id === elementId);
        const box = { view: null as unknown as TextBoxView, text: e ? boxText(e) : "", dirty: false, host: inner };
        box.view = o.renderTextBox(inner, {
          text: box.text,
          readOnly: o.readOnly,
          changed: (text) => ((box.text = text), (box.dirty = true), setBoxText(elementId, text, false)),
          done: () => {
            if (box.dirty || !box.text.trim()) setBoxText(elementId, box.text, true);
            box.dirty = false;
          },
        });
        boxes.set(elementId, box);
        // Keys and the clipboard are the editor's while it is written in, not the drawing's;
        // Escape leaves it, the box selected.
        const own = (ev: Event) => ev.stopPropagation();
        const keys = (ev: KeyboardEvent) => {
          if (ev.key === "Escape" && !ev.defaultPrevented) {
            (document.activeElement as HTMLElement | null)?.blur();
            api?.updateScene({ appState: { activeEmbeddable: null, selectedElementIds: { [elementId]: true } } as never });
          }
          ev.stopPropagation();
        };
        inner.addEventListener("keydown", keys);
        for (const t of ["keyup", "paste", "copy", "cut"]) inner.addEventListener(t, own);
        if (writeIn === elementId) ((writeIn = null), requestAnimationFrame(() => box.view.focus()));
        return () => {
          boxes.delete(elementId);
          box.view.stop();
        };
      }),
    ).get(elementId)!;
  /** Writes in a box (as Excalidraw does for a text: a double-click, or Enter when it is selected). */
  function writeInBox(id: string, at?: { x: number; y: number }) {
    const e = api?.getSceneElements().find((x) => x.id === id);
    const box = boxes.get(id);
    if (!api || !e || !box || o.readOnly) return;
    api.updateScene({ appState: { activeEmbeddable: { element: e, state: "active" }, selectedElementIds: { [id]: true } } as never });
    requestAnimationFrame(() => box.view.focus(at));
  }
  const boxAt = (x: number, y: number) =>
    [...boxes].find(([, b]) => {
      const r = b.host.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    })?.[0];
  el.addEventListener("dblclick", (ev) => {
    const id = boxAt(ev.clientX, ev.clientY);
    if (!id) return;
    ev.stopPropagation();
    writeInBox(id, { x: ev.clientX, y: ev.clientY });
  }, true);
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.metaKey || ev.altKey || !api || (ev.target as HTMLElement).closest(".board-text-box, textarea, input")) return;
    const sel = Object.keys(api.getAppState().selectedElementIds);
    if (sel.length !== 1 || !boxes.has(sel[0]!)) return;
    ev.preventDefault();
    ev.stopPropagation();
    writeInBox(sel[0]!);
  }, true);

  /** A box's words into the drawing: kept while writing (saved, not yet a step), then a step
   * when writing ends. A box left empty goes. */
  function setBoxText(id: string, text: string, commit: boolean) {
    if (!api) return;
    const all = api.getSceneElementsIncludingDeleted();
    if (!all.some((e) => e.id === id && !e.isDeleted)) return;
    const gone = commit && !text.trim();
    const next = all.map((e) => (e.id !== id ? e : gone ? { ...e, ...touched(e), isDeleted: true } : { ...e, ...touched(e), customData: { ...(e.customData ?? {}), librarium: { ...((e.customData as BoardElement["customData"])?.librarium ?? {}), text } } }));
    // On a shared board a box's words are no step to undo: undoing one would put back its whole
    // earlier text over colleagues' words. Its editor undoes what was typed in it.
    const unrecorded = shared && !gone;
    if (!commit || unrecorded) {
      quiet = "replay";
      quietUntil = performance.now() + 50;
    }
    api.updateScene({ elements: next as never, captureUpdate: unrecorded ? CaptureUpdateAction.NEVER : commit ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.EVENTUALLY });
  }
  /** Boxes show their words as the drawing has them (after undo, redo or a load), and the box
   * made active (selected, then clicked) is written in. */
  function syncBoxes(state: AppState) {
    if (!api || !boxes.size) return;
    for (const e of api.getSceneElements()) {
      const box = boxes.get(e.id);
      if (!box || box.view.hasFocus()) continue;
      const text = boxText(e);
      if (text !== box.text) ((box.text = text), box.view.set(text));
    }
    const active = state.activeEmbeddable;
    if (active?.state === "active") {
      const box = boxes.get(active.element.id);
      if (box && !box.view.hasFocus()) box.view.focus();
    }
  }

  // ---- Cards are as tall as what they show (no empty space, nothing to scroll) ----
  /** Heights wanted, by element, kept while a card is being resized or the drawing is busy. */
  const wanted = new Map<string, number>();
  /** Draws into `host` through a box whose height the card's element follows. */
  const fitted = (elementId: string, host: HTMLElement, render: (inner: HTMLElement) => () => void): (() => void) => {
    const inner = document.createElement("div");
    inner.className = "board-fit";
    host.appendChild(inner);
    const stop = render(inner);
    const watch = new ResizeObserver(() => {
      if (!inner.offsetHeight) return;
      wanted.set(elementId, inner.offsetHeight);
      fit();
    });
    watch.observe(inner);
    return () => {
      watch.disconnect();
      stop();
      inner.remove();
    };
  };
  /** Gives cards their wanted heights (with Excalidraw's padding of the stroke width each side),
   * saved but not a step to undo. */
  function fit() {
    if (!api || !wanted.size || busy(api.getAppState())) return;
    const all = api.getSceneElementsIncludingDeleted();
    const next = all.map((e) => {
      const h = wanted.get(e.id);
      if (h === undefined) return e;
      const height = Math.ceil(h + 2 * e.strokeWidth);
      return Math.abs(e.height - height) > 1 ? { ...e, height, ...touched(e) } : e;
    });
    wanted.clear();
    if (next.every((e, i) => e === all[i])) return;
    quiet = "replay";
    quietUntil = performance.now() + 50;
    api.updateScene({ elements: next as never, captureUpdate: CaptureUpdateAction.NEVER });
  }
  const side = o.readOnly ? undefined : o.sidebar;
  const sideIcon = (host: HTMLElement) => void host.append(side!.icon());
  let docked = side?.docked ?? false;
  render();

  // Undo and redo are Excalidraw's own, reached by its key (it has no call for them). It
  // applies them a moment later; the change that follows is saved but isn't a new step.
  const key = (shift: boolean) => {
    if (!api) return false;
    quiet = "replay";
    quietUntil = performance.now() + 250;
    const target = el.querySelector(".excalidraw") ?? el;
    target.dispatchEvent(passThrough(new KeyboardEvent("keydown", { key: shift ? "Z" : "z", code: "KeyZ", metaKey: true, shiftKey: shift, bubbles: true, cancelable: true })));
    return true;
  };

  // ---- Links in a text being written ----
  /** The text being written, and its box. */
  const writing = () => {
    const ta = el.querySelector<HTMLTextAreaElement>("textarea.excalidraw-wysiwyg");
    const editing = api?.getAppState().editingTextElement;
    return ta && editing ? { ta, id: editing.id } : null;
  };
  /** The page asks what to link to, at the caret; the text is finished first (so it can be linked). */
  const startLink = (typed: boolean) => {
    const w = writing();
    if (!w) return;
    const at = w.ta.selectionEnd ?? w.ta.value.length;
    w.ta.blur();
    setTimeout(() => o.onLinkStart(w.id, at, typed), 0);
  };
  el.addEventListener("input", (e) => {
    const ta = e.target as HTMLTextAreaElement;
    if (!ta.classList?.contains("excalidraw-wysiwyg")) return;
    const at = ta.selectionStart ?? ta.value.length;
    if (ta.value.slice(Math.max(0, at - 2), at) === "[[") startLink(true);
    else placeChip();
  }, true);
  // Excalidraw takes keys as tool shortcuts unless they're typed into a text, number or password
  // field; the sidebar's search fields are `search`, so their keys stop here.
  el.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest?.("input[type=search]") && e.key !== "Escape") e.stopPropagation();
  });

  // Under a text being written, a Link button does what `[[` does, and says so.
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "board-link-chip";
  chip.hidden = true;
  chip.title = "Link these words to a note, item or capture (or type [[)";
  chip.append("Link…", Object.assign(document.createElement("kbd"), { textContent: "[[" }));
  // Pressed without taking the caret from the text, so the link goes where it was.
  chip.addEventListener("mousedown", (e) => (e.preventDefault(), startLink(false)));
  host.appendChild(chip);
  function placeChip() {
    const w = writing();
    chip.hidden = !w;
    if (!w) return;
    const r = w.ta.getBoundingClientRect();
    const b = host.getBoundingClientRect();
    chip.style.left = `${Math.max(4, r.left - b.left)}px`;
    chip.style.top = `${r.bottom - b.top + 6}px`;
  }

  /**
   * A text's links follow its words as they are written: a link whose name is taken out goes
   * (as part of the same step), one pasted in comes. Links on a text that never had their
   * names in it (a text linked as a whole) stay.
   */
  let written: { id: string; words: string; links: BoardLink[]; pasted: BoardLink[] } | null = null;
  /** Where a text's links are kept: on its shape, if it is a shape's (as Excalidraw follows them). */
  const holderOf = (t: Drawn, all: readonly Drawn[]) => {
    const shape = t.containerId ? all.find((e) => e.id === t.containerId && !e.isDeleted) : undefined;
    return shape && !linksOf(t).length ? shape : t;
  };
  function keepLinks(state: AppState) {
    const id = state.editingTextElement?.id;
    if (!id || !api) return void (written = null);
    const all = api.getSceneElementsIncludingDeleted() as unknown as readonly Drawn[];
    const t = all.find((e) => e.id === id);
    if (!t) return;
    const holder = holderOf(t, all);
    const now = t.originalText ?? t.text ?? "";
    if (written?.id !== id) written = { id, words: now, links: linksOf(holder), pasted: [] };
    const w = written;
    const keep = [...w.links.filter((l) => !w.words.includes(l.label) || now.includes(l.label)), ...w.pasted.filter((l) => now.includes(l.label))]
      .filter((l, i, ls) => ls.findIndex((x) => x.id === l.id) === i);
    const have = linksOf(holder);
    if (keep.length === have.length && keep.every((l, i) => l.id === have[i]!.id && l.label === have[i]!.label)) return;
    api.updateScene({ elements: all.map((e) => (e.id === holder.id ? withLinks(e, keep) : e)) as never, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  }
  // Links pasted into a text being written go in as their names, linked.
  el.addEventListener("paste", (e) => {
    const ta = e.target as HTMLTextAreaElement;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!ta.classList?.contains("excalidraw-wysiwyg") || !written || !hasRefs(text)) return;
    e.preventDefault();
    const { words, links } = wordsAndLinks(text);
    written.pasted.push(...links);
    document.execCommand("insertText", false, words);
  }, true);

  // Excalidraw's link icon (see vite.config.ts) is left off what opens its links itself: cards,
  // text boxes, and texts and the shapes holding them (their names are underlined). A picture
  // or a shape without words keeps it.
  (globalThis as { librariumLinkIcon?: (e: Drawn & { boundElements?: readonly { type: string }[] | null }) => boolean }).librariumLinkIcon = (e) =>
    !recordOf(e.link) && e.link !== TEXT_BOX ? true : !(e.type === "embeddable" || e.type === "text" || !!e.boundElements?.some((x) => x.type === "text"));

  // ---- Linked names in texts, underlined over them: a click on one opens it, as in a note ----
  const names = document.createElement("div");
  names.className = "board-names";
  host.appendChild(names);
  const measure = document.createElement("canvas").getContext("2d")!;
  const fontName = (id: number) => Object.entries(FONT_FAMILY).find(([, n]) => n === id)?.[0] ?? "Excalifont";
  /** Where each linked name is, on screen, and its records (several: a text linked as a whole). */
  let shown: { links: BoardLink[]; box: DOMRect }[] = [];
  function drawNames(state: AppState) {
    if (!api) return;
    const all = api.getSceneElements() as unknown as readonly (Drawn & { width: number; height: number; angle: number; fontSize: number; fontFamily: number; lineHeight: number; textAlign: string })[];
    const b = host.getBoundingClientRect();
    const zoom = state.zoom.value;
    const out: HTMLElement[] = [];
    const spans: { links: BoardLink[]; el: HTMLElement }[] = [];
    // A card or box drawn over a text hides its names (they are drawn above everything).
    const covered = (t: (typeof all)[number], i: number) =>
      all.slice(i + 1).some((c) => c.type === "embeddable" && c.x < t.x + t.width && c.x + c.width > t.x && c.y < t.y + t.height && c.y + c.height > t.y);
    for (const [i, t] of all.entries()) {
      if (t.type !== "text" || t.id === state.editingTextElement?.id || !t.text || covered(t, i)) continue;
      const links = linksOf(holderOf(t, all));
      if (!links.length) continue;
      measure.font = `${t.fontSize}px ${fontName(t.fontFamily)}`;
      const lines = t.text.split("\n");
      const lineH = t.fontSize * t.lineHeight;
      const at = sceneCoordsToViewportCoords({ sceneX: t.x, sceneY: t.y }, state);
      const frame = document.createElement("div");
      frame.className = "board-names-frame";
      Object.assign(frame.style, { left: `${at.x - b.left}px`, top: `${at.y - b.top}px`, width: `${t.width * zoom}px`, height: `${t.height * zoom}px`, transform: t.angle ? `rotate(${t.angle}rad)` : "" });
      /** Underlines [start, end) of the words (as one line, wrapped lines joined by a space). */
      const underline = (start: number, end: number, to: BoardLink[]) => {
        let lineStart = 0;
        lines.forEach((line, n) => {
          const lineEnd = lineStart + line.length;
          const from = Math.max(start, lineStart);
          const upTo = Math.min(end, lineEnd);
          if (from < upTo) {
            const width = measure.measureText(line).width;
            const left = t.textAlign === "center" ? (t.width - width) / 2 : t.textAlign === "right" ? t.width - width : 0;
            const x = left + measure.measureText(line.slice(0, from - lineStart)).width;
            const w = measure.measureText(line.slice(from - lineStart, upTo - lineStart)).width;
            const name = document.createElement("span");
            name.className = "board-name";
            Object.assign(name.style, { left: `${x * zoom}px`, top: `${n * lineH * zoom}px`, width: `${w * zoom}px`, height: `${lineH * zoom}px` });
            frame.appendChild(name);
            spans.push({ links: to, el: name });
          }
          lineStart = lineEnd + 1;
        });
      };
      // Each name where it is drawn, across lines too; links whose names aren't in the words
      // (a text linked as a whole) underline all of it.
      const flat = lines.join(" ");
      const whole: BoardLink[] = [];
      for (const l of links) {
        const pattern = new RegExp(l.label.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
        const found = [...flat.matchAll(pattern)];
        if (!found.length) whole.push(l);
        for (const m of found) underline(m.index!, m.index! + m[0].length, [l]);
      }
      if (whole.length) underline(0, flat.length, whole);
      if (frame.childElementCount) out.push(frame);
    }
    names.replaceChildren(...out);
    shown = spans.map((n) => ({ links: n.links, box: n.el.getBoundingClientRect() })).reverse();
  }
  // The drawing's fonts load after it is first drawn: names are measured again then.
  document.fonts?.addEventListener("loadingdone", () => api && drawNames(api.getAppState()));
  const nameAt = (x: number, y: number) => shown.find((n) => x >= n.box.left && x <= n.box.right && y >= n.box.top && y <= n.box.bottom);
  // A click on a name opens it (⌘: in a new tab), once it is clear it isn't the start of a
  // double-click (which edits the text). Pressing still selects and drags the text as before.
  let down: { x: number; y: number } | null = null;
  let opening: ReturnType<typeof setTimeout> | undefined;
  el.addEventListener("pointerdown", (e) => {
    clearTimeout(opening);
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  }, true);
  el.addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    if (!d || !api || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || api.getAppState().activeTool.type !== "selection") return;
    const n = nameAt(e.clientX, e.clientY);
    if (!n) return;
    const newTab = e.metaKey;
    opening = setTimeout(() => o.onOpenLink(`${RECORD_LINK}${n.links[0]!.id}`, newTab, { links: n.links, at: { x: e.clientX, y: e.clientY } }), 300);
  }, true);
  el.addEventListener("dblclick", () => clearTimeout(opening), true);
  el.addEventListener("pointermove", (e) => host.classList.toggle("over-name", !!nameAt(e.clientX, e.clientY)));

  /** Where the pointer last was over the drawing (a paste goes there). */
  let pointer: { x: number; y: number } | undefined;
  el.addEventListener("pointermove", (e) => (pointer = { x: e.clientX, y: e.clientY }));
  el.addEventListener("pointerleave", () => (pointer = undefined));

  /** Pictures on the board whose data isn't loaded yet: from the library, by ID. */
  const loading = new Set<string>();
  const loadPictures = () => {
    if (!api) return;
    const have = api.getFiles();
    for (const e of api.getSceneElements()) {
      const fileId = (e as { fileId?: string | null }).fileId;
      if (e.type !== "image" || !fileId || have[fileId] || loading.has(fileId) || !UUID.test(fileId)) continue;
      loading.add(fileId);
      void o.imageOf(fileId).then((d) => {
        loading.delete(fileId);
        if (d) api?.addFiles([{ id: fileId, dataURL: d.dataURL, mimeType: d.mimeType, created: Date.now() } as never]);
      }, () => loading.delete(fileId));
    }
  };

  /** Where on the drawing a point on screen is (by default the middle of what is in view, left of
   * an open sidebar). */
  const scenePoint = (at?: { x: number; y: number }) => {
    const s = api!.getAppState();
    const side = el.querySelector(".sidebar")?.getBoundingClientRect();
    const right = side?.width ? side.left : s.offsetLeft + s.width;
    const p = at ?? { x: (s.offsetLeft + right) / 2, y: s.offsetTop + s.height / 2 };
    return viewportCoordsToSceneCoords({ clientX: p.x, clientY: p.y }, s);
  };

  const engine: BoardEngine = {
    el,
    async insert(items, at) {
      if (!api || !items.length) return;
      const origin = scenePoint(at);
      const made: unknown[] = [];
      // The first is centred on the point; any others follow to its right.
      let dx = 0;
      for (const it of items) {
        if ("words" in it) {
          const [t] = convertToExcalidrawElements([{ type: "text", text: it.words, x: 0, y: 0 }] as never) as unknown as (Drawn & { width: number; height: number })[];
          made.push(withLinks({ ...t!, x: origin.x + dx - (dx ? 0 : t!.width / 2), y: origin.y - t!.height / 2 }, it.links));
          dx += t!.width + 24;
          continue;
        }
        const customData = { librarium: { links: [{ id: it.id, label: it.label }], ...(it.embed ? { embed: true } : {}) } };
        const link = `${RECORD_LINK}${it.id}`;
        if (it.picture) {
          const d = await o.imageOf(it.id);
          if (!d) continue;
          api.addFiles([{ id: it.id, dataURL: d.dataURL, mimeType: d.mimeType, created: Date.now() } as never]);
          const scale = Math.min(1, 480 / Math.max(1, d.width));
          const [w, h] = [d.width * scale, d.height * scale];
          const [e] = convertToExcalidrawElements([{ type: "image", fileId: it.id as never, x: origin.x + dx - (dx ? 0 : w / 2), y: origin.y - h / 2, width: w, height: h }] as never);
          made.push({ ...e, link, customData, status: "saved" });
          dx += w + 24;
        } else {
          const [w, h] = it.embed ? [400, 180] : [280, 72];
          // Excalidraw's element builder doesn't make embeds: its file reader fills in what a
          // card needs, as when a drawing is opened.
          const [e] = restoreElements([{ type: "embeddable", id: cardId(), link, x: origin.x + dx - (dx ? 0 : w / 2), y: origin.y - h / 2, width: w, height: h, strokeColor: "transparent", backgroundColor: "transparent", roundness: null, customData }] as never, null);
          made.push(e);
          dx += w + 24;
        }
      }
      if (made.length) api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...(made as never[])], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    },
    busy() {
      const s = api?.getAppState();
      return !!s && (s.activeTool.type !== "selection" || !!(s.editingTextElement || s.newElement || s.multiElement || s.editingLinearElement || s.openMenu || s.openPopup || s.openDialog));
    },
    selected() {
      const s = api?.getAppState().selectedElementIds ?? {};
      return Object.keys(s).filter((k) => s[k]);
    },
    link(ids, to, opts = {}) {
      if (!api || !ids.length) return false;
      const all = api.getSceneElementsIncludingDeleted() as unknown as readonly Drawn[];
      const texts = new Set(opts.at !== undefined ? ids : []);
      const holders = new Set(ids.map((id) => all.find((e) => e.id === id)).filter((e) => !!e && !e.isDeleted).map((e) => holderOf(e!, all).id));
      if (!holders.size) return false;
      const next = all.map((e) => {
        let out = e;
        if (holders.has(e.id)) out = withLinks(e, [...linksOf(e).filter((l) => l.id !== to.id), to]);
        if (texts.has(e.id) && e.type === "text") {
          const words = putName(e.originalText ?? e.text ?? "", to.label, opts.at, !!opts.typed);
          out = { ...out, ...touched(e), text: words, originalText: words };
        }
        return out;
      });
      // Texts are measured (and a shape's wrapped) again: their words changed.
      api.updateScene({ elements: restoreElements(next as never, null, { refreshDimensions: true, repairBindings: true }), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return true;
    },
    addTextBox() {
      if (!api || o.readOnly) return;
      const p = scenePoint();
      const [w, h] = [320, 48];
      const [e] = restoreElements([{ type: "embeddable", id: cardId(), link: TEXT_BOX, x: p.x - w / 2, y: p.y - h / 2, width: w, height: h, strokeColor: "transparent", backgroundColor: "transparent", roundness: null, customData: { librarium: { text: "" } } }] as never, null);
      writeIn = e!.id;
      // Made as part of the step its first words make (or not at all, if it is left empty).
      quiet = "replay";
      quietUntil = performance.now() + 50;
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), e!] as never, appState: { selectedElementIds: { [e!.id]: true }, activeEmbeddable: { element: e, state: "active" } } as never, captureUpdate: CaptureUpdateAction.EVENTUALLY });
    },
    untype(id, at) {
      if (!api) return;
      const all = api.getSceneElementsIncludingDeleted() as unknown as readonly Drawn[];
      const t = all.find((e) => e.id === id && e.type === "text");
      const words = t?.originalText ?? t?.text ?? "";
      if (!t || words.slice(at - 2, at) !== "[[") return;
      const back = words.slice(0, at - 2) + words.slice(at);
      const next = all.map((e) => (e === t ? { ...e, ...touched(e), text: back, originalText: back } : e));
      api.updateScene({ elements: restoreElements(next as never, null, { refreshDimensions: true, repairBindings: true }), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    },
    current() {
      const a = api!;
      const elements = a.getSceneElementsIncludingDeleted();
      // Pictures that are library items are kept by ID only.
      const files = Object.fromEntries(Object.entries(a.getFiles()).filter(([id]) => !UUID.test(id)));
      return { scene: serializeAsJSON(elements, a.getAppState(), files, "local"), elements: elements as unknown as readonly BoardElement[] };
    },
    load(scene) {
      const d = parse(scene);
      quiet = "load";
      quietUntil = performance.now() + 250;
      api?.updateScene({ elements: d.elements, appState: { viewBackgroundColor: d.appState.viewBackgroundColor }, captureUpdate: CaptureUpdateAction.NEVER });
      if (d.files) api?.addFiles(Object.values(d.files));
      loadPictures();
    },
    applyRemote(remote, texts) {
      if (!api) return false;
      const before = getSceneVersion(api.getSceneElementsIncludingDeleted());
      const local = api.getSceneElementsIncludingDeleted();
      const merged = reconcileElements(local as never, restoreElements(remote as never, null) as never, api.getAppState()) as unknown as readonly Drawn[];
      let boxChanged = false;
      // A text box's words are the shared document's (merged character by character there).
      const next = merged.map((e) => {
        const text = texts[e.id];
        if (text === undefined || !isTextBox(e) || boxText(e) === text) return e;
        boxChanged = true;
        const c = (e.customData ?? {}) as { librarium?: object };
        return { ...e, customData: { ...c, librarium: { ...c.librarium, text } } };
      });
      if (getSceneVersion(next as never) === before && !boxChanged) return false;
      quiet = "replay";
      quietUntil = performance.now() + 50;
      api.updateScene({ elements: next as never, captureUpdate: CaptureUpdateAction.NEVER });
      // A box being written in shows the merged words, its cursor kept.
      for (const [elementId, text] of Object.entries(texts)) {
        const box = boxes.get(elementId);
        if (box && box.text !== text) ((box.text = text), box.view.set(text));
      }
      loadPictures();
      return true;
    },
    setShared(on) {
      shared = on;
    },
    followPointer(to) {
      pointerTo = to;
    },
    setPeers(peers) {
      const collaborators = new Map([...peers].map(([id, p]) => [id, { pointer: { x: p.x, y: p.y, tool: p.tool }, button: p.button, username: p.name, color: { background: p.color, stroke: p.color }, id }]));
      api?.updateScene({ collaborators: collaborators as never });
    },
    undo: () => key(false),
    redo: () => key(true),
    setTheme(t) {
      theme = t;
      render();
    },
    destroy() {
      root.unmount();
      el.remove();
      chip.remove();
      names.remove();
    },
  };
  // Ready once Excalidraw has handed over its API.
  return new Promise((resolve) => {
    const t0 = performance.now();
    const wait = () => (api || performance.now() - t0 > 10_000 ? (loadPictures(), resolve(engine)) : requestAnimationFrame(wait));
    wait();
  });
}

// ---- The board elsewhere: as a picture, and as a file that opens anywhere ---------------------

export interface Portable {
  /** A card's words: a capture's quotation and citation, else the record's name and kind. */
  cardText(id: string): string;
  imageOf(id: string): Promise<Picture | null>;
}

/** The drawing made to read anywhere: cards become boxes with words, pictures carry their data. */
async function portableScene(scene: string, p: Portable) {
  const d = parse(scene);
  const out: unknown[] = [];
  for (const e of d.elements) {
    const id = e.type === "embeddable" && !e.isDeleted ? recordOf(e.link) : null;
    const box = !e.isDeleted && isTextBox(e);
    if (!id && !box) {
      out.push(e);
      continue;
    }
    // A text box becomes its words (each link and embed as its name); a card, a box with its words.
    const label = box ? wordsAndLinks(boxText(e)).words : p.cardText(id!);
    out.push(...convertToExcalidrawElements([
      { type: box ? "text" : "rectangle", x: e.x, y: e.y, ...(box ? { text: label, fontSize: 16 } : { width: e.width, height: e.height, strokeColor: "#868e96", backgroundColor: "transparent", roundness: { type: 3 }, label: { text: label, fontSize: 16, textAlign: "left", verticalAlign: "top" }, link: e.link }) },
    ] as never));
  }
  const files: Record<string, unknown> = { ...(d.files ?? {}) };
  for (const e of d.elements) {
    const fileId = (e as { fileId?: string | null }).fileId;
    if (e.type !== "image" || e.isDeleted || !fileId || files[fileId] || !UUID.test(fileId)) continue;
    const data = await p.imageOf(fileId);
    if (data) files[fileId] = { id: fileId, mimeType: data.mimeType, dataURL: data.dataURL, created: Date.now() };
  }
  return { elements: out as never[], appState: d.appState, files: files as never };
}

/** The board as an Excalidraw file that opens anywhere. */
export async function portableFile(scene: string, p: Portable): Promise<string> {
  const s = await portableScene(scene, p);
  return serializeAsJSON(s.elements, s.appState, s.files, "local");
}

/** The board as an SVG picture, light or dark. */
export async function boardSvg(scene: string, p: Portable, dark: boolean): Promise<SVGSVGElement> {
  const s = await portableScene(scene, p);
  const elements = s.elements.filter((e: { isDeleted?: boolean }) => !e.isDeleted);
  return exportToSvg({ elements, appState: { ...s.appState, exportBackground: true, exportWithDarkMode: dark, exportPadding: 24 }, files: s.files, exportPadding: 24 });
}

/** The board as a PNG picture, at twice its size. */
export async function boardPng(scene: string, p: Portable, dark: boolean): Promise<Blob> {
  const s = await portableScene(scene, p);
  const elements = s.elements.filter((e: { isDeleted?: boolean }) => !e.isDeleted);
  return exportToBlob({ elements, appState: { ...s.appState, exportBackground: true, exportWithDarkMode: dark, exportPadding: 24 }, files: s.files, mimeType: "image/png", exportPadding: 24, getDimensions: (w: number, h: number) => ({ width: w * 2, height: h * 2, scale: 2 }) });
}
