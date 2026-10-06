// Allowed: the engine loaded on demand, and its types.
import type { el as E } from "./engine";
export const lazy = async (): Promise<typeof E> => (await import("./engine")).el;
