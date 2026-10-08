// Publishes a version of Librarium (R-069, decision 0072): `npm run release -- 0.2.0 "What's new"`.
//
// 1. Checks: on main, nothing uncommitted, GitHub signed in, the update key present.
// 2. Sets the version (package.json, tauri.conf.json, the Cargo workspace) and runs the tests
//    (`--skip-tests` to skip them).
// 3. Builds the app signed with the update key (.secrets/updater.key): the .dmg for first
//    installs, and the update (Librarium.app.tar.gz + its signature).
// 4. Commits "Release X", tags vX, pushes, and makes the GitHub release with the files and
//    latest.json, which installed copies read to find the update.
//
// The update key never leaves .secrets/ (ignored by git). Lose it and installed copies can't
// be updated any more (they'd need the app downloaded again), so keep a copy somewhere safe.
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "PartlyWhole/Librarium";
const KEY = ".secrets/updater.key";
const args = process.argv.slice(2);
const skipTests = args.includes("--skip-tests");
const [version, notes = ""] = args.filter((a) => !a.startsWith("--"));

const run = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", ...opts });
const out = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const fail = (msg) => {
  console.error(`\nNot released: ${msg}`);
  process.exit(1);
};

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) fail('give the version, e.g. npm run release -- 0.2.0 "What’s new"');
if (out("git branch --show-current") !== "main") fail("releases are made from main.");
if (out("git status --porcelain")) fail("commit or put away your changes first (git status).");
if (!existsSync(KEY)) fail(`the update key (${KEY}) is missing.`);
try {
  out("gh auth status");
} catch {
  fail("sign in to GitHub first (gh auth login).");
}
const tag = `v${version}`;
if (out(`git tag --list ${tag}`)) fail(`${tag} is already released.`);

// The version, everywhere it is written.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = version;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
conf.version = version;
writeFileSync("src-tauri/tauri.conf.json", `${JSON.stringify(conf, null, 2)}\n`);
writeFileSync("Cargo.toml", readFileSync("Cargo.toml", "utf8").replace(/(\[workspace\.package\][^[]*?\nversion = )"[^"]*"/, `$1"${version}"`));
run("npm install --package-lock-only --silent");
run("cargo update --workspace --quiet");

if (!skipTests) run("npm test");

// Built and signed for updates.
run("npm run build", { env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: readFileSync(KEY, "utf8"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" } });
const bundle = "target/release/bundle";
const arch = out("uname -m") === "arm64" ? "aarch64" : "x86_64";
const update = `${bundle}/macos/Librarium.app.tar.gz`;
const dmg = `${bundle}/dmg/Librarium_${version}_${arch}.dmg`;
for (const f of [update, `${update}.sig`, dmg]) if (!existsSync(f)) fail(`the build didn't make ${f}.`);

// What installed copies read: the newest version, and where its update is.
const dir = mkdtempSync(join(tmpdir(), "librarium-release-"));
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { [`darwin-${arch}`]: { signature: readFileSync(`${update}.sig`, "utf8").trim(), url: `https://github.com/${REPO}/releases/download/${tag}/Librarium.app.tar.gz` } },
};
writeFileSync(join(dir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
// The same .dmg under a name that never changes, for one lasting download link.
copyFileSync(dmg, join(dir, "Librarium.dmg"));

// Nothing to commit when the version was already this one (the first release, 0.1.0).
if (out("git status --porcelain")) run(`git commit -q -am "Release ${version}"`);
run(`git tag ${tag}`);
run(`git push -q origin main ${tag}`);
execFileSync("gh", ["release", "create", tag, "--repo", REPO, "--title", `Librarium ${version}`, "--notes", notes || `Librarium ${version}.`, dmg, join(dir, "Librarium.dmg"), update, `${update}.sig`, join(dir, "latest.json")], { stdio: "inherit" });
console.log(`\nReleased Librarium ${version}: https://github.com/${REPO}/releases/tag/${tag}`);
console.log(`Installed copies will offer it within a day. First installs: https://github.com/${REPO}/releases/latest/download/Librarium.dmg`);
