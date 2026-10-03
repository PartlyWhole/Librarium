/** Search, backlinks and the Jobs view in the interface. */
import { describe, expect, it } from "vitest";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { search } from "../src/features/search";
import { links } from "../src/features/links";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function boot(): Promise<{ shell: Shell; weil: string; reading: string }> {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const weil = seed("note", "Simone Weil", "Attention is generosity.\n").id;
  const reading = seed("note", "Reading", `See [[Simone Weil|${weil}]] on attention.\n`).id;
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, search, links]);
  last = shell;
  await wait(50);
  return { shell, weil, reading };
}

describe("search", () => {
  it("shows highlighted passages that open their record", async () => {
    const { shell, weil } = await boot();
    shell.router.go("search", { q: "attention" });
    await wait(50);
    const hits = [...document.querySelectorAll<HTMLAnchorElement>("a.hit")];
    expect(hits.length).toBe(2);
    expect(hits[0]!.querySelector("mark")?.textContent?.toLowerCase()).toBe("attention");
    hits.find((h) => h.textContent?.includes("Simone Weil"))!.click();
    expect(shell.router.current().page).toBe("note");
    expect(shell.router.current().params).toMatchObject({ id: weil, at: "0" });
  });

  it("filters by kind", async () => {
    const { shell } = await boot();
    shell.router.go("search", { q: "attention", kind: "item" });
    await wait(50);
    expect(document.querySelector(".empty")?.textContent).toBe("Nothing matches.");
  });
});

describe("backlinks", () => {
  it("list every linking record in the side panel", async () => {
    const { shell, weil } = await boot();
    shell.router.go("note", { id: weil });
    shell.actions.run("shell.toggleSidePanel");
    await wait(80);
    const panel = document.querySelector(".side-panel")!;
    expect(panel.textContent).toContain("Linked from");
    expect([...panel.querySelectorAll(".backlinks a")].map((a) => a.textContent)).toEqual(["Reading"]);
  });
});

describe("jobs", () => {
  it("show in the status bar and the Jobs view, with Retry for failures", async () => {
    const { shell } = await boot();
    const job = { id: "0192f3a4-7c1e-7b2a-9f00-0000000000aa", kind: "index.rebuild", key: "all", title: "Rebuilding the index", attempts: 1, error: null, progress: 0.4, message: null, payload: null, created_ms: 1, updated_ms: 1 };
    mock.emit("event.job", { ...job, state: "running" });
    await wait(10);
    expect(document.querySelector(".status-jobs")?.textContent).toBe("Rebuilding the index 40%");
    mock.state.jobs = [{ ...job, state: "failed", error: "the worker crashed" }];
    mock.emit("event.job", { ...job, state: "failed", error: "the worker crashed" });
    shell.actions.run("shell.toggleSidePanel");
    await wait(10);
    expect(document.querySelector(".status-jobs")?.textContent).toBe("1 failed");
    const panel = document.querySelector(".side-panel")!;
    expect(panel.textContent).toContain("the worker crashed");
    expect([...panel.querySelectorAll(".jobs button")].map((b) => b.textContent)).toEqual(["Retry", "Dismiss"]);
  });
});
