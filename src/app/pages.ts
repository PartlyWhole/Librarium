/**
 * Every page, by name. Features add theirs by assigning to `pages` when their module loads
 * (`pages.note = {…}`); the shell shows them in tabs.
 */
import type { IconNode } from "../ui/icon";
import { signal } from "../ui/signal";

export interface PageContext {
  /** The tab's (and the window's) title. */
  setTitle(title: string): void;
  /** Buttons for the header's right side. */
  setHeaderActions(nodes: Node[]): void;
}

/**
 * What rendering returns: a disposer, or a handle whose `update` takes new params for the same
 * record (another place in it) without rendering again — true if it did.
 */
export type PageHandle = (() => void) | void | { dispose?(): void; update?(params: Record<string, string>): boolean };

export interface Page {
  title: string;
  icon: IconNode;
  render(host: HTMLElement, params: Record<string, string>, ctx: PageContext): PageHandle;
}

export const pages: Record<string, Page> = {};

/**
 * The folder the page shown is looking at ("" for a space's top level), where new things of
 * its kind go; null when no page shows a folder.
 */
export const here = signal<{ kind: string; folder: string } | null>(null);

/** The page shown fills the window (a board in full screen): the rest of the app is hidden. */
export const fullPage = signal(false);
