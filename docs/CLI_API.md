# MindZJ CLI and Desktop API

## Overview

MindZJ currently exposes two automation surfaces:

1. The standalone CLI in `cli/`
2. The desktop application's Tauri command API in `src-tauri/src/api/`

This document covers both.

## Build the CLI

```bash
cargo build -p mindzj-cli --release
```

The generated binary is:

```text
target/release/mindzj
```

On Windows the binary is:

```text
target\release\mindzj.exe
```

You can also run commands without installing:

```bash
cargo run -p mindzj-cli -- --vault /path/to/vault note list
```

## Global CLI options

```text
mindzj [--vault <path>] [--format text|json] <command>
```

Options:

- `--vault <path>`: Vault root. Defaults to the current directory.
- `--format text|json`: Human-readable output or machine-readable JSON.
- `--key <token>`: API key for future AI commands.

## Vault commands

### Open or initialize a vault

```bash
mindzj --vault /notes vault open /notes
```

Behavior:

- Creates the vault directory if missing.
- Creates `.mindzj/` and the standard subdirectories:
  - `snapshots`
  - `plugins`
  - `snippets`
  - `themes`
  - `images`
- Creates default config files when missing.

### Show vault info

```bash
mindzj --vault /notes vault info
mindzj --vault /notes --format json vault info
```

JSON fields:

- `name`
- `path`
- `notes`
- `size_bytes`
- `size_human`

### List known vaults

```bash
mindzj vault list
```

Note:

- This is currently a placeholder and returns an empty JSON list in `json` mode.

## Note commands

### Create a note

```bash
mindzj --vault /notes note create Daily
mindzj --vault /notes note create Daily --content "# Daily\n"
echo "# Daily" | mindzj --vault /notes note create Daily --stdin
mindzj --vault /notes note create Daily --folder journal/2026
```

Behavior:

- Adds `.md` automatically when omitted.
- Creates the target folder when `--folder` is used.
- If no content is provided, initializes the note with a title heading.

### Overwrite a note

```bash
mindzj --vault /notes note write Daily --content "# Rewritten"
cat body.md | mindzj --vault /notes note write Daily --stdin
mindzj --vault /notes note write journal/new-note --stdin --create
```

Behavior:

- Overwrites the full file content.
- `--create` creates the note if it does not exist.
- Requires `--content` or `--stdin`.

### Append to a note

```bash
mindzj --vault /notes note append Daily --content "- next item"
echo "- next item" | mindzj --vault /notes note append Daily --stdin
```

Behavior:

- Appends text to the end of the file.
- Inserts a newline first if the file does not already end with one.

### Move or rename a note

```bash
mindzj --vault /notes note move Daily journal/2026/Daily
```

Behavior:

- Accepts either note names or relative paths.
- Adds `.md` to the destination if omitted.
- Creates destination folders automatically.

### Read a note

```bash
mindzj --vault /notes note read Daily
mindzj --vault /notes --format json note read Daily
```

Text mode prints raw file content to stdout, which makes piping easy:

```bash
mindzj --vault /notes note read Daily | rg TODO
```

### List notes

```bash
mindzj --vault /notes note list
mindzj --vault /notes note list --dir journal
mindzj --vault /notes note list --tag project
mindzj --vault /notes --format json note list
```

### Search note content

```bash
mindzj --vault /notes note search roadmap
mindzj --vault /notes note search roadmap --limit 20
mindzj --vault /notes --format json note search roadmap
```

JSON result shape:

```json
{
  "query": "roadmap",
  "matched_files": 2,
  "results": [
    {
      "path": "projects/plan.md",
      "matches": [
        { "line": 12, "text": "roadmap item" }
      ]
    }
  ]
}
```

### Delete a note

```bash
mindzj --vault /notes note delete Daily
mindzj --vault /notes note delete Daily --force
```

Behavior:

- Prompts for confirmation unless `--force` is used.
- Writes a delete snapshot to `.mindzj/snapshots/` before removing the file.

### Show outgoing wiki links

```bash
mindzj --vault /notes note links Daily
mindzj --vault /notes --format json note links Daily
```

This parses `[[Wiki Links]]` and returns the outgoing targets.

## Config commands

### Get a key

```bash
mindzj --vault /notes config get editor.font_size
mindzj --vault /notes --format json config get editor.font_size
```

### Set a key

```bash
mindzj --vault /notes config set editor.font_size 16
```

### API key management

```bash
mindzj --vault /notes config api-key create
mindzj --vault /notes config api-key status
mindzj --vault /notes config api-key revoke
```

## Recommended CLI workflows

### 1. Write from an editor or generator

```bash
some-generator | mindzj --vault /notes note write inbox/generated --stdin --create
```

### 2. Patch a daily note from a script

```bash
echo "- shipped build" | mindzj --vault /notes note append daily/2026-04-10 --stdin
```

### 3. Consume structured results from JSON mode

```bash
mindzj --vault /notes --format json note search release | jq '.results[].path'
```

## Desktop Tauri command API

The desktop app exposes Tauri commands that the frontend calls through `invoke(...)`.

## Vault API

Source: `src-tauri/src/api/vault_api.rs`

| Command | Parameters | Returns | Purpose |
|---|---|---|---|
| `open_vault` | `path`, `name` | `VaultInfo` | Open or initialize a vault for the current window |
| `get_vault_info` | none | `VaultInfo?` | Get the current vault bound to the window |
| `list_entries` | `relative_dir` | `VaultEntry[]` | List a directory |
| `get_file_tree` | `max_depth?` | `VaultEntry[]` | Get the tree for the sidebar |
| `read_file` | `relative_path` | `FileContent` | Read a file |
| `write_file` | `relative_path`, `content` | `FileContent` | Atomic save with snapshot |
| `create_file` | `relative_path`, `content?` | `FileContent` | Create a new file |
| `delete_file` | `relative_path` | `()` | Delete a file |
| `rename_file` | `from`, `to` | `()` | Rename or move a file |
| `create_dir` | `relative_path` | `()` | Create a directory |
| `delete_dir` | `relative_path`, `recursive?` | `()` | Delete a directory |
| `get_file_metadata` | `relative_path` | `FileMetadata` | Stats, counts, tags |
| `list_snapshots` | `relative_path` | `string[]` | List recovery snapshots |
| `restore_snapshot` | `relative_path`, `snapshot_name` | `FileContent` | Restore a snapshot |
| `list_css_snippets` | none | `string[]` | List `.mindzj/snippets/*.css` |
| `read_css_snippet` | `name` | `string` | Read a snippet |
| `get_snippets_dir` | none | `string` | Return absolute snippets directory |
| `write_binary_file` | `relative_path`, `base64_data` | `()` | Save binary assets |
| `read_binary_file` | `relative_path` | `string` | Read binary as base64 |
| `reveal_in_file_manager` | `relative_path` | `()` | Reveal a file in Explorer/Finder/File Manager |
| `open_in_default_app` | `relative_path` | `()` | Open file with OS default app |

## Search and links API

Source: `src-tauri/src/api/search_api.rs`

| Command | Parameters | Returns | Purpose |
|---|---|---|---|
| `search_vault` | `query`, `limit?`, `extension_filter?`, `path_filter?` | `SearchResult[]` | Full-text search |
| `get_forward_links` | `relative_path` | `NoteLink[]` | Outgoing links |
| `get_backlinks` | `relative_path` | `NoteLink[]` | Incoming links |
| `get_graph_data` | none | `GraphData` | Graph view data |
| `get_unresolved_links` | none | `NoteLink[]` | Missing targets |

## Settings and workspace API

Source: `src-tauri/src/api/settings_api.rs`

| Command | Parameters | Returns | Purpose |
|---|---|---|---|
| `get_settings` | none | `AppSettings` | Load vault settings |
| `update_settings` | `settings` | `()` | Full settings replace |
| `set_theme` | `theme` | `()` | Update theme |
| `set_font_size` | `size` | `()` | Update font size |
| `set_view_mode` | `mode` | `()` | Update default view mode |
| `load_workspace` | none | `WorkspaceState` | Restore tabs/sidebar state |
| `save_workspace` | `workspace` | `()` | Persist workspace |
| `get_hotkeys` | none | `HotkeyBinding[]` | Load per-vault hotkeys |
| `save_hotkeys` | `bindings` | `()` | Save per-vault hotkeys |
| `get_window_state` | none | `GlobalWindowState` | Read global window geometry |
| `save_window_state` | `window_state` | `()` | Persist global window geometry |

## Plugin API

Source: `src-tauri/src/api/plugin_api.rs`

| Command | Parameters | Returns | Purpose |
|---|---|---|---|
| `list_plugins` | none | `PluginInfo[]` | Enumerate installed plugins |
| `toggle_plugin` | `plugin_id`, `enabled` | `()` | Enable or disable a plugin |
| `delete_plugin` | `plugin_id` | `()` | Remove a plugin from `.mindzj/plugins` |
| `read_plugin_main` | `plugin_id` | `string` | Read plugin `main.js` |
| `read_plugin_styles` | `plugin_id` | `string` | Read plugin `styles.css` |

## Screenshot API

Source: `src-tauri/src/api/screenshot_api.rs`

| Command | Parameters | Returns | Purpose |
|---|---|---|---|
| `capture_screen` | none | `string` | Capture the screen as base64 |
| `save_screenshot_to_temp` | payload | `string` | Persist a temp screenshot |

## Integration guidance

Use the CLI when:

- you need shell pipelines
- you want JSON output for scripts
- you are automating note CRUD outside the desktop app

Use the Tauri command API when:

- you are extending the desktop UI
- you need access to the active vault/window context
- you want the same safety guarantees as the app backend
