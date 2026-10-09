/**
 * What notes, boards and the library agree on about files coming in: which can be added, where
 * pasted and dropped pictures go, how a pasted picture is named and sent, and which parts of the
 * window take file drops themselves.
 */

/** The Library folder that pictures pasted or dropped into notes and boards go to. */
export const ATTACHMENTS = "Attachments";
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"];
export const DOCUMENT_EXTENSIONS = ["pdf", "epub"];
/** Pasted data larger than this is refused (as base64, about 70 MB). */
export const MAX_PASTE = 50 * 1024 * 1024;

/**
 * Marks an element that takes file drops itself (a board's canvas): drops over it are left to
 * it, not added to the library.
 */
export const OWN_DROPS = "data-own-drops";

export const extension = (path: string): string => path.split(".").pop()?.toLowerCase() ?? "";
export const isImagePath = (path: string): boolean => IMAGE_EXTENSIONS.includes(extension(path));

/** Bytes as base64. */
export function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A pasted file's name: its own, or "Pasted image <date time>" for a clipboard picture. */
export function pastedName(f: File): string {
  if (f.name && f.name !== "image.png") return f.name;
  const ext = (f.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace("+xml", "");
  const stamp = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }).replace(/[/:]/g, ".");
  return `Pasted image ${stamp}.${ext}`;
}
