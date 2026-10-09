/**
 * Turning a book's pages, as in Apple Books: the page slides away and the next slides in (a
 * fade under Reduce Motion). Turns asked for during one are queued, so quick key presses
 * aren't lost; a trackpad swipe turns exactly one page.
 */
export type Side = "left" | "right";

interface Turner {
  flip(side: Side): Promise<void>;
  /** For `wheel` events on the book and its pages (not passive). */
  onWheel(e: WheelEvent): void;
}

/**
 * `go` turns the page in the navigator; `where` says where the reader is (to know whether the
 * page moved); `scrolling` whether the book scrolls (no slide, no swipes).
 */
export function pageTurner(stage: HTMLElement, go: (side: Side) => Promise<void>, where: () => unknown, scrolling: () => boolean): Turner {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let flipping = false;
  let queued: Side | null = null;

  async function flip(side: Side): Promise<void> {
    if (flipping) {
      queued = side;
      return;
    }
    flipping = true;
    const away = side === "right" ? -1 : 1;
    try {
      if (!scrolling()) {
        stage.style.transition = reduced ? "opacity 90ms ease-in" : "transform 130ms ease-in, opacity 130ms ease-in";
        stage.style.transform = reduced ? "" : `translateX(${away * 36}px)`;
        stage.style.opacity = "0.15";
        await pause(reduced ? 90 : 130);
      }
      const before = where();
      await go(side);
      if (!scrolling()) {
        const moved = where() !== before;
        stage.style.transition = "none";
        stage.style.transform = reduced || !moved ? "" : `translateX(${-away * 36}px)`;
        void stage.offsetWidth;
        stage.style.transition = reduced ? "opacity 120ms ease-out" : "transform 220ms cubic-bezier(.2,.8,.2,1), opacity 220ms ease-out";
        stage.style.transform = "";
        stage.style.opacity = "";
        await pause(reduced ? 120 : 220);
      }
    } finally {
      stage.style.transition = "";
      flipping = false;
    }
    const next = queued;
    queued = null;
    if (next) void flip(next);
  }

  // After the fingers lift, the trackpad keeps sending a fading stream (momentum): that doesn't
  // turn again, but a new swipe (a sudden, clear rise) does. Momentum has bumps, so after a
  // turn swipes rest for a moment: one swipe, one page.
  const SWIPE_REST = 500;
  let swipe = 0;
  let swiped = false;
  let lastAbs = 0;
  let turnedAt = -Infinity;
  let swipeTimer: ReturnType<typeof setTimeout> | undefined;
  function onWheel(e: WheelEvent) {
    if (scrolling() || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    // A sideways swipe mustn't scroll the columns (it fights the turn).
    e.preventDefault();
    const abs = Math.abs(e.deltaX);
    clearTimeout(swipeTimer);
    swipeTimer = setTimeout(() => {
      swipe = 0;
      swiped = false;
      lastAbs = 0;
    }, 220);
    const resting = performance.now() - turnedAt < SWIPE_REST;
    if (swiped && !resting && abs >= 12 && abs > lastAbs * 1.8) {
      swiped = false;
      swipe = 0;
    }
    lastAbs = abs;
    if (swiped || resting) return;
    swipe += e.deltaX;
    if (Math.abs(swipe) < 24) return;
    swiped = true;
    turnedAt = performance.now();
    // Not queued behind a turn under way (keys are): a swipe then is the same gesture.
    if (!flipping) void flip(swipe > 0 ? "right" : "left");
  }

  return { flip, onWheel };
}
