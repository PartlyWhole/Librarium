/**
 * A database the app downloads once, when asked (word origins, the Bible): its status, kept
 * current from the backend's events, and the view that offers the download and shows it going.
 */
import { call, on } from "../backend";
import { errorText, h } from "../ui/dom";
import { icon } from "../ui/icon";
import { signal, type Signal } from "../ui/signal";
import { toast } from "../ui/toast";
import type { DataStatus } from "../types";
import { Download } from "lucide";

/** The status of the dataset whose methods are `<prefix>.status`, `.download` and `.cancel`. */
export function dataStatus(prefix: string): Signal<DataStatus | null> {
  const status = signal<DataStatus | null>(null);
  void call<DataStatus>(`${prefix}.status`).then((s) => status.set(s), () => {});
  on<DataStatus>(`${prefix}.status`, (s) => status.set(s));
  return status;
}

const mb = (n: number) => `${Math.round(n / 1_000_000)} MB`;

/** What it is, then Download (or its progress, or why it failed). `name` is lower case ("word origins"). */
export function datasetSetup(prefix: string, s: DataStatus, o: { name: string; about: string }): HTMLElement {
  const about = h("p", { class: "muted small" }, o.about);
  if (s.state === "downloading" || s.state === "unpacking") {
    const done = s.state === "unpacking" ? 1 : s.received / s.download_bytes;
    return h("div", { class: "dataset-setup" }, about,
      h("progress", { class: "dataset-progress", max: "1", value: String(done) }),
      h("p", { class: "small" }, s.state === "unpacking" ? "Unpacking and checking…" : `Downloading ${o.name}: ${mb(s.received)} of ${mb(s.download_bytes)}`),
      s.state === "downloading" ? h("button", { class: "button small", type: "button", onclick: () => void call(`${prefix}.cancel`) }, "Cancel") : null);
  }
  return h("div", { class: "dataset-setup" }, about,
    s.error ? h("p", { class: "small notice-text" }, s.error) : null,
    h("button", { class: "button primary small", type: "button", onclick: () => void call(`${prefix}.download`).catch((e) => toast(errorText(e))) },
      icon(Download, 14), s.error ? "Try again" : `Download ${o.name} (${mb(s.download_bytes)})`),
    h("p", { class: "muted small" }, `Downloaded once from Librarium’s releases on GitHub; ${mb(s.disk_bytes)} on this Mac. Nothing is sent when you use it.`));
}
