/** The Library page: a right-click on an item offers its menu. */
import { describe, expect, it } from "vitest";
import { mock, seed } from "./mock/backend";
import { createShell } from "../src/shell/shell";
import { library } from "../src/features/library";
import { archive } from "../src/features/archive";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the Library page", () => {
  it("has a context menu on each item, from which it can be archived", async () => {
    mock.reset();
    mock.state.folder = "/lib";
    const item = seed("item", "A saved essay", "", { "library.format": "web" });
    document.body.innerHTML = '<div id="app"></div>';
    const shell = createShell(document.getElementById("app")!, [library, archive]);
    await wait(50);
    shell.router.go("library");
    await wait(30);
    const li = [...document.querySelectorAll(".files-body [role=option]")].find((x) => x.textContent?.includes("A saved essay"))!;
    li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
    const items = [...document.querySelectorAll(".context-menu [role=menuitem]")];
    expect(items.map((b) => b.textContent)).toEqual(["Open", "Rename", "Move to folder…", "Archive"]);
    (items[3] as HTMLElement).click();
    await wait(30);
    expect(document.querySelector(".files-body")?.textContent ?? "").not.toContain("A saved essay");
    expect(shell.records.get(item.id)?.fields["archive.at"]).toBeDefined();
    shell.destroy();
  });
});
