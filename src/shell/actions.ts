/**
 * The action registry: every user-facing command, defined once. The ribbon, the palette, the
 * shortcuts dialog and the native menu are generated from it. Duplicate IDs and shortcut
 * collisions are rejected at startup.
 */
import { DuplicateError, Registry } from "../kit/registry";
import { normalize } from "../kit/keys";
import type { IconNode } from "../kit/icon";

export type MenuName = "app" | "file" | "edit" | "view" | "go" | "window" | "help";

export interface Action {
  id: string;
  title: string;
  /** Shortcuts, e.g. "Mod+Shift+P". The first is shown. */
  keys?: string[];
  /** Available now? Defaults to always. */
  when?: () => boolean;
  run: () => void | Promise<void>;
  menu?: { name: MenuName; group: number; title?: string };
  icon?: IconNode;
  /** Listed in the command palette (default true). */
  palette?: boolean;
  /** Keeps working while the editor has focus (the app's reserved shortcuts). */
  reserved?: boolean;
}

export class ShortcutCollision extends Error {}

export class Actions {
  readonly registry = new Registry<Action>("shell.actions");
  private keymap = new Map<string, string>();

  add(contributor: string, a: Action, order = 0): void {
    const keys = (a.keys ?? []).map(normalize);
    for (const k of keys) {
      const other = this.keymap.get(k);
      if (other) throw new ShortcutCollision(`shortcut ${k} of "${a.id}" is already used by "${other}"`);
    }
    try {
      this.registry.add(contributor, a.id, { ...a, keys }, order);
    } catch (e) {
      if (e instanceof DuplicateError) throw e;
      throw e;
    }
    for (const k of keys) this.keymap.set(k, a.id);
  }

  get(id: string): Action | undefined {
    return this.registry.get(id);
  }

  all(): Action[] {
    return this.registry.values();
  }

  available(a: Action): boolean {
    try {
      return a.when ? a.when() : true;
    } catch {
      return false;
    }
  }

  forKey(key: string): Action | undefined {
    const id = this.keymap.get(normalize(key));
    return id ? this.registry.get(id) : undefined;
  }

  /** Runs an action if it is available. */
  run(id: string): boolean {
    const a = this.get(id);
    if (!a || !this.available(a)) return false;
    void a.run();
    return true;
  }
}
