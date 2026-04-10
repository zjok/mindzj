# Building and Packaging MindZJ

## Overview

MindZJ is a Tauri 2 desktop app with:

- frontend: Vite + SolidJS
- desktop shell: Tauri
- backend: Rust

The main packaging entrypoint is:

```bash
npm run tauri:build
```

Current project configuration:

- app config: `src-tauri/tauri.conf.json`
- icons: `src-tauri/icons/`
- bundled default plugin templates: `src-tauri/resources/default_plugins/`

## Shared prerequisites

Before packaging on any platform, install:

- Rust
- Node.js
- platform-specific Tauri system dependencies

Useful commands:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run tauri:build
```

## Windows packaging

## Prerequisites

Install:

- Microsoft C++ Build Tools with "Desktop development with C++"
- Microsoft Edge WebView2 runtime
- Rust MSVC toolchain

If you build MSI installers, Windows may also require the `VBSCRIPT` optional feature.

## Build

```powershell
npm install
npm run tauri:build
```

Because this project currently sets:

```json
"bundle": {
  "targets": "all"
}
```

the build will attempt to generate all configured Windows bundle targets available on the machine.

Common output locations:

```text
src-tauri\target\release\bundle\msi\
src-tauri\target\release\bundle\nsis\
```

Notes:

- `.msi` packaging requires Windows.
- NSIS is useful when you need a setup executable.
- Cross-compiling Windows installers from Linux/macOS is possible but not the preferred path.

## macOS packaging

## Prerequisites

Install one of:

- Xcode
- Xcode Command Line Tools (`xcode-select --install`) for desktop-only builds

If you plan to distribute outside local testing, also plan for:

- Apple Developer signing
- notarization

## Build

```bash
npm install
npm run tauri:build
```

Common output locations:

```text
src-tauri/target/release/bundle/macos/
src-tauri/target/release/bundle/dmg/
```

Typical artifacts:

- `.app`
- `.dmg`

## Linux packaging

## Prerequisites

Build on the target distribution or a close equivalent whenever possible.

Typical Debian/Ubuntu dependencies from the Tauri 2 docs:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

## Build

```bash
npm install
npm run tauri:build
```

Common output locations:

```text
src-tauri/target/release/bundle/appimage/
src-tauri/target/release/bundle/deb/
src-tauri/target/release/bundle/rpm/
```

Typical artifacts:

- `.AppImage`
- `.deb`
- `.rpm`

Notes:

- AppImage is the easiest portable format and bundles more dependencies, so it is usually larger.
- Debian and RPM bundles are best built on compatible Linux environments or CI runners.

## Project-specific packaging checklist

Before shipping a build, check:

1. `src-tauri/icons/` contains the final logo assets.
2. `src-tauri/resources/default_plugins/` contains the default plugins to seed new vaults.
3. `src-tauri/tauri.conf.json` has the correct `productName`, `identifier`, `version`, icons, and resources.
4. `npm run build` succeeds before running `npm run tauri:build`.
5. `cargo check --manifest-path src-tauri/Cargo.toml` succeeds.

## Recommended release flow

### Windows

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run tauri:build
```

### macOS

```bash
npm install
npm run typecheck
npm test
npm run build
npm run tauri:build
```

### Linux

```bash
npm install
npm run typecheck
npm test
npm run build
npm run tauri:build
```

## Signing and distribution

For public distribution you should plan separately for:

- Windows signing
- macOS signing and notarization
- Linux signing where relevant

Official references:

- Prerequisites: https://v2.tauri.app/start/prerequisites/
- Windows Installer: https://v2.tauri.app/distribute/windows-installer/
- DMG: https://v2.tauri.app/distribute/dmg/
- AppImage: https://v2.tauri.app/distribute/appimage/
- Debian: https://v2.tauri.app/distribute/debian/
- RPM: https://v2.tauri.app/distribute/rpm/

## Practical advice for MindZJ

- Build Windows installers on Windows.
- Build `.dmg` on macOS.
- Build Linux bundles on Linux, ideally in CI images that match your target distro family.
- Keep plugin templates and icons in the repository so development builds and packaged builds behave the same way.
