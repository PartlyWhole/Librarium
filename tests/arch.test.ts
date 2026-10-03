/**
 * Writes the interface's slot contributors for the architecture report
 * (target/arch/shell-slots.json), and checks every slot used is defined.
 */
import { it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mock } from "./mock/backend";
import { createShell } from "../src/shell/shell";
import { SHELL_SLOTS, NOTE_GROUPS } from "../src/shell/slots";
import { notes } from "../src/features/notes";
import { daily } from "../src/features/daily";
import { library } from "../src/features/library";
import { search } from "../src/features/search";
import { archive } from "../src/features/archive";
import { menuSpec } from "../src/shell/menu";

it("records the interface's slot contributors", () => {
  mock.reset();
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, daily, library, search, archive]);
  const owner = new Map(shell.actions.registry.list().map((e) => [e.id, e.contributor]));
  const slots: Record<string, [string, string][]> = {
    "shell.pages": shell.pages.contributors(),
    "shell.actions": shell.actions.registry.contributors(),
    "shell.keys": shell.actions.all().filter((a) => a.keys?.length).map((a) => [a.keys![0]!, owner.get(a.id)!]),
    "shell.menu-items": menuSpec(shell.actions).flatMap((s) => s.entries).flatMap((e) => (e.kind === "item" ? [[e.id, owner.get(e.id)!] as [string, string]] : [])),
    "shell.sidebar-sections": shell.sidebar.contributors(),
    "shell.side-panel-sections": shell.sidePanel.contributors(),
    "shell.settings-sections": shell.settings.contributors(),
    "shell.openers": shell.openers.contributors(),
    "shell.editor-extensions": [],
    "shell.reader-engines": [],
    [NOTE_GROUPS]: shell.slot(NOTE_GROUPS).contributors(),
  };
  for (const s of Object.keys(slots)) expect([...SHELL_SLOTS, "shell.openers"]).toContain(s);
  const dir = path.resolve(import.meta.dirname, "../target/arch");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "shell-slots.json"), JSON.stringify(slots, null, 2));
  shell.destroy();
});
