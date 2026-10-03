/**
 * A note being edited: never lose words (§6).
 *
 * - About 300 ms after each change, a draft goes to the backend, which keeps it until the save
 *   succeeds.
 * - Saves happen after 1 second idle, and on blur, navigation and window close.
 * - A save carries the version (and body) it was based on: the backend refuses a stale save,
 *   merges three ways when it can, and otherwise both versions are shown.
 * - A failed save is retried, and reported calmly in the status bar.
 */
import { call } from "../../backend";
import type { SaveResult } from "../../generated/SaveResult";

export const DRAFT_MS = 300;
export const IDLE_MS = 1000;

export interface SessionHooks {
  /** The body the editor shows now. */
  current(): string;
  /** The backend merged outside edits in: show this body. */
  merged(body: string): void;
  /** Outside edits overlap: let the user choose. Resolves with the body to keep. */
  conflict(mine: string, theirs: string, theirVersion: string): Promise<{ body: string; version: string; baseBody: string } | null>;
  status(text: string, persistent?: boolean): void;
  saved(seq: number): void;
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

  /** The file changed without our edits: a new base (e.g. after a rename rewrote frontmatter). */
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
      this.hooks.status(`Couldn’t keep a draft: ${message(e)}`);
    }
  }

  /** Saves now if there's anything to save; waits for a save in flight. */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.saving) await this.saving;
    if (this.dirty) await this.save();
  }

  /** Stops timers after a last save (navigation, close). */
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
      if (this.dirty) return this.save();
      return;
    }
    if (!this.dirty) return;
    clearTimeout(this.saveTimer);
    this.saving = this.doSave().finally(() => (this.saving = null));
    return this.saving;
  }

  private async doSave(): Promise<void> {
    const sent = this.hooks.current();
    let r: SaveResult;
    try {
      r = await call<SaveResult>("records.save", { id: this.id, base_version: this.baseVersion, base_body: this.baseBody, body: sent });
    } catch (e) {
      this.failures++;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
      this.hooks.status(`Couldn’t save: ${message(e)} Trying again in ${Math.round(wait / 1000)} s. Your text is kept.`, true);
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
      this.hooks.saved(r.seq);
    } else if (r.outcome === "merged") {
      if (this.hooks.current() === sent) {
        this.baseVersion = r.version;
        this.baseBody = r.body;
        this.savedBody = r.body;
        this.hooks.merged(r.body);
        this.hooks.status("Merged with changes made outside Librarium.");
      } else {
        // More typing arrived during the save: keep the old base so the next save merges
        // the outside edits in again, then show the result.
        this.changed();
      }
      this.hooks.saved(r.seq);
    } else {
      const choice = await this.hooks.conflict(sent, r.body, r.version);
      if (choice) {
        this.baseVersion = choice.version;
        this.baseBody = choice.baseBody;
        this.savedBody = choice.baseBody;
        if (this.hooks.current() !== choice.body) this.hooks.merged(choice.body);
        if (this.dirty) await this.doSave();
      }
    }
  }
}

function message(e: unknown): string {
  const m = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}
