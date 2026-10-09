/**
 * Excalidraw, mounted for a board: the only place React is used, loaded (with this module) the
 * first time a board is opened or drawn in a note. The page talks to it through `BoardEngine`.
 */
import { createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { CaptureUpdateAction, convertToExcalidrawElements, Excalidraw, exportToBlob, exportToSvg, getSceneVersion, restore, restoreElements, serializeAsJSON, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { passThrough } from "../ui/keys";
import { RECORD_LINK, recordOf, UUID, type BoardElement, type BoardLink } from "./links";

type Api = Parameters<NonNullable<Parameters<typeof Excalidraw>[0]["excalidrawAPI"]>>[0];
type AppState = ReturnType<Api["getAppState"]>;

/** A picture's data and size. */
export interface Picture {
  dataURL: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface EngineOptions {
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
  /** A picture's data (a library item, by ID). */
  imageOf(id: string): Promise<Picture | null>;
  /** `[[` was typed in a text (this element): the page offers what to link to. */
  onLinkStart(elementId: string): void;
  /** A link on the board was clicked (with ⌘: in a new tab). */
  onOpenLink(link: string, newTab: boolean): void;
}

/** A record to put on the board. */
export interface BoardInsert {
  id: string;
  label: string;
  picture: boolean;
  /** Written `![[…]]` in the readable page (a capture's quotation, a picture). */
  embed: boolean;
}

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
  /**
   * Links elements to a record (one step). In a text, a `[[` just typed is replaced by the
   * record's name; a text keeps each of its links (Excalidraw follows the first).
   */
  link(ids: string[], to: BoardLink, opts?: { replaceTyped?: boolean }): boolean;
  /** Excalidraw's own undo and redo. */
  undo(): boolean;
  redo(): boolean;
  setTheme(theme: "light" | "dark"): void;
  destroy(): void;
}

/** A card: the page's own DOM, held by React inside Excalidraw's embed element. */
function Card(props: { id: string; render: (id: string, host: HTMLElement) => () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => props.render(props.id, ref.current!), [props.id, props.render]);
  return createElement("div", { ref, className: "board-card-host" });
}

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
        excalidrawAPI: (a: Api) => void (api = a),
        theme,
        viewModeEnabled: o.readOnly,
        aiEnabled: false,
        onChange,
        onLinkOpen: (element: { link: string | null }, event: CustomEvent<{ nativeEvent: MouseEvent | { metaKey?: boolean } }>) => {
          if (!element.link) return;
          event.preventDefault();
          o.onOpenLink(element.link, !!event.detail?.nativeEvent?.metaKey);
        },
        // Saving, opening, exporting and pictures go through Librarium.
        UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false }, tools: { image: false } },
        onPaste: (data: { files?: object; elements?: readonly { type: string }[] | null }, event: ClipboardEvent | null) => {
          const files = [...(event?.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (files.length) {
            o.onFiles(files);
            return false;
          }
          // Pictures copied from another board come back by their IDs (their data isn't copied).
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

  // `[[` typed in a text being edited: the text is finished (so it can be linked), and the
  // page offers what to link to.
  el.addEventListener("input", (e) => {
    const ta = e.target as HTMLTextAreaElement;
    if (!ta.classList?.contains("excalidraw-wysiwyg") || !api) return;
    const at = ta.selectionStart ?? ta.value.length;
    if (ta.value.slice(Math.max(0, at - 2), at) !== "[[") return;
    const editing = api.getAppState().editingTextElement;
    if (!editing) return;
    ta.blur();
    setTimeout(() => o.onLinkStart(editing.id), 0);
  }, true);

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
      // The first is centred on the point; any others follow to its right.
      let dx = 0;
      for (const it of items) {
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
    selected() {
      const s = api?.getAppState().selectedElementIds ?? {};
      return Object.keys(s).filter((k) => s[k]);
    },
    link(ids, to, opts = {}) {
      if (!api || !ids.length) return false;
      let changed = false;
      const next = api.getSceneElementsIncludingDeleted().map((e) => {
        if (!ids.includes(e.id) || e.isDeleted) return e;
        changed = true;
        const mine = (e.customData as BoardElement["customData"])?.librarium;
        const links = [...(mine?.links ?? []).filter((l) => l.id !== to.id), to];
        const patch: Record<string, unknown> = {
          link: `${RECORD_LINK}${links[0]!.id}`,
          customData: { ...(e.customData ?? {}), librarium: { ...(mine ?? {}), links } },
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
      api.updateScene({ elements: restoreElements(next as never, null, { refreshDimensions: true, repairBindings: true }), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return true;
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
    if (!id) {
      out.push(e);
      continue;
    }
    out.push(...convertToExcalidrawElements([
      { type: "rectangle", x: e.x, y: e.y, width: e.width, height: e.height, strokeColor: "#868e96", backgroundColor: "transparent", roundness: { type: 3 }, label: { text: p.cardText(id), fontSize: 16, textAlign: "left", verticalAlign: "top" }, link: e.link },
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
