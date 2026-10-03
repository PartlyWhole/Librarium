// Copies the release worker to src-tauri/binaries/ with the target-triple suffix Tauri's
// externalBin expects. Used only for packaging (npm run build).
import { copyFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const triple = execSync("rustc -vV").toString().match(/host: (\S+)/)[1];
mkdirSync("src-tauri/binaries", { recursive: true });
copyFileSync("target/release/librarium-worker", `src-tauri/binaries/librarium-worker-${triple}`);
console.log(`staged librarium-worker-${triple}`);
