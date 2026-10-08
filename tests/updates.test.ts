/** Updates (R-069, decision 0072): looked for by themselves, asked about, installed, restarted. */
import { describe, expect, it } from "vitest";
import { mock } from "./mock/backend";
import { createShell } from "../src/shell/shell";
import { updatesWith } from "../src/features/updates";
import { menuSpec } from "../src/shell/menu";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const methods = () => mock.state.calls.map((c) => c.method).filter((m) => m.startsWith("updates.") || m === "app.restart");
const dialog = () => document.querySelector("dialog.modal[open]") as HTMLDialogElement | null;
const press = (label: string) => [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === label)!.click();

function start(firstMs = 10) {
  mock.reset();
  mock.state.folder = "/lib";
  document.body.innerHTML = '<div id="app"></div>';
  return createShell(document.getElementById("app")!, [updatesWith({ firstMs, everyMs: 60 })]);
}

describe("updates", () => {
  it("says when a newer version is published, and installs and restarts only when asked", async () => {
    const shell = start();
    mock.state.update = { version: "0.2.0", current: "0.1.0", notes: "Footnotes in popovers." };
    await wait(40);
    // A quiet note, not a dialog in the middle of work.
    expect(dialog()).toBeNull();
    const toast = document.querySelector(".toast")!;
    expect(toast.textContent).toContain("Librarium 0.2.0 is available.");
    (toast.querySelector(".toast-action") as HTMLButtonElement).click();
    await wait(10);
    expect(dialog()!.textContent).toContain("You have 0.1.0");
    expect(dialog()!.textContent).toContain("Footnotes in popovers.");
    press("Install");
    await wait(20);
    expect(methods()).toContain("updates.install");
    expect(methods()).not.toContain("app.restart");
    expect(dialog()!.textContent).toContain("Restart to use Librarium 0.2.0?");
    press("Restart now");
    await wait(20);
    expect(methods()).toContain("app.restart");
    shell.destroy();
  });

  it("asks again only by hand after Later, and says when there is nothing new", async () => {
    const shell = start();
    mock.state.update = { version: "0.2.0", current: "0.1.0", notes: "" };
    await wait(40);
    (document.querySelector(".toast .toast-action") as HTMLButtonElement).click();
    await wait(10);
    press("Later");
    await wait(10);
    document.querySelector(".toast")?.remove();
    // The daily look doesn't offer the same version again.
    await wait(120);
    expect(document.querySelector(".toast")?.textContent ?? "").not.toContain("0.2.0");
    expect(methods().filter((m) => m === "updates.check").length).toBeGreaterThan(1);
    expect(methods()).not.toContain("updates.install");
    // Librarium ▸ Check for Updates… does.
    const item = menuSpec(shell.actions).find((s) => s.title === "Librarium")!.entries.find((e) => e.kind === "item" && e.id === "updates.check");
    expect(item && item.kind === "item" && item.text).toBe("Check for Updates…");
    await shell.actions.run("updates.check");
    await wait(10);
    expect(dialog()!.textContent).toContain("Librarium 0.2.0 is available");
    press("Later");
    await wait(10);
    mock.state.update = null;
    await shell.actions.run("updates.check");
    await wait(10);
    expect(dialog()!.textContent).toContain("You have the latest version (0.1.0).");
    press("OK");
    shell.destroy();
  });

  it("says plainly when the release page can't be reached (by hand only)", async () => {
    const shell = start(10_000);
    mock.state.updateFails = "offline";
    await shell.actions.run("updates.check");
    await wait(10);
    expect(dialog()!.textContent).toContain("Couldn’t check for updates");
    expect(dialog()!.textContent).toContain("offline");
    press("OK");
    shell.destroy();
  });
});
