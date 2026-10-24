// Fetches the Syncthing that Librarium runs for the shared folder (Settings ▸ Sharing), pinned
// and checked against its SHA-256, into src-tauri/binaries/ (ignored by git), where Tauri bundles
// it beside the app (`externalBin`). Its licence (MPL-2.0) goes with it. Runs after npm install
// and before a release; does nothing when the pinned version is already there.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const VERSION = "v2.1.6";
const ZIP = `syncthing-macos-arm64-${VERSION}.zip`;
const SHA256 = "f86bfa0bdbb5b1b13229a7e5643e898e3c4e017a4fff6dd525994ebaf28ff6e2";
const URL = `https://github.com/syncthing/syncthing/releases/download/${VERSION}/${ZIP}`;

const dir = path.resolve("src-tauri/binaries");
const bin = path.join(dir, "syncthing-aarch64-apple-darwin");
const stamp = path.join(dir, "syncthing.version");
if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION) process.exit(0);

console.log(`Fetching Syncthing ${VERSION}…`);
const res = await fetch(URL);
if (!res.ok) throw new Error(`Syncthing ${VERSION} couldn’t be downloaded: HTTP ${res.status}`);
const zip = Buffer.from(await res.arrayBuffer());
const sha = createHash("sha256").update(zip).digest("hex");
if (sha !== SHA256) throw new Error(`Syncthing ${VERSION}’s download doesn’t match its SHA-256 (${sha}); not used.`);
const work = mkdtempSync(path.join(tmpdir(), "syncthing-"));
try {
  writeFileSync(path.join(work, ZIP), zip);
  execFileSync("unzip", ["-q", path.join(work, ZIP), "-d", work]);
  const from = path.join(work, ZIP.replace(/\.zip$/, ""));
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(from, "syncthing"), bin);
  copyFileSync(path.join(from, "LICENSE.txt"), path.join(dir, "syncthing-LICENSE.txt"));
  writeFileSync(stamp, `${VERSION}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Syncthing ${VERSION} is in src-tauri/binaries`);
