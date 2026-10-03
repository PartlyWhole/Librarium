/**
 * The shell: layout, router, action and key registry, native menu, prefs and app-action undo.
 * Milestone 0: an empty window that checks the backend and the worker are reachable.
 */
import { call, inTauri } from "../backend";
import type { WorkerPong } from "../generated/WorkerPong";

export function startShell(root: HTMLElement): void {
  root.replaceChildren();
  if (!inTauri()) return;
  call<WorkerPong>("worker.ping")
    .then((p) => console.info(`worker ${p.worker_version} (pid ${p.pid}) answered in ${p.round_trip_us} µs`))
    .catch((e) => console.error("worker did not answer", e));
}
