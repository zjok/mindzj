#!/usr/bin/env node
/**
 * Remove stale installers from previous builds.
 *
 * Why: Tauri's bundler writes installers into `target/release/bundle/{nsis,msi,
 * deb,appimage,rpm,app,dmg}/` but never cleans up old files between builds. So
 * bumping 0.1.0 → 0.1.1 leaves BOTH MindZJ_0.1.0_x64-setup.exe AND
 * MindZJ_0.1.1_x64-setup.exe in bundle/nsis/, which is confusing when shipping.
 *
 * Only the bundle/ folder is wiped — NOT target/release/ itself. That keeps the
 * Rust compile cache (deps, build/, *.rlib) intact so rebuilds stay fast; only
 * the final installer output is regenerated, which only takes a few seconds.
 *
 * Covers both layouts just in case:
 *   - target/release/bundle/        (Cargo workspace at project root — our case)
 *   - src-tauri/target/release/bundle/ (classic non-workspace Tauri layout)
 */

import { rmSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..");

const candidates = [
  resolve(root, "target/release/bundle"),
  resolve(root, "src-tauri/target/release/bundle"),
];

let removed = false;
for (const dir of candidates) {
  if (existsSync(dir)) {
    // Log what we're about to nuke so the user can see it.
    try {
      const subdirs = readdirSync(dir);
      console.log(`  🧹 cleaning ${dir}`);
      for (const sub of subdirs) {
        console.log(`       ${sub}/`);
      }
    } catch {
      // readdirSync can fail on permission issues; log but keep going.
      console.log(`  🧹 cleaning ${dir}`);
    }
    rmSync(dir, { recursive: true, force: true });
    removed = true;
  }
}

if (!removed) {
  console.log("  (no bundle/ folder found — nothing to clean)");
}
