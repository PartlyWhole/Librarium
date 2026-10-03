/** Links to the web ask first, and open in the browser; the window never leaves the app. */
import { describe, expect, it } from "vitest";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { externalUrl } from "../src/shell/links";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function boot() {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const n = seed("note", "A note", "Text.\n");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes]);
  last = shell;
  await wait(60);
  shell.openRecord(n.id);
  await wait(30);
  return shell;
}

/** A link somewhere in the page, clicked. Returns whether the click was stopped. */
function clickLink(href: string, text: string): boolean {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  document.querySelector(".ws-page:not([hidden])")!.appendChild(a);
  const e = new MouseEvent("click", { bubbles: true, cancelable: true });
  a.dispatchEvent(e);
  return e.defaultPrevented;
}

const dialog = () => document.querySelector("dialog[open]") as HTMLDialogElement | null;
const button = (label: string) => [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === label)!;
const opened = () => mock.state.calls.filter((c) => c.method === "app.openUrl").map((c) => (c.params as { url: string }).url);

describe("links to the web", () => {
  it("ask first, saying where they go, and open in the browser only when asked", async () => {
    await boot();
    expect(clickLink("https://www.example.org/essay?x=1", "A fine essay")).toBe(true);
    await wait(10);
    expect(dialog()!.textContent).toContain("Open this link in your browser?");
    expect(dialog()!.textContent).toContain("“A fine essay”");
    expect(dialog()!.textContent).toContain("example.org");
    expect(dialog()!.querySelector(".link-url")!.textContent).toBe("https://www.example.org/essay?x=1");
    expect(dialog()!.textContent).toContain("(from “A note”)");
    button("Cancel").click();
    await wait(10);
    expect(opened()).toEqual([]);
    clickLink("https://www.example.org/essay?x=1", "A fine essay");
    await wait(10);
    button("Open in browser").click();
    await wait(10);
    expect(opened()).toEqual(["https://www.example.org/essay?x=1"]);
  });

  it("warn when a link's words name another site, or it isn't secure", async () => {
    await boot();
    clickLink("http://evil.example.net/login", "Sign in at mybank.com");
    await wait(10);
    expect(dialog()!.textContent).toContain("its words name mybank.com, but it goes to evil.example.net");
    expect(dialog()!.textContent).toContain("isn’t secure");
    button("Cancel").click();
  });

  it("leave the app's own links alone, and ask about links the backend stopped", async () => {
    await boot();
    expect(externalUrl("#top")).toBeNull();
    expect(externalUrl("/notes")).toBeNull();
    expect(externalUrl("javascript:alert(1)")).toBeNull();
    expect(externalUrl("mailto:a@b.org")?.protocol).toBe("mailto:");
    expect(clickLink("#section-2", "Section 2")).toBe(false);
    mock.emit("event.openLink", { url: "https://example.org/stopped" });
    await wait(10);
    expect(dialog()!.querySelector(".link-url")!.textContent).toBe("https://example.org/stopped");
    button("Cancel").click();
  });

  it("from a book's pages (their own frame) ask too", async () => {
    await boot();
    document.dispatchEvent(new CustomEvent("open-link", { detail: { url: "https://example.org/notes", text: "notes" } }));
    await wait(10);
    expect(dialog()!.textContent).toContain("“notes”");
    button("Cancel").click();
  });
});
