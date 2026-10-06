/** A book's layout (R-066, decision 0070): one setting, in the Aa panel and the View menu. */
import { describe, expect, it } from "vitest";
import { readSettings, settingsPanel, toPreferences, DEFAULT_SETTINGS, type ReadingSettings } from "../src/reader/epub/settings";
import { mock, seed } from "./mock/backend";
import { createShell } from "../src/shell/shell";
import { library } from "../src/features/library";
import { menuSpec } from "../src/shell/menu";

const stored = (v: unknown) => ({ get: () => v, set: () => {} });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the layout setting", () => {
  it("carries over the settings from before: scrolling, and pages one or two", () => {
    expect(readSettings(stored({ scroll: true, columns: "one" })).layout).toBe("scroll");
    expect(readSettings(stored({ scroll: false, columns: "one" })).layout).toBe("single");
    expect(readSettings(stored({ scroll: false, columns: "auto" })).layout).toBe("two");
    expect(readSettings(stored({ layout: "scroll" })).layout).toBe("scroll");
    expect(readSettings(stored({ layout: "single" })).layout).toBe("single");
    expect(readSettings(stored({ layout: "sideways" })).layout).toBe("two");
    expect(readSettings(undefined).layout).toBe("two");
  });

  it("becomes Readium's preferences, with side margins when scrolling", () => {
    const p = (layout: ReadingSettings["layout"]) => toPreferences({ ...DEFAULT_SETTINGS, layout });
    expect([p("single").scroll, p("single").columnCount]).toEqual([false, 1]);
    expect([p("two").scroll, p("two").columnCount]).toEqual([false, null]);
    expect(p("scroll").scroll).toBe(true);
    expect(p("scroll").scrollPaddingLeft).toBe(p("scroll").pageGutter);
    expect(p("scroll").scrollPaddingRight).toBe(p("scroll").pageGutter);
  });
});

describe("the Aa panel", () => {
  it("puts the layout under the text size, and the fonts in one row", () => {
    let applied: ReadingSettings | null = null;
    let shown = 1;
    const panel = settingsPanel({ ...DEFAULT_SETTINGS }, (s) => (applied = s), () => {}, false, () => shown);
    const order = [...panel.children].map((c) => c.className.split(" ").find((x) => x.startsWith("aa-") || x.startsWith("epub-")) ?? c.tagName);
    expect(order.slice(0, 3)).toEqual(["aa-sizes", "aa-layout", "aa-note"]);
    const radios = [...panel.querySelectorAll(".aa-layout [role=radio]")];
    expect(radios.map((b) => [b.textContent, b.getAttribute("aria-checked")])).toEqual([["Single page", "false"], ["Two pages", "true"], ["Scroll", "false"]]);
    expect(panel.querySelector(".aa-layout")?.getAttribute("aria-label")).toBe("Layout");
    // Two pages but only room for one: it says so, until there is room.
    const note = panel.querySelector(".aa-note") as HTMLElement;
    expect(note.hidden).toBe(false);
    shown = 2;
    panel.dispatchEvent(new Event("laidout"));
    expect(note.hidden).toBe(true);
    (radios[2] as HTMLElement).click();
    expect(applied!.layout).toBe("scroll");
    expect(radios[2]!.getAttribute("aria-checked")).toBe("true");
    // The fonts: one labelled list, not nine rows; no separate scrolling switch or Pages row.
    const font = panel.querySelector("select.aa-font-pick") as HTMLSelectElement;
    expect(font.getAttribute("aria-label")).toBe("Font");
    expect(font.options.length).toBe(9);
    expect(panel.querySelector(".aa-fonts")).toBeNull();
    expect(panel.textContent).not.toContain("Scrolling view");
    expect(panel.textContent).not.toContain("Two when wide");
    font.value = "georgia";
    font.dispatchEvent(new Event("change"));
    expect(applied!.font).toBe("georgia");
  });

  it("shows no layout for a book with fixed pages", () => {
    const panel = settingsPanel({ ...DEFAULT_SETTINGS }, () => {}, () => {}, true);
    expect(panel.querySelector(".aa-layout")).toBeNull();
  });
});

describe("the View menu", () => {
  it("has the layouts, with shortcuts, while a book is shown", async () => {
    mock.reset();
    mock.state.folder = "/lib";
    const book = seed("item", "A book", "", { "library.format": "epub" });
    const pdf = seed("item", "A paper", "", { "library.format": "pdf" });
    document.body.innerHTML = '<div id="app"></div>';
    const shell = createShell(document.getElementById("app")!, [library]);
    await wait(50);
    const items = () => menuSpec(shell.actions).find((s) => s.title === "View")!.entries.flatMap((e) => (e.kind === "item" && e.id.startsWith("library.layout.") ? [[e.text, e.accelerator, e.enabled]] : []));
    shell.router.go("item", { id: pdf.id });
    await wait(30);
    expect(items()).toEqual([["Single Page", "CmdOrCtrl+Ctrl+1", false], ["Two Pages", "CmdOrCtrl+Ctrl+2", false], ["Scrolling", "CmdOrCtrl+Ctrl+3", false]]);
    shell.router.go("item", { id: book.id });
    await wait(30);
    expect(items().map((x) => x[2])).toEqual([true, true, true]);
    shell.destroy();
  });
});
