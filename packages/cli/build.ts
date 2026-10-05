/**
 * Build the precompiled gh extension binaries.
 *
 * gh looks for `gh-<name>-<os>-<arch>` using GOARCH names, so the Intel asset
 * has to be `amd64`, not `x64`. Naming it x64 gives Intel Macs
 * "no compatible binary found".
 *
 * Also produces ./gh-skim/gh-skim for
 * `gh extension install ./gh-skim` during development.
 */
import { mkdir, chmod, copyFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url).pathname;
const entry = `${root}packages/cli/src/index.ts`;

const TARGETS: { target: string; asset: string }[] = [
  { target: "bun-darwin-arm64", asset: "gh-skim-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "gh-skim-darwin-amd64" },
];

await mkdir(`${root}dist`, { recursive: true });

for (const { target, asset } of TARGETS) {
  const out = `${root}dist/${asset}`;
  const proc = Bun.spawnSync([
    "bun",
    "build",
    "--compile",
    `--target=${target}`,
    entry,
    "--outfile",
    out,
  ]);
  const err = new TextDecoder().decode(proc.stderr);
  if (proc.exitCode !== 0) {
    console.error(`FAILED ${asset}\n${err}`);
    process.exit(1);
  }
  await chmod(out, 0o755);
  console.log(`built dist/${asset} (${(Bun.file(out).size / 1024 / 1024).toFixed(1)} MB)`);
}

// Local install target for `gh extension install ./gh-skim`.
const localDir = `${root}gh-skim`;
await mkdir(localDir, { recursive: true });
const native = process.arch === "arm64" ? "darwin-arm64" : "darwin-amd64";
await copyFile(`${root}dist/gh-skim-${native}`, `${localDir}/gh-skim`);
await chmod(`${localDir}/gh-skim`, 0o755);
console.log(`local extension ready: ${localDir}/gh-skim`);
