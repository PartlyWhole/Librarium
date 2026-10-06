/**
 * Excalidraw, mounted for a board (decision 0061: the only place React and Excalidraw are used,
 * loaded when a board opens). The page (page.ts) talks to it through `BoardEngine` only.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { CaptureUpdateAction, Excalidraw, getSceneVersion, restore, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { passThrough } from "../../kit/keys";
import { RECORD_LINK, type BoardElement, type BoardLink } from "./links";

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
  /** Pictures wait for a later phase (they will be library attachments, plan §4). */
  onPicture(): void;
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
        onPaste: (data: { files?: object; elements?: readonly { type: string }[] | null }, event: ClipboardEvent | null) => {
          const pictures = Object.keys(data.files ?? {}).length > 0 || !!data.elements?.some((e) => e.type === "image") || [...(event?.clipboardData?.files ?? [])].some((f) => f.type.startsWith("image/"));
          if (pictures) {
            o.onPicture();
            return false;
          }
          return true;
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

  const engine: BoardEngine = {
    el,
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
      return { scene: serializeAsJSON(elements, a.getAppState(), a.getFiles(), "local"), elements: elements as unknown as readonly BoardElement[] };
    },
    load(scene) {
      const d = parse(scene);
      quiet = "load";
      quietUntil = performance.now() + 250;
      api?.updateScene({ elements: d.elements, appState: { viewBackgroundColor: d.appState.viewBackgroundColor }, captureUpdate: CaptureUpdateAction.NEVER });
      if (d.files) api?.addFiles(Object.values(d.files));
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
    const wait = () => (api || performance.now() - t0 > 10_000 ? resolve(engine) : requestAnimationFrame(wait));
    wait();
  });
}
