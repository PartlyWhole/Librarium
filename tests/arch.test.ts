/**
 * Writes the interface's slot contributors for the architecture report
 * (target/arch/shell-slots.json), and checks every slot used is defined.
 */
import { it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mock } from "./mock/backend";
import { createShell } from "../src/shell/shell";
import { ARCHIVER, SHELL_SLOTS } from "../src/shell/slots";
import { notes } from "../src/features/notes";
import { daily } from "../src/features/daily";
import { library } from "../src/features/library";
import { search } from "../src/features/search";
import { archive } from "../src/features/archive";
import { boards } from "../src/features/boards";
import { captures } from "../src/features/captures";
import { links } from "../src/features/links";
import { menuSpec } from "../src/shell/menu";

it("records the interface's slot contributors", () => {
  mock.reset();
  document.body.innerHTML = '<div id="app"></div>';
  // Every feature, as src/main.ts composes them.
  const shell = createShell(document.getElementById("app")!, [notes, boards, daily, library, captures, search, links, archive]);
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
    "shell.hiding-fields": shell.hidingFields.contributors(),
    "shell.record-actions": shell.recordActions.contributors(),
    "shell.editor-extensions": shell.editorExtensions.contributors(),
    "shell.reader-engines": shell.readerEngines.contributors(),
    "shell.embeds": shell.embeds.contributors(),
    "shell.record-looks": shell.looks.contributors(),
    [ARCHIVER]: shell.slot(ARCHIVER).contributors(),
  };
  for (const s of Object.keys(slots)) expect([...SHELL_SLOTS, "shell.openers"]).toContain(s);
  const dir = path.resolve(import.meta.dirname, "../target/arch");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "shell-slots.json"), JSON.stringify(slots, null, 2));
  shell.destroy();
});
