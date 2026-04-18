<h1 align="center">
  <img src="docs/Logo.png" alt="MindZJ logo" width="64" height="64" /><br>
  MindZJ — AI-native, CLI-first, Open-Source Offline Note System
</h1>

<p align="center">
  <em>A fully open-source local note-taking app that takes the best of <a href="https://obsidian.md">Obsidian</a> and pushes further on AI integration, CLI workflows and plugin sandboxing.</em>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#keyboard-shortcuts">Shortcuts</a> •
  <a href="#cli">CLI</a> •
  <a href="#development">Development</a> •
  <a href="#license">License</a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/license-AGPL--3.0-green" alt="License" />
  <img src="https://img.shields.io/badge/Tauri-2.0-purple" alt="Tauri" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%26%20macOS%20%26%20Linux-orange" alt="Platform" />
</p>

<p align="center">
  <strong>🌐 README available in:</strong>
  <a href="README.md">English</a> |
  <a href="docs/README_ZH.md">中文</a> |
  <a href="docs/README_JA.md">日本語</a> |
  <a href="docs/README_FR.md">Français</a> |
  <a href="docs/README_DE.md">Deutsch</a> |
  <a href="docs/README_ES.md">Español</a>
</p>

---

<p align="center">
  <a href="https://www.buymeacoffee.com/superjohn">
    <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee" />
  </a>
  &nbsp;
  <a href="https://ko-fi.com/superjohn">
    <img src="https://img.shields.io/badge/Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi" />
  </a>
  &nbsp;
  <a href="https://paypal.me/TanCat997">
    <img src="https://img.shields.io/badge/PayPal-0070ba?style=for-the-badge&logo=paypal&logoColor=white" alt="PayPal" />
  </a>
</p>

<p align="center">If you find MindZJ useful, consider supporting the project</p>

---

## Preview

<p align="center">
  <img src="docs/img01.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>MindZJ Main Interface</em>
</p>

<p align="center">
  <img src="docs/img02.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>Math Formulas</em>
</p>

<p align="center">
  <img src="docs/img03.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>Markdown Basics</em>
</p>

<p align="center">
  <img src="docs/img04.png" alt="MindZJ Plugins" width="800" />
  <br/>
  <em>MindZJ Plugins</em>
</p>

<p align="center">
  <img src="docs/img00.png" alt="MindZJ Welcome" width="800" />
  <br/>
  <em>MindZJ Welcome</em>
</p>

<p align="center">
  <img src="docs/mindzj.gif" alt="MindZJ Main Interface" width="800" />
  <br/>
  <em>Editing Markdown with live preview</em>
</p>

---

## Features

### Core

- **Offline, local-first** — MindZJ is a fully offline note-taking app. Every note lives in your vault as a plain `.md` file on your own disk, all data is stored locally, and nothing is ever uploaded to any server
- **AI-native kernel** — Ollama (offline), Claude and OpenAI are first-class citizens, wired directly into the Rust kernel
- **CLI-first** — a full command-line interface that plays nicely with pipes, scripts and AI tool chains
- **Lightweight** — built on Tauri 2.0 (~10 MB installer) instead of Electron (~150 MB)
- **Cross-platform** — Windows, macOS, Linux, iOS and Android from a single code base
- **Plugin sandbox** — plugins run inside WebWorkers with declarative permissions, safer than the Obsidian model

### Editing

- **Live preview + source + reading** — three editor modes, instantly toggled with `Ctrl+E`
- **Markdown all the way** — headings, lists, tables, code fences, math (KaTeX), callouts, Mermaid diagrams
- **Smart list continuation** — `Enter` extends the current list, `Tab` / `Shift+Tab` to indent/outdent
- **Inline image paste** — clipboard images are saved into the vault and referenced automatically
- **Auto-save** — every change is persisted atomically with fsync + rename, no data loss on power cuts
- **Snapshots** — every edit creates a timestamped snapshot so you can always roll back

### Navigation

- **Wiki links** — `[[note]]` style links with autocomplete and backlink tracking
- **Outline view** — jump through headings with a single click
- **Full-text search** — powered by the Rust `tantivy` engine, instant even on large vaults
- **Command palette** — `Ctrl+P` to launch any command
- **Tabs & splits** — right-click a tab to split right, left, up or down
- **File tree** — drag and drop, custom sort order, pinned folders

### Mind maps

- **Native `.mindzj` format** — a dedicated mind-map editor ships as a built-in plugin
- **Rainbow connections, drag & drop, copy / cut / paste** — every feature from the standalone MindZJ plugin is available here too

### Internationalisation

- **6 languages out of the box** — English, 简体中文, 日本語, Français, Deutsch, Español

### Customisation

- **Theming** — light / dark / system, with CSS variables you can override per vault
- **Hotkeys** — rebind every shortcut through a visual recorder in Settings
- **Plugins** — install community plugins, write your own against the Obsidian-compatible API

---

## Installation

### Pre-built binaries

> _Coming soon — grab the latest installer from [GitHub Releases](https://github.com/zjok/mindzj/releases)._

### Build from source

```bash
git clone https://github.com/zjok/mindzj.git
cd mindzj
npm install
npm run tauri:build
```

The installer will be in `src-tauri/target/release/bundle/`.

### Prerequisites

- [Rust](https://rustup.rs/) ≥ 1.77
- [Node.js](https://nodejs.org/) ≥ 20 LTS
- [Tauri 2.0 prerequisites](https://v2.tauri.app/start/prerequisites/)

---

## Quick Start

1. Launch MindZJ and pick a folder as your vault
2. Press `Ctrl+N` to create a new note, or drop existing `.md` files into the folder
3. Start typing — Markdown renders live as you go
4. Use `[[wiki-link]]` to cross-reference other notes
5. Open the command palette with `Ctrl+P` and type to find any action
6. Toggle view mode with `Ctrl+E` — live preview → source → reading → live preview
7. Press `Ctrl+,` to open Settings and customise everything to your taste

---

## Keyboard Shortcuts

All shortcuts are rebindable in **Settings → Hotkeys**.

| Action           | Default Shortcut        |
| ---------------- | ----------------------- |
| New note         | `Ctrl + N`              |
| Save             | `Ctrl + S`              |
| Command palette  | `Ctrl + P`              |
| Toggle view mode | `Ctrl + E`              |
| Toggle sidebar   | `Ctrl + \``             |
| Settings         | `Ctrl + ,`              |
| Search in vault  | `Ctrl + Shift + F`      |
| Find in note     | `Ctrl + F`              |
| Task list        | `Ctrl + L`              |
| Bold             | `Ctrl + B`              |
| Italic           | `Ctrl + I`              |
| Inline code      | `Ctrl + Shift + E`      |
| Heading 1–6      | `Ctrl + 1` … `Ctrl + 6` |
| Zoom editor text | `Ctrl + Mouse Wheel`    |
| Zoom UI          | `Ctrl + =` / `Ctrl + -` |
| Screenshot       | `Alt + G`               |

---

## CLI

MindZJ ships with a standalone `mindzj` CLI that talks to the same Rust kernel as the desktop app.

```bash
# Open a vault
mindzj vault open ~/my-notes

# Create, list, search, read notes
mindzj note create "My new note"
mindzj note list
mindzj note search "keyword"
mindzj note read "My new note" | grep "TODO"

# AI integration
mindzj config api-key create
mindzj ai ask "How is my project going?"
```

Every kernel operation you can perform through the GUI is also reachable from the CLI — ideal for scripting, bulk imports, and AI tool chains.

---

## Architecture

1. **Kernel / UI separation** — every file operation goes through the Rust kernel API, the frontend never touches the file system directly
2. **Atomic writes** — every save is `write temp → fsync → rename`, survives power loss
3. **Path traversal protection** — every path is validated against the vault root
4. **Automatic snapshots** — each edit is backed up so you can always undo
5. **Plugin sandbox** — plugins run in WebWorkers with an explicit permission manifest

```
mindzj/
├── src-tauri/            # Rust backend (kernel + Tauri commands)
│   └── src/
│       ├── kernel/       # Core: vault, links, search, snapshots
│       └── api/          # Tauri command handlers
├── src/                  # SolidJS frontend
│   ├── components/       # UI components
│   ├── stores/           # Reactive state
│   └── plugin-api/       # Plugin API types
├── cli/                  # Standalone Rust CLI
└── docs/                 # Documentation
```

### Technology Stack

| Layer            | Technology                      |
| ---------------- | ------------------------------- |
| Desktop / mobile | Tauri 2.0 (Rust + WebView)      |
| Frontend         | SolidJS + TypeScript            |
| Editor           | CodeMirror 6                    |
| Styling          | UnoCSS + CSS variables          |
| Search           | tantivy (Rust full-text search) |
| CLI              | Rust (clap)                     |

---

## Development

```bash
# Install dependencies
npm install

# Start the full Tauri dev app (Rust backend + Vite frontend + HMR)
npm run tauri:dev

# Frontend only (no native shell)
npm run dev

# Type check
npm run typecheck

# Production build
npm run tauri:build
```

---

## Support

If you find MindZJ useful, consider supporting the project:

<p align="center">
  <a href="https://www.buymeacoffee.com/superjohn">
    <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee" />
  </a>
  &nbsp;
  <a href="https://ko-fi.com/superjohn">
    <img src="https://img.shields.io/badge/Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi" />
  </a>
  &nbsp;
  <a href="https://paypal.me/TanCat997">
    <img src="https://img.shields.io/badge/PayPal-0070ba?style=for-the-badge&logo=paypal&logoColor=white" alt="PayPal" />
  </a>
</p>

---

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-or-later).

---

<p align="center">
  Made with ❤️ by <strong>SuperJohn</strong> · 2026.04
</p>
