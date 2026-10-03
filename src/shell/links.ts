/**
 * Links to the web never take the window away from the app. A click on one (in a saved page,
 * a PDF, a book or a note) asks first: where it goes, what it said, where it was, and whether
 * to open it in the browser, copy it, or stay. The backend also stops any navigation that gets
 * past this, and sends it here (`event.openLink`).
 */
import { call, on } from "../backend";
import { ask } from "../kit/dialog";
import { h } from "../kit/dom";
import { toast } from "../kit/toast";

/** What an address is: one to ask about (web, mail), or none of ours to handle. */
export function externalUrl(href: string | null | undefined): URL | null {
  if (!href) return null;
  try {
    const u = new URL(href, location.href);
    if (u.protocol === "mailto:") return u;
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // The app's own pages (the dev server, the bundled app) are not "the web".
    if (u.origin === location.origin || ["localhost", "127.0.0.1", "tauri.localhost"].includes(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

/** A link's words, when they differ from where it goes (and so are worth showing). */
function wordsOf(text: string | undefined, u: URL): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t === u.href || t === u.href.replace(/\/$/, "")) return null;
  return t.length > 140 ? `${t.slice(0, 140)}…` : t;
}

/** A link whose words look like another site's address than the one it goes to. */
function misleading(text: string | null, u: URL): string | null {
  if (!text || u.protocol === "mailto:") return null;
  const m = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i.exec(text);
  if (!m) return null;
  const said = m[1]!.toLowerCase().replace(/^www\./, "");
  const goes = u.hostname.toLowerCase().replace(/^www\./, "");
  return said === goes || goes.endsWith(`.${said}`) || said.endsWith(`.${goes}`) ? null : said;
}

let asking = false;

/** Asks whether to open an address in the browser. */
export async function askToOpen(href: string, o: { text?: string; from?: string } = {}): Promise<void> {
  const u = externalUrl(href);
  if (!u || asking) return;
  asking = true;
  try {
    const mail = u.protocol === "mailto:";
    const words = wordsOf(o.text, u);
    const other = misleading(words, u);
    const where = mail ? decodeURIComponent(u.pathname) : u.hostname.replace(/^www\./, "");
    const body = h("div", { class: "link-ask" },
      words ? h("p", null, "The link says “", h("strong", null, words), "”.") : null,
      h("p", { class: "link-where" }, mail ? "It writes an email to " : "It goes to ", h("strong", null, where), o.from ? ` (from “${o.from}”)` : "", "."),
      h("p", { class: "link-url", title: u.href }, u.href),
      other ? h("p", { class: "notice" }, `Careful: its words name ${other}, but it goes to ${where}.`) : null,
      !mail && u.protocol === "http:" ? h("p", { class: "muted small" }, "This address isn’t secure (http, not https).") : null,
      h("p", { class: "muted small" }, mail ? "It opens in your mail app." : "It opens in your web browser; Librarium stays as it is."),
    );
    const choice = await ask<"open" | "copy" | "stay">(mail ? "Write this email?" : "Open this link in your browser?", body, [
      { label: "Cancel", value: "stay" },
      { label: "Copy link", value: "copy" },
      { label: mail ? "Open in Mail" : "Open in browser", value: "open", primary: true },
    ]);
    if (choice === "copy") {
      await navigator.clipboard.writeText(mail ? decodeURIComponent(u.pathname) : u.href).then(() => toast("Link copied."), () => toast("The link couldn’t be copied."));
    } else if (choice === "open") {
      await call("app.openUrl", { url: u.href }).catch((e: { message?: string }) => toast(e?.message ?? String(e)));
    }
  } finally {
    asking = false;
  }
}

/**
 * Catches links to the web anywhere in the window (and links other parts report with an
 * `open-link` event, such as a book's pages in their own frame). Returns a disposer.
 */
export function guardLinks(from: () => string | undefined): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented && e.type === "click") return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    if (!externalUrl(a.getAttribute("href"))) return;
    if (e.type === "auxclick" && e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    void askToOpen(a.href, { text: a.textContent ?? a.title, from: from() });
  };
  const onReported = (e: Event) => {
    const d = (e as CustomEvent<{ url: string; text?: string }>).detail;
    if (d?.url) void askToOpen(d.url, { text: d.text, from: from() });
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("auxclick", onClick, true);
  document.addEventListener("open-link", onReported);
  const off = on("event.openLink", (p) => void askToOpen((p as { url: string }).url, { from: from() }));
  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("auxclick", onClick, true);
    document.removeEventListener("open-link", onReported);
    off();
  };
}
