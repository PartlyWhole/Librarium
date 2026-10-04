/** Version history: a note's versions in the side panel, compared and restored; deleted notes brought back. */
import { describe, expect, it } from "vitest";
import { call, mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { archive } from "../src/features/archive";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function boot() {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const n = seed("note", "Draft", "first line\nsecond line\n");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, archive]);
  last = shell;
  await wait(60);
  return { shell, n };
}

describe("version history", () => {
  it("lists a note's versions, compares one with now, restores it, and undoes the restore", async () => {
    const { shell, n } = await boot();
    // Two versions: as seeded (recorded on the first save) and as edited.
    await call("records.save", { id: n.id, base_version: shell.records.get(n.id)!.version, body: "first line\nsecond line\n" }).catch(() => null);
    const w = await call<{ version: string; seq: number }>("records.save", { id: n.id, base_version: mock.state.records.get(n.id)!.info.version, body: "first line\nchanged\n" });
    await shell.records.waitFor(w.seq);
    shell.openRecord(n.id);
    await wait(40);
    shell.actions.run("notes.history");
    await wait(60);
    const items = () => [...document.querySelectorAll<HTMLElement>(".history-item")];
    expect(items().length).toBeGreaterThanOrEqual(2);
    expect(items()[0]!.textContent).toContain("Current");
    // The older one, compared with now.
    items()[items().length - 1]!.click();
    await wait(40);
    const dialog = document.querySelector("dialog[open]")!;
    expect(dialog.querySelector(".diff-line.delete")?.textContent).toContain("second line");
    expect(dialog.querySelector(".diff-line.insert")?.textContent).toContain("changed");
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Restore this version")!.click();
    await wait(60);
    expect(mock.state.records.get(n.id)!.body).toBe("first line\nsecond line\n");
    await shell.undo.undoLast();
    await wait(40);
    expect(mock.state.records.get(n.id)!.body).toBe("first line\nchanged\n");
  });

  it("lists notes deleted outside the app on the Archive page, and brings them back", async () => {
    const { shell, n } = await boot();
    await call("records.save", { id: n.id, base_version: shell.records.get(n.id)!.version, body: "keep me\n" });
    // Deleted in Finder: the record is gone, its history stays.
    mock.state.records.delete(n.id);
    mock.emit("event.change", { seq: 999, id: n.id, kind: "note", op: "removed", origin: "outside" });
    await wait(30);
    shell.router.go("archive");
    await wait(60);
    const section = document.querySelector(".recently-deleted")!;
    expect(section.textContent).toContain("Deleted outside Librarium");
    expect(section.textContent).toContain("Draft");
    [...section.querySelectorAll("button")].find((b) => b.textContent?.includes("Bring back"))!.click();
    await wait(60);
    expect(mock.state.records.get(n.id)?.body).toBe("keep me\n");
    expect(shell.records.get(n.id)).toBeDefined();
  });
});
