/**
 * Updates: new versions are published as GitHub releases (`npm run release`). The app looks
 * for one 20 s after it starts (once the library has opened) and then daily, and asks before
 * installing; once installed, it offers to restart, saving first as when quitting.
 * Librarium ▸ Check for Updates… looks now, and also says when there is nothing new.
 */
import { appVersion, checkForUpdate, restartApp, type AppUpdate } from "../backend";
import { defineAction } from "../app/actions";
import { saveAll } from "../app/quit";
import { setSettingsSection } from "../app/settings";
import { showStatus } from "../app/status";
import { ask } from "../ui/dialog";
import { errorText, h, replace } from "../ui/dom";
import { toast } from "../ui/toast";
import { RefreshCw } from "lucide";
import "./updates.css";

const FIRST = 20_000;
const DAY = 24 * 60 * 60 * 1000;

let busy = false;
/** Versions the user said Later to: not offered again by themselves until the app restarts. */
const declined = new Set<string>();
/** A version installed but not yet running. */
let installed: string | null = null;

const ok = (title: string, text: string) => void ask(title, h("p", null, text), [{ label: "OK", value: true, primary: true }]);

/** Looks for a newer version; by hand, it also says when there is none or the check failed. */
async function look(byHand: boolean): Promise<void> {
  if (busy) return;
  if (installed) return void (byHand && offerRestart(installed));
  busy = true;
  if (byHand) showStatus("Checking for updates…", 0);
  let u: AppUpdate | null;
  try {
    u = await checkForUpdate();
  } catch (e) {
    console.warn(`checking for updates failed: ${errorText(e)}`);
    if (byHand) {
      showStatus("");
      ok("Couldn’t check for updates", `Librarium couldn’t reach its release page. Check the internet connection and try again. (${errorText(e)})`);
    }
    return;
  } finally {
    busy = false;
  }
  if (byHand) showStatus("");
  if (!u) {
    if (byHand) ok("Librarium is up to date", `You have the latest version (${await appVersion()}).`);
    return;
  }
  if (byHand) return offer(u);
  if (declined.has(u.version)) return;
  const found = u;
  toast(`Librarium ${u.version} is available`, { action: { label: "Update…", run: () => void offer(found) }, ms: 20_000 });
}

/** What's new, then Install / Later; progress shows in the status bar. */
async function offer(u: AppUpdate): Promise<void> {
  const notes = u.notes.trim();
  const choice = await ask(`Librarium ${u.version} is available`, [
    h("p", null, `You have ${u.current}. Installing takes a moment; then Librarium can restart, with your work saved first.`),
    notes ? h("div", { class: "update-notes" }, h("h3", null, "What’s new"), h("p", null, notes)) : null,
  ], [{ label: "Later", value: "later" as const }, { label: "Install", value: "install" as const, primary: true }]);
  if (choice !== "install") return void declined.add(u.version);
  busy = true;
  const downloading = `Downloading Librarium ${u.version}…`;
  showStatus(downloading, 0);
  try {
    await u.install((f) => showStatus(f == null ? downloading : `${downloading} ${Math.round(f * 100)}%`, 0));
  } catch (e) {
    showStatus("");
    ok("The update couldn’t be installed", `Librarium ${u.current} is unchanged. (${errorText(e)})`);
    return;
  } finally {
    busy = false;
  }
  installed = u.version;
  showStatus(`Librarium ${u.version} is installed; it starts the next time Librarium opens.`, 15_000);
  await offerRestart(u.version);
}

async function offerRestart(version: string): Promise<void> {
  const now = await ask(`Restart to use Librarium ${version}?`, h("p", null, "Your work is saved first. If you choose Later, the new version starts the next time you open Librarium."), [
    { label: "Later", value: false },
    { label: "Restart now", value: true, primary: true },
  ]);
  if (!now) return;
  await saveAll();
  await restartApp();
}

defineAction({
  id: "updates.check",
  title: "Check for Updates…",
  menu: { name: "app", group: 0.1 },
  icon: RefreshCw,
  run: () => look(true),
});

setSettingsSection("version", "Version", (host) => {
  const version = h("span", null, "…");
  void appVersion().then((v) => (version.textContent = v));
  replace(host,
    h("p", null, "Librarium ", version, ". It looks for a newer version once a day and asks before installing it."),
    h("button", { class: "button", type: "button", onclick: () => void look(true) }, "Check for Updates…"));
});

setTimeout(function again() {
  void look(false);
  setTimeout(again, DAY);
}, FIRST);
