/**
 * Updates (R-069, decision 0072): new versions are published to the project's GitHub releases
 * (`npm run release`). The app looks for one a little after it starts and once a day, and asks
 * before installing it; installed, it offers to restart (work is saved first, as when quitting).
 * Librarium ▸ Check for Updates… looks now.
 */
import { appVersion, checkForUpdate, restartApp, type AppUpdate } from "../../backend";
import { ask } from "../../kit/dialog";
import { h, replace } from "../../kit/dom";
import { toast } from "../../kit/toast";
import type { ShellApi } from "../../shell/api";
import { RefreshCw } from "lucide";

const DAY = 24 * 60 * 60 * 1000;

export interface UpdateTiming {
  /** How long after starting the first look is (the app is busy opening the library before). */
  firstMs: number;
  everyMs: number;
}

export function updatesWith(timing: UpdateTiming) {
  return (shell: ShellApi): void => {
    let busy = false;
    /** Versions the user said "Later" to: not offered again by themselves until the app restarts. */
    const later = new Set<string>();
    let installed: string | null = null;

    async function look(byHand: boolean) {
      if (busy) return;
      if (installed) return void (byHand && offerRestart(installed));
      busy = true;
      if (byHand) shell.status.show("Checking for updates…");
      let u: AppUpdate | null;
      try {
        u = await checkForUpdate();
      } catch (e) {
        busy = false;
        const why = String((e as { message?: string }).message ?? e);
        console.warn(`checking for updates failed: ${why}`);
        if (byHand) void ask("Couldn’t check for updates", h("p", null, `Librarium couldn’t reach its release page. Check the internet connection and try again. (${why})`), [{ label: "OK", value: true, primary: true }]);
        return;
      }
      busy = false;
      if (byHand) shell.status.show("", 0);
      if (!u) {
        if (byHand) void appVersion().then((v) => ask("Librarium is up to date", h("p", null, `You have the latest version (${v}).`), [{ label: "OK", value: true, primary: true }]));
        return;
      }
      if (byHand) return void offer(u);
      if (later.has(u.version)) return;
      const found = u;
      toast(`Librarium ${u.version} is available.`, { action: { label: "Update…", run: () => void offer(found) }, ms: 20_000 });
    }

    async function offer(u: AppUpdate) {
      const notes = u.notes.trim();
      const choice = await ask(
        `Librarium ${u.version} is available`,
        [h("p", null, `You have ${u.current}. Installing takes a moment; then Librarium restarts, with your work saved first.`), notes ? h("div", { class: "update-notes" }, h("h3", null, "What’s new"), h("p", null, notes)) : null],
        [{ label: "Later", value: "later" as const }, { label: "Install", value: "install" as const, primary: true }],
      );
      if (choice !== "install") {
        later.add(u.version);
        return;
      }
      busy = true;
      shell.status.show(`Downloading Librarium ${u.version}…`, 0);
      try {
        await u.install((f) => shell.status.show(f == null ? `Downloading Librarium ${u.version}…` : `Downloading Librarium ${u.version}… ${Math.round(f * 100)}%`, 0));
      } catch (e) {
        shell.status.show("", 0);
        void ask("The update couldn’t be installed", h("p", null, `Librarium ${u.current} is unchanged. (${String((e as { message?: string }).message ?? e)})`), [{ label: "OK", value: true, primary: true }]);
        return;
      } finally {
        busy = false;
      }
      installed = u.version;
      shell.status.show(`Librarium ${u.version} is installed; it starts the next time Librarium opens.`, 15_000);
      await offerRestart(u.version);
    }

    async function offerRestart(version: string) {
      const choice = await ask(
        `Restart to use Librarium ${version}?`,
        h("p", null, "Your work is saved first. If you choose Later, the new version starts the next time you open Librarium."),
        [{ label: "Later", value: false }, { label: "Restart now", value: true, primary: true }],
      );
      if (!choice) return;
      await shell.saveAll();
      await restartApp();
    }

    shell.actions.add("updates", {
      id: "updates.check",
      title: "Check for Updates…",
      menu: { name: "app", group: 0 },
      icon: RefreshCw,
      run: () => look(true),
    });

    shell.settings.add("updates", "updates", {
      id: "updates",
      title: "Version",
      render(host) {
        const version = h("span", null, "…");
        void appVersion().then((v) => (version.textContent = v));
        replace(host,
          h("p", null, "Librarium ", version, ". It looks for a newer version once a day and asks before installing it."),
          h("button", { class: "button", type: "button", onclick: () => void look(true) }, "Check for Updates…"));
      },
    });

    setTimeout(function again() {
      void look(false);
      setTimeout(again, timing.everyMs);
    }, timing.firstMs);
  };
}

export const updates = updatesWith({ firstMs: 20_000, everyMs: DAY });
