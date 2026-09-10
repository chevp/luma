#!/usr/bin/env node
// Builds a standalone `luma.exe` using Node's built-in Single Executable
// Application (SEA) support — no nexe, because luma is ESM ("type": "module"
// in package.json) and nexe targets CommonJS entry points. SEA works from a
// bundled CJS file instead (bundled with esbuild, a build-time-only
// devDependency — not a runtime dependency per ADR-003).
//
// Double-clicking the produced luma.exe with no arguments runs `luma setup`
// (installs/updates the toolchain declared in .luma/toolchain.yml) instead of
// the normal CLI default (`help`) — see build/sea-entry.cjs below.
//
// Usage: npm run build:exe

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const buildDir = join(root, "build");

if (process.platform !== "win32") {
  console.warn(
    "build-exe: this script targets Windows (luma.exe). It will still run " +
      "SEA injection for the current platform's node binary, but the output " +
      "won't be a Windows executable.",
  );
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

console.log("[1/5] tsc build ...");
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });

console.log("[2/5] bundling dist/index.js -> build/sea-entry.cjs (esbuild) ...");
// SEA's embedder `require()` cannot load a second file off disk — the whole
// CLI has to land in the one file referenced by sea-config.json's "main".
// The argv shim (double-click => `luma setup`) is injected as a banner so it
// runs before the bundled `main().then(...)` reads process.argv.
const entryPath = join(buildDir, "sea-entry.cjs");
const esbuild = await import("esbuild");
await esbuild.build({
  entryPoints: [join(root, "dist", "index.js")],
  outfile: entryPath,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  banner: {
    js: "if (process.argv.length <= 2) { process.argv.push('setup'); }",
  },
});

console.log("[3/5] writing sea-config.json ...");
const seaConfigPath = join(buildDir, "sea-config.json");
const blobPath = join(buildDir, "sea-prep.blob");
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: "sea-entry.cjs",
      output: "sea-prep.blob",
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);

console.log("[4/5] node --experimental-sea-config ...");
execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], {
  cwd: buildDir,
  stdio: "inherit",
});

console.log("[5/5] injecting blob into a copy of node.exe ...");
const outExe = join(buildDir, process.platform === "win32" ? "luma.exe" : "luma-sea");
copyFileSync(process.execPath, outExe);

const postjectArgs = [
  "postject",
  outExe,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "win32") {
  // Nothing extra needed on Windows (PE resources aren't touched here).
}
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
execFileSync("npx", postjectArgs, { cwd: buildDir, stdio: "inherit", shell: true });

console.log(`\ndone: ${outExe}`);
