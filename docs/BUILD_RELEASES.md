# MindZJ Build And Release Guide

## 1. Project structure

MindZJ is split into three main layers:

- Frontend: `Vite + SolidJS`
- Desktop shell: `Tauri 2`
- Native backend: `Rust`

Important project locations:

- App config: `src-tauri/tauri.conf.json`
- Desktop icons: `src-tauri/icons/`
- Bundled default plugins: `src-tauri/resources/default_plugins/`
- Frontend build output: `dist/`
- Desktop bundle output: `src-tauri/target/release/bundle/`

## 2. Common prerequisites

Install these on every platform before building:

- `Node.js`
- `Rust`
- platform-specific Tauri dependencies

Recommended verification commands:

```bash
npm install
npm run typecheck
npm test
cargo check --workspace
```

## 3. Development build

Frontend only:

```bash
npm run dev
```

Desktop development mode:

```bash
npm run tauri:dev
```

This mode is best for:

- daily development
- UI debugging
- plugin debugging
- testing vault behavior without creating release bundles

## 4. Production build

Frontend production assets only:

```bash
npm run build
```

Full desktop production bundle:

```bash
npm run tauri:build
```

Release bundles are written under:

```text
src-tauri/target/release/bundle/
```

## 5. Windows packaging

### Required dependencies

- Visual Studio Build Tools with `Desktop development with C++`
- Microsoft Edge WebView2 Runtime
- Rust MSVC toolchain

### Build command

```powershell
npm install
npm run typecheck
npm test
cargo check --workspace
npm run tauri:build
```

### Common outputs

```text
src-tauri\target\release\bundle\msi\
src-tauri\target\release\bundle\nsis\
```

### Notes

- `.msi` is suitable for enterprise or installer-based distribution.
- `nsis` is suitable when you want a setup `.exe`.
- Build Windows installers on Windows.

## 6. macOS packaging

### Required dependencies

- Xcode Command Line Tools
- Rust toolchain

Install Xcode tools:

```bash
xcode-select --install
```

### Build command

```bash
npm install
npm run typecheck
npm test
cargo check --workspace
npm run tauri:build
```

### Common outputs

```text
src-tauri/target/release/bundle/macos/
src-tauri/target/release/bundle/dmg/
```

### Notes

- Build `.dmg` on macOS.
- If you plan to distribute outside local testing, add Apple signing and notarization.

## 7. Linux packaging

### Typical dependencies

Depending on distro, install GTK / WebKitGTK / AppIndicator related packages.

Common Debian/Ubuntu package set:

```bash
sudo apt update
sudo apt install -y \
  build-essential \
  curl \
  wget \
  file \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  libwebkit2gtk-4.1-dev
```

### Build command

```bash
npm install
npm run typecheck
npm test
cargo check --workspace
npm run tauri:build
```

### Common outputs

```text
src-tauri/target/release/bundle/appimage/
src-tauri/target/release/bundle/deb/
src-tauri/target/release/bundle/rpm/
```

### Notes

- `.AppImage` is the easiest portable package for manual distribution.
- `.deb` is best for Debian / Ubuntu based systems.
- `.rpm` is best for Fedora / RHEL style systems.
- Build Linux bundles on Linux for the cleanest results.

## 8. Recommended release workflow

Before every release:

```bash
npm install
npm run typecheck
npm test
cargo check --workspace
npm run build
npm run tauri:build
```

Release checklist:

- confirm `src-tauri/icons/` uses the final MindZJ logo
- confirm `src-tauri/resources/default_plugins/` contains the intended default plugins
- confirm `src-tauri/tauri.conf.json` version, product name, bundle targets, and identifiers are correct
- verify one clean new vault can open successfully after installation
- verify `.mindzj` default plugins are copied correctly in a fresh vault

## 9. Official references

- Tauri prerequisites: https://v2.tauri.app/start/prerequisites/
- Windows Installer: https://v2.tauri.app/distribute/windows-installer/
- DMG: https://v2.tauri.app/distribute/dmg/
- AppImage: https://v2.tauri.app/distribute/appimage/
- Debian: https://v2.tauri.app/distribute/debian/
- RPM: https://v2.tauri.app/distribute/rpm/
