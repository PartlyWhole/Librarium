/**
 * Links to the web never take the window away. A click on one, anywhere (a note, a PDF, a
 * saved page, a book reporting it with an `open-link` event), asks first: where it goes, what
 * it said, and whether to open it in the browser, copy it, or stay. The backend stops any
 * navigation that gets past this and reports it as `app.openLink`.
 */
import { call, on } from "../backend";
import { ask } from "../ui/dialog";
import { errorText, h } from "../ui/dom";
import { toast } from "../ui/toast";

/** An address to ask about (web, mail), or null for the app's own. */
function externalUrl(href: string | null | undefined): URL | null {
  if (!href) return null;
  try {
    const u = new URL(href, location.href);
    if (u.protocol === "mailto:") return u;
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
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

/** The site a link's words name, when it isn't the one it goes to. */
function misleading(text: string | null, u: URL): string | null {
  const m = text && u.protocol !== "mailto:" ? /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i.exec(text) : null;
  if (!m) return null;
  const said = m[1]!.toLowerCase().replace(/^www\./, "");
  const goes = u.hostname.toLowerCase().replace(/^www\./, "");
  return said === goes || goes.endsWith(`.${said}`) || said.endsWith(`.${goes}`) ? null : said;
}

let asking = false;

/** Asks whether to open an address in the browser (or mail app). */
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
      h("p", null, mail ? "It writes an email to " : "It goes to ", h("strong", null, where), o.from ? ` (from “${o.from}”)` : "", "."),
      h("p", { class: "link-url", title: u.href }, u.href),
      other ? h("p", { class: "notice" }, `Careful: its words name ${other}, but it goes to ${where}.`) : null,
      !mail && u.protocol === "http:" ? h("p", { class: "muted small" }, "This address isn’t secure (http, not https).") : null,
      h("p", { class: "muted small" }, mail ? "It opens in your mail app." : "It opens in your web browser; Librarium stays as it is."),
    );
    const choice = await ask(mail ? "Write this email?" : "Open this link in your browser?", body, [
      { label: "Cancel", value: "stay" },
      { label: "Copy link", value: "copy" },
      { label: mail ? "Open in Mail" : "Open in browser", value: "open", primary: true },
    ]);
    if (choice === "copy") await navigator.clipboard.writeText(mail ? where : u.href).then(() => toast("Link copied."), () => toast("The link couldn’t be copied."));
    else if (choice === "open") await call("app.openUrl", { url: u.href }).catch((e) => toast(errorText(e)));
  } finally {
    asking = false;
  }
}

/** Catches web links anywhere in the window; `from` names what is shown (for the dialog). */
export function guardLinks(from: () => string | undefined): void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented && e.type === "click") return;
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!a || !externalUrl(a.getAttribute("href")) || (e.type === "auxclick" && e.button !== 1)) return;
    e.preventDefault();
    e.stopPropagation();
    void askToOpen((a as HTMLAnchorElement).href, { text: a.textContent ?? "", from: from() });
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("auxclick", onClick, true);
  document.addEventListener("open-link", (e) => {
    const d = (e as CustomEvent<{ url: string; text?: string }>).detail;
    if (d?.url) void askToOpen(d.url, { text: d.text, from: from() });
  });
  on<{ url: string }>("app.openLink", (p) => void askToOpen(p.url, { from: from() }));
}
