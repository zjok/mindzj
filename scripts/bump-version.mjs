#!/usr/bin/env node
/**
 * Bump version across all 4 project files + git tag + push in one command.
 *
 * Usage:
 *   npm run bump 0.2.0          # set version + tag + push
 *   npm run bump 0.2.0 --dry    # show what would change, don't write
 *
 * What it does:
 *   1. Updates version in:
 *      - package.json
 *      - src-tauri/tauri.conf.json
 *      - src-tauri/Cargo.toml
 *      - cli/Cargo.toml
 *   2. Runs: git add → git commit → git tag v{version} → git push → git push --tags
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..");
const version = process.argv[2];
const dry = process.argv.includes("--dry");

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error("Usage: npm run bump <version>");
  console.error("  e.g: npm run bump 0.2.0");
  process.exit(1);
}

const files = [
  {
    path: "package.json",
    find: /"version":\s*"[^"]+"/,
    replace: `"version": "${version}"`,
  },
  {
    path: "src-tauri/tauri.conf.json",
    find: /"version":\s*"[^"]+"/,
    replace: `"version": "${version}"`,
  },
  {
    path: "src-tauri/Cargo.toml",
    find: /^version\s*=\s*"[^"]+"/m,
    replace: `version = "${version}"`,
  },
  {
    path: "cli/Cargo.toml",
    find: /^version\s*=\s*"[^"]+"/m,
    replace: `version = "${version}"`,
  },
];

console.log(`\n  Bumping to ${version}${dry ? " (dry run)" : ""}\n`);

for (const f of files) {
  const abs = resolve(root, f.path);
  const content = readFileSync(abs, "utf-8");
  const match = content.match(f.find);
  if (!match) {
    console.error(`  ✗ ${f.path}: pattern not found`);
    process.exit(1);
  }
  const updated = content.replace(f.find, f.replace);
  console.log(`  ✓ ${f.path}  ${match[0]}  →  ${f.replace}`);
  if (!dry) writeFileSync(abs, updated, "utf-8");
}

if (dry) {
  console.log("\n  Dry run — no files written, no git commands.\n");
  process.exit(0);
}

const run = (cmd, { allowFail = false } = {}) => {
  console.log(`  $ ${cmd}`);
  try {
    execSync(cmd, { cwd: root, stdio: "inherit" });
  } catch (err) {
    if (allowFail) {
      console.log(`  (skipped — ${cmd} returned non-zero, continuing)`);
      return;
    }
    throw err;
  }
};

console.log("");
run(`git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml cli/Cargo.toml`);
// Commit may fail if version files weren't actually changed (e.g. re-running
// bump with the same version). That's OK — we still proceed to tag + push.
run(`git commit -m "chore: bump version to ${version}"`, { allowFail: true });
// Tag may fail if it already exists locally. We delete + re-create to ensure
// it points at the current HEAD.
run(`git tag -d v${version}`, { allowFail: true });
run(`git tag v${version}`);
// Delete the remote tag (if it exists) before re-pushing, so workflow
// re-triggers on the current HEAD instead of being a no-op.
run(`git push origin :refs/tags/v${version}`, { allowFail: true });
run(`git push origin main`);
run(`git push origin v${version}`);

console.log(`\n  ✅ v${version} tagged and pushed — workflow will start at:`);
console.log(`     https://github.com/zjok/mindzj/actions\n`);
