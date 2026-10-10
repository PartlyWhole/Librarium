/**
 * Text cut short with "…" inside `root` scrolls while the pointer rests on it, to its end and
 * back, so a long title can be read where it is. With reduced motion, the whole text is its
 * tooltip instead.
 */
const SPEED = 40; // pixels a second
const WAIT = 600; // before starting, and at each end (ms)

const cut = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === "ellipsis";

/** The element under `target` (within `root`) whose text is cut short, if any. */
function cutAt(root: HTMLElement, target: EventTarget | null): HTMLElement | null {
  for (let el = target instanceof HTMLElement ? target : null; el && el !== root; el = el.parentElement) if (cut(el)) return el;
  return null;
}

export function scrollLongText(root: HTMLElement): void {
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let on: HTMLElement | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    if (on) {
      on.scrollLeft = 0;
      on.style.textOverflow = "";
    }
    on = null;
  };
  /** Scrolls `el` to `to`, then waits and goes back the other way. */
  const glide = (el: HTMLElement, to: number) => {
    const from = el.scrollLeft;
    const t0 = performance.now();
    const ms = (Math.abs(to - from) / SPEED) * 1000;
    const step = (now: number) => {
      if (on !== el) return;
      const f = Math.min(1, (now - t0) / ms);
      el.scrollLeft = from + (to - from) * f;
      if (f < 1) frame = requestAnimationFrame(step);
      else timer = setTimeout(() => glide(el, to ? 0 : el.scrollWidth - el.clientWidth), WAIT);
    };
    frame = requestAnimationFrame(step);
  };
  root.addEventListener("mouseover", (e) => {
    const el = cutAt(root, e.target);
    if (el === on) return;
    stop();
    if (!el) return;
    if (still?.matches) {
      if (!el.title) el.title = el.textContent ?? "";
      return;
    }
    on = el;
    timer = setTimeout(() => {
      if (on !== el) return;
      el.style.textOverflow = "clip";
      glide(el, el.scrollWidth - el.clientWidth);
    }, WAIT);
  });
  root.addEventListener("mouseleave", stop);
}
