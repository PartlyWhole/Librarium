/**
 * Excalidraw, mounted for a board (decision 0061: the only place React and Excalidraw are used,
 * loaded when a board opens). The page (page.ts) talks to it through `BoardEngine` only.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { CaptureUpdateAction, Excalidraw, getSceneVersion, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { passThrough } from "../../kit/keys";

type Api = Parameters<NonNullable<Parameters<typeof Excalidraw>[0]["excalidrawAPI"]>>[0];
type AppState = ReturnType<Api["getAppState"]>;

/** A drawing element as the readable page needs it. */
export interface BoardElement {
  id: string;
  type: string;
  x: number;
  y: number;
  text?: string;
  link?: string | null;
  isDeleted?: boolean;
  containerId?: string | null;
}

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
}

export interface BoardEngine {
  /** The drawing now, in Excalidraw's file format, and its elements. */
  current(): { scene: string; elements: readonly BoardElement[] };
  /** Shows another drawing (changed outside), not as a step to undo. */
  load(scene: string): void;
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

  const engine: BoardEngine = {
    el,
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
