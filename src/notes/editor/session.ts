/**
 * A note being edited, so that no words are lost:
 * - about 300 ms after each change, a draft goes to the backend, which keeps it until the save
 *   succeeds;
 * - saves happen after 1 s idle, and on blur, navigation and quit;
 * - a save carries the version (and body) it was based on: the backend merges three ways when
 *   the file changed meanwhile, and otherwise both versions are shown to choose from;
 * - a failed save is retried, and reported calmly in the status bar.
 */
import { call } from "../../backend";
import { errorText } from "../../ui/dom";
import type { SaveResult } from "../../types";

const DRAFT_MS = 300;
const IDLE_MS = 1000;

/** What the user chose when changes overlapped: the text to show, and the new base. */
export interface Resolution {
  body: string;
  version: string;
  baseBody: string;
}

interface SessionHooks {
  /** The text the editor shows now. */
  current(): string;
  /** Show this text (a merge's result, or the version chosen). */
  replace(body: string): void;
  /** The changes overlap: let the user choose. */
  conflict(mine: string, theirs: string, theirVersion: string): Promise<Resolution | null>;
  status(text: string, persistent?: boolean): void;
}

export class NoteSession {
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private failures = 0;
  private closed = false;
  /** The text last confirmed on disk. */
  savedBody: string;

  constructor(
    readonly id: string,
    public baseVersion: string,
    public baseBody: string,
    private hooks: SessionHooks,
  ) {
    this.savedBody = baseBody;
  }

  get dirty(): boolean {
    return this.hooks.current() !== this.savedBody;
  }

  /** Call on every change. */
  changed(): void {
    clearTimeout(this.draftTimer);
    clearTimeout(this.saveTimer);
    this.draftTimer = setTimeout(() => void this.draft(), DRAFT_MS);
    this.saveTimer = setTimeout(() => void this.save(), IDLE_MS);
  }

  /** The file changed without our text changing (a rename rewrote its frontmatter). */
  rebase(version: string, body: string): void {
    this.baseVersion = version;
    this.baseBody = body;
    if (!this.dirty) this.savedBody = body;
  }

  async draft(): Promise<void> {
    if (!this.dirty) return;
    try {
      await call("drafts.put", { id: this.id, base_version: this.baseVersion, base_body: this.baseBody, body: this.hooks.current() });
    } catch (e) {
      this.hooks.status(`Couldn’t keep a draft: ${sentence(e)}`);
    }
  }

  /** Saves now if there is anything to save; waits for a save in flight. */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.saving) await this.saving;
    if (this.dirty) await this.save();
  }

  /** A last draft and save, then the timers stop (leaving the note, quitting). */
  async close(): Promise<void> {
    clearTimeout(this.draftTimer);
    clearTimeout(this.retryTimer);
    if (this.dirty) await this.draft();
    await this.flush();
    this.closed = true;
    clearTimeout(this.saveTimer);
  }

  async save(): Promise<void> {
    if (this.saving) {
      await this.saving;
      return this.dirty ? this.save() : undefined;
    }
    if (!this.dirty) return;
    clearTimeout(this.saveTimer);
    this.saving = this.send().finally(() => (this.saving = null));
    return this.saving;
  }

  private async send(): Promise<void> {
    const sent = this.hooks.current();
    let r: SaveResult;
    try {
      r = await call<SaveResult>("records.save", { id: this.id, base_version: this.baseVersion, base_body: this.baseBody, body: sent });
    } catch (e) {
      this.failures++;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
      this.hooks.status(`Couldn’t save: ${sentence(e)} Trying again in ${Math.round(wait / 1000)} s. Your text is kept.`, true);
      clearTimeout(this.retryTimer);
      if (!this.closed) this.retryTimer = setTimeout(() => void this.save(), wait);
      return;
    }
    if (this.failures) this.hooks.status("Saved.");
    this.failures = 0;
    if (r.outcome === "saved") {
      this.baseVersion = r.version;
      this.baseBody = sent;
      this.savedBody = sent;
    } else if (r.outcome === "merged") {
      // With more typing since, the old base stays, so the next save merges the outside edits
      // in again.
      if (this.hooks.current() !== sent) return this.changed();
      this.baseVersion = r.version;
      this.baseBody = r.body;
      this.savedBody = r.body;
      this.hooks.replace(r.body);
      this.hooks.status("Merged with changes made outside Librarium.");
    } else {
      const choice = await this.hooks.conflict(sent, r.body, r.version);
      if (!choice) return;
      this.baseVersion = choice.version;
      this.baseBody = choice.baseBody;
      this.savedBody = choice.baseBody;
      if (this.hooks.current() !== choice.body) this.hooks.replace(choice.body);
      if (this.dirty) await this.send();
    }
  }
}

/** An error's message as a sentence. */
function sentence(e: unknown): string {
  const m = errorText(e);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}
