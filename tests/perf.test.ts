/** The interface starts and renders 10,000 notes quickly (part of the 1.5 s cold-start budget). */
import { it, expect } from "vitest";
import { mock, seed } from "./mock/backend";
import { createShell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { daily } from "../src/features/daily";
import { library } from "../src/features/library";

it("starts with 10,000 notes", async () => {
  mock.reset();
  mock.state.folder = "/lib";
  for (let i = 0; i < 10_000; i++) seed("note", `Note ${i}`, "", {}, `Folder ${i % 40}`);
  document.body.innerHTML = '<div id="app"></div>';
  const t = performance.now();
  const shell = createShell(document.getElementById("app")!, [notes, daily, library]);
  while (shell.timings.readyMs === undefined) await new Promise((r) => setTimeout(r, 5));
  const ms = performance.now() - t;
  console.log(`interface ready with 10,000 notes in ${ms.toFixed(0)} ms`);
  expect(shell.records.list().length).toBe(10_000);
  expect(ms).toBeLessThan(1000);
  shell.destroy();
}, 30_000);
