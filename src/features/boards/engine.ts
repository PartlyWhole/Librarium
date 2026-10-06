/**
 * Excalidraw, mounted for a board (decision 0061: the only place React and Excalidraw are used,
 * loaded when a board opens). The page (page.ts) talks to it through `BoardEngine` only.
 */
import { createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { CaptureUpdateAction, convertToExcalidrawElements, Excalidraw, exportToBlob, exportToSvg, getSceneVersion, restore, restoreElements, serializeAsJSON, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { passThrough } from "../../kit/keys";
import { RECORD_LINK, recordOf, type BoardElement, type BoardLink } from "./links";

type Api = Parameters<NonNullable<Parameters<typeof Excalidraw>[0]["excalidrawAPI"]>>[0];
type AppState = ReturnType<Api["getAppState"]>;

export type { BoardElement, BoardLink } from "./links";

export interface BoardEngineOptions {
  /** The drawing, in Excalidraw's file format. */
  scene: string;
  theme: "light" | "dark";
  readOnly: boolean;
  /** The drawing changed (not by `load`, undo or redo). */
  onChange(): void;
  /** A step that Excalidraw's own undo would undo: a shape drawn, moved, a text typed… */
  onStep(): void;
  /** Pictures pasted: the page makes them library attachments, then inserts them. */
  onFiles(files: File[]): void;
  /** Draws a record's card (a capture's quotation, an item, a note) into `host`; returns how to stop. */
  renderCard(id: string, host: HTMLElement): () => void;
  /** A picture's data (a library item, by ID). */
  imageOf(id: string): Promise<{ dataURL: string; mimeType: string; width: number; height: number } | null>;
  /** `[[` was typed in a text (its element): the page offers what to link to. */
  onLinkStart(elementId: string): void;
  /** A link on the board was clicked (with ⌘: in a new tab). */
  onOpenLink(link: string, newTab: boolean): void;
}

export interface BoardEngine {
  /** The drawing now, in Excalidraw's file format, and its elements. */
  current(): { scene: string; elements: readonly BoardElement[] };
  /** Shows another drawing (changed outside), not as a step to undo. */
  load(scene: string): void;
  /**
   * Puts records on the board, as one step: pictures as pictures, anything else as a card (a
   * capture's quotation, an item, a note). At a point on screen (`at`), or in the middle.
   */
  insert(items: BoardInsert[], at?: { x: number; y: number }): Promise<void>;
  /** The elements selected (their IDs). */
  selected(): string[];
  /**
   * Links elements to a record (one step to undo). In a text, `[[` just typed is replaced by
   * the record's name; a text keeps each of its links (Excalidraw follows the first).
   */
  link(ids: string[], to: BoardLink, opts?: { replaceTyped?: boolean }): boolean;
  /** Excalidraw's undo / redo; whether anything changed. */
  undo(): boolean;
  redo(): boolean;
  setTheme(theme: "light" | "dark"): void;
  /** The element holding the canvas (keys and focus). */
  readonly el: HTMLElement;
  destroy(): void;
}

/** A record to put on the board. */
export interface BoardInsert {
  id: string;
  label: string;
  picture: boolean;
  /** Written `![[…]]` in the readable page (a capture: its quotation). */
  embed: boolean;
}

/** Pictures and cards kept by record ID (a UUID), not as data in the drawing (0065). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A card: our own DOM (from the page), held by React inside Excalidraw's embed element. */
function Card(props: { id: string; render: (id: string, host: HTMLElement) => () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => props.render(props.id, ref.current!), [props.id, props.render]);
  return createElement("div", { ref, className: "board-card-host" });
}

/** A gesture in progress: its steps are counted when it ends. */
const busy = (s: AppState) =>
  !!(s.newElement || s.resizingElement || s.multiElement || s.editingTextElement || s.isResizing || s.isRotating || s.selectedElementsAreBeingDragged || s.editingLinearElement);

function parse(scene: string) {
  try {
    const data = JSON.parse(scene) as Parameters<typeof restore>[0];
    return restore(data, null, null);
  } catch {
    return restore(null, null, null);
  }
}

export function mountBoard(host: HTMLElement, o: BoardEngineOptions): Promise<BoardEngine> {
  const el = document.createElement("div");
  el.className = "board-canvas";
  host.appendChild(el);
  const root = createRoot(el);
  let api: Api | null = null;
  let theme = o.theme;
  const initial = parse(o.scene);
  // Changes that aren't new steps: undo and redo (saved, not counted), and a drawing loaded from
  // disk (neither).
  let quietUntil = 0;
  let quiet: "replay" | "load" = "replay";
  let version = getSceneVersion(initial.elements);
  let stepPending = false;

  const onChange = (elements: Parameters<typeof getSceneVersion>[0], state: AppState) => {
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
        excalidrawAPI: (a: Api) => {
          api = a;
        },
        theme,
        viewModeEnabled: o.readOnly,
        onLinkOpen: (element: { link: string | null }, event: CustomEvent<{ nativeEvent: MouseEvent | { metaKey?: boolean } }>) => {
          if (!element.link) return;
          event.preventDefault();
          o.onOpenLink(element.link, !!event.detail?.nativeEvent?.metaKey);
        },
        aiEnabled: false,
        onChange,
        // Saving, opening and exporting go through Librarium.
        UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false }, tools: { image: false } },
        // Pictures pasted become library attachments (the page), then are put here by ID.
        onPaste: (data: { files?: object; elements?: readonly { type: string }[] | null }, event: ClipboardEvent | null) => {
          const files = [...(event?.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (files.length) {
            o.onFiles(files);
            return false;
          }
          // Pictures copied from another board are put back by their IDs (their data isn't copied).
          return !(Object.keys(data.files ?? {}).length > 0 && !data.elements?.length);
        },
        // Cards are Librarium's records only (no web pages, videos or posts).
        validateEmbeddable: (link: string) => recordOf(link) !== null,
        renderEmbeddable: (element: { link: string | null }) => {
          const id = recordOf(element.link);
          return id ? createElement(Card, { id, render: o.renderCard }) : null;
        },
      }),
    );
  render();

  // Undo and redo are Excalidraw's own, reached by its key (it has no call for them). It applies
  // them a moment later, so a step sent counts as done (each was recorded by `onStep`).
  const key = (shift: boolean) => {
    if (!api) return false;
    quiet = "replay";
    quietUntil = performance.now() + 250;
    const target = el.querySelector(".excalidraw") ?? el;
    target.dispatchEvent(passThrough(new KeyboardEvent("keydown", { key: shift ? "Z" : "z", code: "KeyZ", metaKey: true, shiftKey: shift, bubbles: true, cancelable: true })));
    return true;
  };

  // `[[` typed in a text being edited: the text is finished (so it can be linked), and the page
  // offers what to link to.
  el.addEventListener(
    "input",
    (e) => {
      const ta = e.target as HTMLTextAreaElement;
      if (!ta.classList?.contains("excalidraw-wysiwyg") || !api) return;
      const at = ta.selectionStart ?? ta.value.length;
      if (ta.value.slice(Math.max(0, at - 2), at) !== "[[") return;
      const editing = api.getAppState().editingTextElement;
      if (!editing) return;
      ta.blur();
      setTimeout(() => o.onLinkStart(editing.id), 0);
    },
    true,
  );

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

  /** Where on the drawing a point on screen is (the middle of the view, by default). */
  const scenePoint = (at?: { x: number; y: number }) => {
    const s = api!.getAppState();
    const p = at ?? { x: s.offsetLeft + s.width / 2, y: s.offsetTop + s.height / 2 };
    return viewportCoordsToSceneCoords({ clientX: p.x, clientY: p.y }, s);
  };

  const engine: BoardEngine = {
    el,
    async insert(items, at) {
      if (!api || !items.length) return;
      const origin = scenePoint(at);
      const made: unknown[] = [];
      let dx = 0;
      for (const it of items) {
        const custom = { librarium: { links: [{ id: it.id, label: it.label }], ...(it.embed ? { embed: true } : {}) } };
        const link = `${RECORD_LINK}${it.id}`;
        if (it.picture) {
          const d = await o.imageOf(it.id);
          if (!d) continue;
          api.addFiles([{ id: it.id, dataURL: d.dataURL, mimeType: d.mimeType, created: Date.now() } as never]);
          const scale = Math.min(1, 480 / Math.max(1, d.width));
          // Centred on the point (the first; any others beside it).
          const [el] = convertToExcalidrawElements([{ type: "image", fileId: it.id as never, x: origin.x + dx - (dx ? 0 : (d.width * scale) / 2), y: origin.y - (d.height * scale) / 2, width: d.width * scale, height: d.height * scale }] as never);
          made.push({ ...el, link, customData: custom, status: "saved" });
          dx += d.width * scale + 24;
        } else {
          const [w, h] = it.embed ? [400, 180] : [280, 72];
          // Excalidraw's element builder doesn't make embed elements: its file reader fills in
          // what a card needs, as when a drawing is opened.
          const id = `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const [el] = restoreElements([{ type: "embeddable", id, link, x: origin.x + dx - (dx ? 0 : w / 2), y: origin.y - h / 2, width: w, height: h, strokeColor: "transparent", backgroundColor: "transparent", roundness: null, customData: custom }] as never, null);
          made.push(el);
          dx += w + 24;
        }
      }
      if (!made.length) return;
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...(made as never[])], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    },
    selected() {
      const s = api?.getAppState().selectedElementIds ?? {};
      return Object.keys(s).filter((k) => s[k]);
    },
    link(ids, to, opts = {}) {
      if (!api || !ids.length) return false;
      const all = api.getSceneElementsIncludingDeleted();
      let changed = false;
      const next = all.map((e) => {
        if (!ids.includes(e.id) || e.isDeleted) return e;
        changed = true;
        const had = ((e.customData as BoardElement["customData"])?.librarium?.links ?? []).filter((l) => l.id !== to.id);
        const links = [...had, to];
        const patch: Record<string, unknown> = {
          // Excalidraw follows one link per element: the first record linked.
          link: `${RECORD_LINK}${links[0]!.id}`,
          customData: { ...(e.customData ?? {}), librarium: { ...((e.customData as BoardElement["customData"])?.librarium ?? {}), links } },
          version: e.version + 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
          updated: Date.now(),
        };
        if (e.type === "text" && opts.replaceTyped) {
          const t = e as unknown as { text: string; originalText: string };
          const cut = (s: string) => (s.endsWith("[[") ? s.slice(0, -2) : s) + to.label;
          patch.text = cut(t.text);
          patch.originalText = cut(t.originalText ?? t.text);
        }
        return { ...e, ...patch };
      });
      if (!changed) return false;
      // Texts are measured again (their words changed).
      const fixed = restoreElements(next as never, null, { refreshDimensions: true, repairBindings: true });
      api.updateScene({ elements: fixed, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return true;
    },
    current() {
      const a = api!;
      const elements = a.getSceneElementsIncludingDeleted();
      // Pictures that are library items are kept by ID only (loaded from the library).
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
    undo: () => key(false),
    redo: () => key(true),
    setTheme(t) {
      theme = t;
      render();
    },
    destroy() {
      root.unmount();
      el.remove();
    },
  };
  // Ready when Excalidraw has handed over its API.
  return new Promise((resolve) => {
    const t0 = performance.now();
    const wait = () => (api || performance.now() - t0 > 10_000 ? (loadPictures(), resolve(engine)) : requestAnimationFrame(wait));
    wait();
  });
}

// ---- the board elsewhere: as a picture, and as a file that reads anywhere (0066) -----------

export interface Portable {
  /** A card's words: a capture's quotation and citation, else the record's name and kind. */
  cardText(id: string): string;
  imageOf: BoardEngineOptions["imageOf"];
}

/**
 * The drawing made to read anywhere: each card becomes a box with its words (a capture's
 * quotation and citation), and each picture's data is put back in (from the library).
 */
async function portableScene(scene: string, p: Portable) {
  const d = parse(scene);
  const out: unknown[] = [];
  for (const e of d.elements) {
    const id = e.type === "embeddable" && !e.isDeleted ? recordOf(e.link) : null;
    if (!id) {
      out.push(e);
      continue;
    }
    const box = convertToExcalidrawElements([
      { type: "rectangle", x: e.x, y: e.y, width: e.width, height: e.height, strokeColor: "#868e96", backgroundColor: "transparent", roundness: { type: 3 }, label: { text: p.cardText(id), fontSize: 16, textAlign: "left", verticalAlign: "top" }, link: e.link },
    ] as never);
    out.push(...box);
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

/** The board as an Excalidraw file that opens anywhere (cards as boxes, pictures inside). */
export async function portableFile(scene: string, p: Portable): Promise<string> {
  const s = await portableScene(scene, p);
  return serializeAsJSON(s.elements, s.appState, s.files, "local");
}

/** The board as a picture (SVG, or PNG at twice the size), in the light or dark look. */
export async function boardPicture(scene: string, p: Portable, as: "svg"): Promise<SVGSVGElement>;
export async function boardPicture(scene: string, p: Portable, as: "png"): Promise<Blob>;
export async function boardPicture(scene: string, p: Portable & { dark?: boolean }, as: "svg" | "png"): Promise<SVGSVGElement | Blob> {
  const s = await portableScene(scene, p);
  const elements = s.elements.filter((e: { isDeleted?: boolean }) => !e.isDeleted);
  const appState = { ...s.appState, exportBackground: true, exportWithDarkMode: !!p.dark, exportPadding: 24 };
  if (as === "svg") return exportToSvg({ elements, appState, files: s.files, exportPadding: 24 });
  return exportToBlob({ elements, appState, files: s.files, mimeType: "image/png", exportPadding: 24, getDimensions: (w: number, h: number) => ({ width: w * 2, height: h * 2, scale: 2 }) });
}
