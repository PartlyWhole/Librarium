/**
 * What the board page and notes showing a board both need, without loading Excalidraw: the
 * engine, loaded on first use; the app's light or dark look; pictures' data from the library;
 * and the words a card reads as outside the app.
 */
import { readBytes } from "../backend";
import { citation } from "../captures/common";
import { base64 } from "../library/files";
import { getRecord, kindName } from "../app/records";
import type { RecordInfo } from "../types";
import type { Picture, Portable } from "./engine";

/** Excalidraw (with React), loaded the first time a board is shown. Its fonts are the app's own. */
export function loadEngine(): Promise<typeof import("./engine")> {
  (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw/";
  return import("./engine");
}

/** The app's light or dark look now. */
export function appTheme(): "light" | "dark" {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (t !== "light" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}

/** A library item whose original is a picture: it goes on a board as a picture, not a card. */
export const isPicture = (r: RecordInfo | undefined) => r?.kind === "item" && r.fields["library.format"] === "image";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", heic: "image/heic", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp" };

/** A picture's data and size, from the library (a picture that never loads gets a usual size). */
export async function pictureData(id: string): Promise<Picture | null> {
  const r = getRecord(id);
  if (!isPicture(r)) return null;
  try {
    const ext = String(r!.fields["library.original"] ?? "").split(".").pop()?.toLowerCase() ?? "";
    const mimeType = MIME[ext] ?? "image/png";
    const dataURL = `data:${mimeType};base64,${base64(new Uint8Array(await readBytes(id)))}`;
    const size = await new Promise<{ width: number; height: number }>((resolve) => {
      const usual = () => resolve({ width: 400, height: 300 });
      setTimeout(usual, 3000);
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth || 400, height: img.naturalHeight || 300 });
      img.onerror = usual;
      img.src = dataURL;
    });
    return { dataURL, mimeType, ...size };
  } catch {
    return null;
  }
}

/** How a board reads outside the app: cards as words, pictures with their data. */
export const portable: Portable = {
  cardText(id) {
    const r = getRecord(id);
    if (!r) return "(gone)";
    if (r.kind === "capture") return `${String(r.fields["captures.quote"] ?? "").trim() || "[a captured region]"}\n— ${citation(r)}`;
    return `${r.title || "Untitled"}\n${kindName(r)}`;
  },
  imageOf: pictureData,
};
