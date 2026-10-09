// Runs in the page being saved, in an isolated world: scrolls through it, waits for pictures,
// removes popups, and reads its clean text and metadata. Returns a JSON string.
// No timers: a hidden window slows them down, more the longer it is hidden and the heavier the
// page (seconds, then far longer), which made heavy pages miss their time limit.
// Hidden windows stretch timers to about a second, so pass the page through without them:
// a message-channel yield lets layout and lazy loaders run between scroll steps.
const yieldTask = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
// Waits by passing messages to itself (not slowed down) until the time is up.
const sleep = (ms) => new Promise((r) => { const end = performance.now() + ms; const tick = () => (performance.now() >= end ? r() : yieldTask().then(tick)); tick(); });
// A frame where there are frames (hidden windows have none), else a short wait.
const frame = () => Promise.race([new Promise((r) => requestAnimationFrame(() => r())), sleep(50)]);
const H = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
const eager = () => document.querySelectorAll("img[loading=lazy], iframe[loading=lazy]").forEach((i) => { i.loading = "eager"; });
eager();
for (let y = 0; y < H() && y < 60000; y += Math.max(400, innerHeight * 2)) { scrollTo(0, y); for (let k = 0; k < 3; k++) await yieldTask(); }
scrollTo(0, H());
await frame();
eager();
scrollTo(0, 0);
await sleep(300);
await Promise.race([Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener("load", r); i.addEventListener("error", r); }))), sleep(3000)]);
// Finish every transition and animation now: pages that fade text in as it is scrolled to
// would otherwise be printed half-way, or not at all.
const still = document.createElement("style");
still.textContent = "*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important}";
document.documentElement.appendChild(still);
await frame();
const all = () => (document.body ? [...document.body.querySelectorAll("*")] : []);
// Popups over the page (subscribe prompts, cookie notices, sign-in walls drawn as dialogs):
// fixed or sticky and covering much of the window, or plainly a dialog or a notice; or a
// floating box stacked high above the page and covering much of the window.
const NOTICE = /cookie|consent|gdpr|subscribe|newsletter|signup|sign-up|modal|popup|pop-up|overlay|backdrop|paywall|interstitial|lightbox/i;
const DIALOG = "dialog,[role=dialog],[role=alertdialog],[aria-modal=true]";
// `within`: only these elements (and what they contain) are looked at; omitted, the whole page.
let pageText = 0;
const unpopup = (within) => {
  if (!document.body) return;
  const win = innerWidth * innerHeight;
  if (!within) pageText = (document.body.textContent || "").length;
  const small = (el) => (el.textContent || "").length < pageText * 0.5;
  // Dialogs go whether shown or not: a popup may still be fading in (hidden windows pause the
  // scripts that animate it) and only appear when the page is printed. Never one that holds
  // most of the page's text (a page shown as a dialog).
  const dialogs = within ? within.flatMap((el) => [...(el.matches(DIALOG) ? [el] : []), ...el.querySelectorAll(DIALOG)]) : [...document.querySelectorAll(DIALOG)];
  for (const d of dialogs) if (d.isConnected && small(d)) d.remove();
  // Large subtrees (a page rendering its content) are looked at only at their top.
  const candidates = within ? within.flatMap((el) => (el.isConnected ? [el, ...(el.getElementsByTagName("*").length < 400 ? el.querySelectorAll("*") : [])] : [])) : document.body.querySelectorAll("*");
  for (const el of candidates) {
    if (!el.isConnected) continue;
    const cs = getComputedStyle(el);
    const pos = cs.position;
    if (pos !== "fixed" && pos !== "sticky" && pos !== "absolute") continue;
    // Not laid out at all: the watcher below sees it when it is.
    if (cs.display === "none") continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    const named = el.matches(DIALOG) || NOTICE.test(`${el.id} ${typeof el.className === "string" ? el.className : ""}`);
    const z = parseInt(cs.zIndex, 10) || 0;
    const popup = pos === "absolute" ? z >= 100 && (area > win * 0.15 || named) : area > win * 0.25 || named;
    if (popup && small(el)) el.remove();
  }
  // A popup may have locked scrolling; undo that (only when needed, so the watcher settles).
  for (const e of [document.documentElement, document.body]) {
    const cs = getComputedStyle(e);
    if (cs.overflow !== "visible" && cs.overflowY !== "visible") e.style.setProperty("overflow", "visible", "important");
    if (cs.position === "fixed") e.style.setProperty("position", "static", "important");
  }
};
unpopup();
// Popups often come late (after a delay, or on reaching the end of the page): watch until the
// page has been saved, and remove each as it appears. Only what changed is looked at, so busy
// pages (ads, players) stay fast. The saver sweeps the whole page once more before printing.
let changed = new Set();
new MutationObserver((records) => {
  const first = changed.size === 0;
  for (const m of records) {
    if (m.type === "childList") m.addedNodes.forEach((n) => n.nodeType === 1 && changed.add(n));
    else if (m.target.nodeType === 1) changed.add(m.target);
  }
  if (!first || changed.size === 0) return;
  queueMicrotask(() => {
    const els = [...changed];
    changed = new Set();
    unpopup(els);
  });
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "open", "hidden", "aria-modal", "role"] });
window.__librariumUnpopup = unpopup;
// Text that a reveal-on-scroll script left transparent (in the flow of the page, unlike menus).
for (const el of all()) {
  const cs = getComputedStyle(el);
  if ((parseFloat(cs.opacity) < 0.05 || cs.visibility === "hidden") && (cs.position === "static" || cs.position === "relative") && cs.display !== "none" && (el.textContent || "").trim().length > 20) {
    el.style.setProperty("opacity", "1", "important");
    el.style.setProperty("visibility", "visible", "important");
    el.style.setProperty("transform", "none", "important");
  }
}
await frame();
const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || null;
// The main text: the candidate holding the most text (the first <article> may be a card).
const size = (el) => (el.innerText || "").length;
const candidates = [...document.querySelectorAll("article, main, [role=main], [itemprop=articleBody], .post-content, .entry-content, .article-body")];
let main = candidates.sort((a, b) => size(b) - size(a))[0] || document.body;
if (document.body && size(main) < Math.min(500, size(document.body) * 0.2)) main = document.body;
// Soft hyphens and zero-width characters would split words in the stored text.
const tidy = (s) => s.replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g, "");
const clean = (el) => {
  if (!el) return "";
  const c = el.cloneNode(true);
  c.querySelectorAll("script,style,noscript,nav,footer,aside,form,iframe,svg,button,[aria-hidden=true]").forEach((n) => n.remove());
  return tidy(c.innerText || c.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
};
const nav = performance.getEntriesByType("navigation")[0];
const shown = (img) => { const r = img.getBoundingClientRect(); return img.naturalWidth > 32 && img.naturalHeight > 32 && r.width > 32 && r.height > 32 && getComputedStyle(img).visibility !== "hidden"; };
return JSON.stringify({
  final_url: location.href,
  status: nav && nav.responseStatus ? nav.responseStatus : null,
  title: document.title || "",
  author: meta('meta[name="author"]') || meta('meta[property="article:author"]'),
  publication: meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]'),
  published: meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || document.querySelector("time[datetime]")?.getAttribute("datetime") || null,
  language: document.documentElement.lang || null,
  text: clean(main),
  visible_text: tidy(document.body ? document.body.innerText : "").trim(),
  html: document.documentElement.outerHTML.slice(0, 2000000),
  images: [...document.images].filter(shown).length,
  drawn: Math.min(1, [...document.querySelectorAll("canvas")].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 100 && r.height > 100).reduce((a, r) => a + r.width * r.height, 0) / Math.max(1, Math.max(document.documentElement.scrollWidth, innerWidth) * Math.min(H(), Math.max(innerHeight, 1) * 3))),
  width: Math.max(document.documentElement.scrollWidth, innerWidth),
  height: H(),
});
