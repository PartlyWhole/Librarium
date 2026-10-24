/**
 * A shared board, live: what is drawn here goes to the shared document a moment later, what
 * colleagues draw comes in (as no step to undo), and their pointers show with their names. The
 * backend keeps the document (src-tauri/src/sharing/boards.rs).
 *
 * Each push is based on the document's state this page last had ("heads"), so the document
 * merges it with what colleagues did meanwhile: a text box's words typed here and there are both
 * kept. While something here isn't pushed yet, or a push is on its way, what arrives waits, and
 * the latest state is fetched once the push is in.
 */
import { call, on } from "../backend";
import { signal, type Signal } from "../ui/signal";
import type { SharedBoard } from "../types";
import type { BoardEngine, Peer } from "./engine";

const PUSH_MS = 120;
const POINTER_MS = 60;
/** A colleague who hasn't moved for this long is taken off the board. */
const GONE_MS = 20_000;
const COLORS = ["#e8590c", "#1971c2", "#2f9e44", "#9c36b5", "#c2255c", "#0c8599", "#f08c00"];

interface Arrived {
  id: string;
  elements: unknown[];
  boxes: Record<string, string>;
  heads: string[];
}

export interface LiveBoard {
  /** The link colleagues are sent, while the board is shared. */
  readonly link: Signal<string | null>;
  /** How many colleagues are on the board now. */
  readonly here: Signal<number>;
  /** The drawing changed here. */
  changed(): void;
  /** The board was shared (or stopped being) from this page. */
  refresh(): Promise<void>;
  stop(): void;
}

/** Follows the board `id` if it is shared; `drew` is told when what arrived changed the drawing
 * (so the page saves it). */
export function liveBoard(id: string, engine: BoardEngine, drew: () => void): LiveBoard {
  const link = signal<string | null>(null);
  const here = signal(0);
  let heads: string[] = [];
  let unpushed = false;
  let pushing = 0;
  let behind = false;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const apply = (s: { elements: unknown[]; boxes: Record<string, string>; heads: string[] }) => {
    heads = s.heads;
    if (engine.applyRemote(s.elements, s.boxes)) drew();
  };
  const refresh = async () => {
    const s = await call<SharedBoard | null>("sharing.watchBoard", { id, open: true }).catch(() => null);
    if (stopped) return;
    link.set(s?.link ?? null);
    if (s && s.heads.length) apply(s);
  };
  const push = async () => {
    clearTimeout(pushTimer);
    if (!link.peek() || stopped) return;
    unpushed = false;
    pushing++;
    try {
      heads = await call<string[]>("sharing.push", { id, elements: engine.current().elements, heads });
    } catch {
      unpushed = true;
    } finally {
      pushing--;
    }
    if (unpushed) return void (pushTimer = setTimeout(() => void push(), PUSH_MS));
    if (!pushing && behind) ((behind = false), void refresh());
  };
  const offArrived = on<Arrived>("sharing.board", (s) => {
    if (s.id !== id || stopped) return;
    if (unpushed || pushing) {
      behind = true;
      if (unpushed && !pushing) void push();
      return;
    }
    apply(s);
  });

  // ---- Pointers ----
  const peers = new Map<string, Peer & { at: number }>();
  const colorOf = (peer: string) => COLORS[[...peer].reduce((n, c) => n + c.charCodeAt(0), 0) % COLORS.length]!;
  const showPeers = () => {
    const now = Date.now();
    for (const [k, p] of peers) if (now - p.at > GONE_MS) peers.delete(k);
    here.set(peers.size);
    engine.setPeers(new Map([...peers].map(([k, p]) => [k, p])));
  };
  const offPresence = on<{ board: string; peer: string; name: string | null; x: number; y: number; button: "down" | "up" }>("sharing.presence", (p) => {
    if (p.board !== id || stopped) return;
    peers.set(p.peer, { x: p.x, y: p.y, button: p.button, name: p.name || "Colleague", color: colorOf(p.peer), at: Date.now() });
    showPeers();
  });
  const sweep = setInterval(showPeers, 5000);
  let lastPointer = 0;
  let pointerTimer: ReturnType<typeof setTimeout> | undefined;
  const sendPointer = (p: { x: number; y: number; button: "down" | "up" }) => {
    if (!link.peek()) return;
    clearTimeout(pointerTimer);
    const wait = POINTER_MS - (Date.now() - lastPointer);
    if (wait > 0) return void (pointerTimer = setTimeout(() => sendPointer(p), wait));
    lastPointer = Date.now();
    void call("sharing.presence", { id, data: p }).catch(() => {});
  };
  engine.followPointer(sendPointer);

  void refresh();
  return {
    link,
    here,
    changed() {
      if (!link.peek()) return;
      unpushed = true;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => void push(), PUSH_MS);
    },
    refresh,
    stop() {
      if (unpushed) void push();
      stopped = true;
      clearTimeout(pushTimer);
      clearTimeout(pointerTimer);
      clearInterval(sweep);
      offArrived();
      offPresence();
      engine.followPointer(undefined);
      void call("sharing.watchBoard", { id, open: false }).catch(() => {});
    },
  };
}
