/**
 * The Settings page (⌘,), and the appearance it sets. The Captures and Version sections are
 * filled by those features with `setSettingsSection`.
 */
import { call } from "../backend";
import { errorText, h, replace } from "../ui/dom";
import { effect } from "../ui/signal";
import { toast } from "../ui/toast";
import { library, chooseFolder, isOpen } from "./library";
import { rebuildIndex } from "./jobs";
import { pref } from "./prefs";

export const theme = pref<"system" | "light" | "dark">("ui.theme", "system");
const textSize = pref("ui.textSize", 16);
/** The hour the day starts (a daily note written after midnight belongs to the day before). */
const dayStart = pref("daily.dayStart", 4);

effect(() => {
  const t = theme();
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
});
effect(() => document.documentElement.style.setProperty("--reading-size", `${textSize()}px`));

type Render = (host: HTMLElement) => (() => void) | void;
const later: Record<"captures" | "version", { title: string; render: Render } | null> = { captures: null, version: null };

/** Fills one of the sections other features own. */
export function setSettingsSection(id: "captures" | "version", title: string, render: Render): void {
  later[id] = { title, render };
}

export const revealLogs = () => void call("app.revealLogs").catch((e) => toast(errorText(e)));
export const revealFolder = () => void call("folder.reveal").catch((e) => toast(errorText(e)));

function radios(name: string, legend: string, options: [string, string][], value: string, set: (v: string) => void): HTMLElement {
  return h("fieldset", { class: "field" }, h("legend", null, legend),
    options.map(([v, label]) => h("label", { class: "radio" }, h("input", { type: "radio", name, value: v, checked: v === value, onchange: () => set(v) }), label)));
}

function sections(): [string, Render][] {
  const row = (...buttons: [string, () => void][]) => h("div", { class: "row" }, buttons.map(([label, run]) => h("button", { class: "button", onclick: run }, label)));
  return [
    ["Appearance", (host) => replace(host,
      radios("theme", "Theme", [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]], theme.peek(), (v) => theme.set(v as "system" | "light" | "dark")),
      radios("text", "Text size", [["14", "Small"], ["16", "Medium"], ["18", "Large"]], String(textSize.peek()), (v) => textSize.set(Number(v))))],
    ["Library folder", (host) => effect(() => replace(host,
      h("p", { class: "muted" }, library()?.path ?? "Not chosen yet."),
      row(["Choose another folder…", () => void chooseFolder()], ...(isOpen() ? [["Show in Finder", revealFolder] as [string, () => void]] : []))))],
    ["Daily notes", (host) => {
      const select = h("select", { id: "day-start", onchange: () => dayStart.set(Number(select.value)) }, [0, 1, 2, 3, 4, 5, 6].map((hr) => h("option", { value: String(hr), selected: hr === dayStart.peek() }, hr === 0 ? "Midnight" : `${hr} a.m.`)));
      replace(host, h("div", { class: "field" }, h("label", { for: "day-start" }, "The day starts at "), select), h("p", { class: "muted small" }, "Writing after midnight but before this hour lands on the day before."));
    }],
    ["Index", (host) => replace(host, h("p", { class: "muted small" }, "The index is rebuilt from your files whenever it is missing. Rebuilding never changes your files."), row(["Rebuild index", () => void rebuildIndex()]))],
    ...[later.captures, later.version].filter((s) => !!s).map((s): [string, Render] => [s.title, s.render]),
    ["Troubleshooting", (host) => replace(host, row(["Reveal logs", revealLogs]))],
  ];
}

export function renderSettings(host: HTMLElement): () => void {
  const disposers: (() => void)[] = [];
  replace(host, h("h1", { class: "page-title" }, "Settings"), sections().map(([title, render]) => {
    const body = h("div");
    const d = render(body);
    if (d) disposers.push(d);
    return h("section", { class: "settings-section" }, h("h2", null, title), body);
  }));
  return () => disposers.forEach((d) => d());
}
