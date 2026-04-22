use crate::kernel::error::CommandError;
use crate::kernel::types::{FileContent, FileMetadata, VaultEntry, VaultInfo};
use crate::kernel::watcher::VaultWatcher;
use crate::kernel::AppState;
use base64::Engine;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri::State;

struct EmbeddedDefaultPluginFile {
    plugin_dir: &'static str,
    relative_path: &'static str,
    bytes: &'static [u8],
}

const EMBEDDED_DEFAULT_PLUGIN_FILES: &[EmbeddedDefaultPluginFile] = &[
    EmbeddedDefaultPluginFile {
        plugin_dir: "mindzj",
        relative_path: "data.json",
        bytes: include_bytes!("../../resources/default_plugins/mindzj/data.json"),
    },
    EmbeddedDefaultPluginFile {
        plugin_dir: "mindzj",
        relative_path: "main.js",
        bytes: include_bytes!("../../resources/default_plugins/mindzj/main.js"),
    },
    EmbeddedDefaultPluginFile {
        plugin_dir: "mindzj",
        relative_path: "manifest.json",
        bytes: include_bytes!("../../resources/default_plugins/mindzj/manifest.json"),
    },
    EmbeddedDefaultPluginFile {
        plugin_dir: "mindzj",
        relative_path: "styles.css",
        bytes: include_bytes!("../../resources/default_plugins/mindzj/styles.css"),
    },
    EmbeddedDefaultPluginFile {
        plugin_dir: "timestamp_header",
        relative_path: "main.js",
        bytes: include_bytes!("../../resources/default_plugins/timestamp_header/main.js"),
    },
    EmbeddedDefaultPluginFile {
        plugin_dir: "timestamp_header",
        relative_path: "manifest.json",
        bytes: include_bytes!("../../resources/default_plugins/timestamp_header/manifest.json"),
    },
];

fn create_dir_if_needed(path: &Path) -> Result<(), CommandError> {
    std::fs::create_dir_all(path).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to create directory '{}': {}", path.display(), e),
    })
}

fn read_plugin_manifest_info_from_bytes(bytes: &[u8]) -> Option<(String, String)> {
    let manifest = serde_json::from_slice::<Value>(bytes).ok()?;
    let id = manifest.get("id")?.as_str()?.to_string();
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some((id, version))
}

fn read_plugin_manifest_info(plugin_dir: &Path) -> Option<(String, String)> {
    let manifest_path = plugin_dir.join("manifest.json");
    let content = std::fs::read(&manifest_path).ok()?;
    read_plugin_manifest_info_from_bytes(&content)
}

fn sync_plugin_dir_recursive(src: &Path, dst: &Path, preserve_data_json: bool) -> Result<(), CommandError> {
    create_dir_if_needed(dst)?;

    for entry in std::fs::read_dir(src).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to read directory '{}': {}", src.display(), e),
    })? {
        let entry = entry.map_err(|e| CommandError {
            code: "IO_ERROR".into(),
            message: format!("Failed to read directory entry in '{}': {}", src.display(), e),
        })?;
        let source_path = entry.path();
        let target_path = dst.join(entry.file_name());
        if source_path.is_dir() {
            sync_plugin_dir_recursive(&source_path, &target_path, preserve_data_json)?;
        } else {
            if preserve_data_json
                && source_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.eq_ignore_ascii_case("data.json"))
                    .unwrap_or(false)
                && target_path.exists()
            {
                continue;
            }
            if let Some(parent) = target_path.parent() {
                create_dir_if_needed(parent)?;
            }
            std::fs::copy(&source_path, &target_path).map_err(|e| CommandError {
                code: "IO_ERROR".into(),
                message: format!(
                    "Failed to copy '{}' to '{}': {}",
                    source_path.display(),
                    target_path.display(),
                    e
                ),
            })?;
        }
    }

    Ok(())
}

fn bundled_default_plugins_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("default_plugins");
    if dev_path.exists() {
        return Some(dev_path);
    }

    let resource_path = app.path().resource_dir().ok()?.join("default_plugins");
    if resource_path.exists() {
        return Some(resource_path);
    }

    None
}

fn read_enabled_plugins(path: &Path) -> Vec<String> {
    if !path.exists() {
        return Vec::new();
    }

    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Vec<String>>(&content).ok())
        .unwrap_or_default()
}

fn write_enabled_plugins(path: &Path, plugin_ids: &[String]) -> Result<(), CommandError> {
    let json = serde_json::to_string_pretty(plugin_ids).map_err(|e| CommandError {
        code: "SERIALIZE_ERROR".into(),
        message: format!("Failed to serialize default plugin list: {}", e),
    })?;
    std::fs::write(path, json).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to write default plugin config '{}': {}", path.display(), e),
    })
}

fn sync_default_plugins_from_dir(source_root: &Path, plugins_dir: &Path) -> Result<Vec<String>, CommandError> {
    let mut plugin_ids = BTreeSet::new();

    for entry in std::fs::read_dir(source_root).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!(
            "Failed to read default plugins directory '{}': {}",
            source_root.display(),
            e
        ),
    })? {
        let entry = entry.map_err(|e| CommandError {
            code: "IO_ERROR".into(),
            message: format!("Failed to read default plugin entry: {}", e),
        })?;
        let source_path = entry.path();
        if !source_path.is_dir() {
            continue;
        }

        let bundled_info = match read_plugin_manifest_info(&source_path) {
            Some(info) => info,
            None => continue,
        };
        let target_path = plugins_dir.join(entry.file_name());
        let installed_info = read_plugin_manifest_info(&target_path);
        let should_sync = !target_path.exists()
            || installed_info.is_none()
            || installed_info
                .as_ref()
                .map(|(_, version)| version.as_str())
                != Some(bundled_info.1.as_str())
            || !target_path.join("main.js").exists()
            || !target_path.join("manifest.json").exists();

        if should_sync {
            sync_plugin_dir_recursive(&source_path, &target_path, true)?;
        }
        plugin_ids.insert(bundled_info.0);
    }

    Ok(plugin_ids.into_iter().collect())
}

fn sync_default_plugins_from_embedded(plugins_dir: &Path) -> Result<Vec<String>, CommandError> {
    let mut plugin_ids = BTreeSet::new();

    for file in EMBEDDED_DEFAULT_PLUGIN_FILES {
        let target_dir = plugins_dir.join(file.plugin_dir);
        create_dir_if_needed(&target_dir)?;

        if file.relative_path.eq_ignore_ascii_case("manifest.json") {
            if let Some((plugin_id, _)) = read_plugin_manifest_info_from_bytes(file.bytes) {
                plugin_ids.insert(plugin_id);
            }
        }

        let target_path = target_dir.join(file.relative_path);
        if file.relative_path.eq_ignore_ascii_case("data.json") && target_path.exists() {
            continue;
        }
        std::fs::write(&target_path, file.bytes).map_err(|e| CommandError {
            code: "IO_ERROR".into(),
            message: format!(
                "Failed to write embedded default plugin file '{}': {}",
                target_path.display(),
                e
            ),
        })?;
    }

    Ok(plugin_ids.into_iter().collect())
}

fn install_default_plugins_if_needed(app: &tauri::AppHandle, vault_root: &Path) -> Result<(), CommandError> {
    let mindzj_dir = vault_root.join(".mindzj");
    let plugins_dir = mindzj_dir.join("plugins");
    let enabled_plugins_path = mindzj_dir.join("plugins.json");

    create_dir_if_needed(&mindzj_dir)?;
    create_dir_if_needed(&plugins_dir)?;

    let enabled_plugins = read_enabled_plugins(&enabled_plugins_path);
    let should_seed_enabled_list = enabled_plugins.is_empty();

    let bundled_plugin_ids = if let Some(source_root) = bundled_default_plugins_dir(app) {
        sync_default_plugins_from_dir(&source_root, &plugins_dir)?
    } else {
        sync_default_plugins_from_embedded(&plugins_dir)?
    };

    if should_seed_enabled_list && !bundled_plugin_ids.is_empty() {
        write_enabled_plugins(&enabled_plugins_path, &bundled_plugin_ids)?;
    }

    Ok(())
}

/// Open a vault at the given path, associating it with the calling window.
#[tauri::command]
pub async fn open_vault(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    name: String,
) -> Result<VaultInfo, CommandError> {
    let path_buf = std::path::PathBuf::from(&path);
    let (info, ctx) = state
        .open_vault(path_buf.clone(), &name, window.label())
        .map_err(CommandError::from)?;

    if let Err(error) = install_default_plugins_if_needed(&app, &info.path) {
        tracing::warn!("Failed to install default plugins for '{}': {}", info.path.display(), error.message);
    }

    // Allow the asset protocol to serve files from this vault directory.
    // Without this, pasted images (and other vault assets) won't load
    // because the fs plugin's default scope only covers app directories.
    {
        use tauri_plugin_fs::FsExt;
        let scope = app.fs_scope();
        if let Err(e) = scope.allow_directory(&info.path, true) {
            tracing::warn!("Failed to add vault to fs scope: {}", e);
        }
    }

    // Start file watcher for this vault (if not already running)
    {
        let mut watcher_guard = ctx.watcher.lock().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire watcher lock".into(),
        })?;
        if watcher_guard.is_none() {
            match VaultWatcher::new(path_buf, app) {
                Ok(w) => {
                    *watcher_guard = Some(w);
                }
                Err(e) => {
                    tracing::warn!("Failed to start file watcher: {}", e);
                }
            }
        }
    }

    Ok(info)
}

/// Get info about the vault open in the calling window.
#[tauri::command]
pub async fn get_vault_info(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<VaultInfo>, CommandError> {
    match state.get_vault_context(window.label()) {
        Ok(ctx) => Ok(Some(ctx.vault.info().clone())),
        Err(_) => Ok(None),
    }
}

/// List entries in a vault directory.
#[tauri::command]
pub async fn list_entries(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_dir: String,
) -> Result<Vec<VaultEntry>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .list_entries(&relative_dir)
        .map_err(CommandError::from)
}

/// Get the complete file tree for the vault.
#[tauri::command]
pub async fn get_file_tree(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    max_depth: Option<u32>,
) -> Result<Vec<VaultEntry>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .file_tree(max_depth.unwrap_or(10))
        .map_err(CommandError::from)
}

/// Read the content of a file.
#[tauri::command]
pub async fn read_file(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<FileContent, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .read_file(&relative_path)
        .map_err(CommandError::from)
}

/// Write content to a file (atomic write with snapshot).
#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
    content: String,
) -> Result<FileContent, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let result = ctx
        .vault
        .write_file(&relative_path, &content)
        .map_err(CommandError::from)?;
    ctx.on_file_changed(&relative_path, &content);
    Ok(result)
}

/// Create a new file (fails if file already exists).
#[tauri::command]
pub async fn create_file(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
    content: Option<String>,
) -> Result<FileContent, CommandError> {
    let content = content.unwrap_or_default();
    let ctx = state.get_vault_context(window.label())?;
    let result = ctx
        .vault
        .create_file(&relative_path, &content)
        .map_err(CommandError::from)?;
    ctx.on_file_changed(&relative_path, &content);
    Ok(result)
}

/// Delete a file.
#[tauri::command]
pub async fn delete_file(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .delete_file(&relative_path)
        .map_err(CommandError::from)?;
    ctx.on_file_deleted(&relative_path);
    Ok(())
}

/// Rename or move a file.
#[tauri::command]
pub async fn rename_file(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    from: String,
    to: String,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .rename_file(&from, &to)
        .map_err(CommandError::from)?;

    // Update indexes: remove old path, register new path
    ctx.on_file_deleted(&from);
    let content = ctx
        .vault
        .read_file(&to)
        .map(|fc| fc.content)
        .unwrap_or_default();
    ctx.on_file_changed(&to, &content);

    Ok(())
}

/// Create a new directory.
#[tauri::command]
pub async fn create_dir(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .create_dir(&relative_path)
        .map_err(CommandError::from)
}

/// Delete a directory.
#[tauri::command]
pub async fn delete_dir(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
    recursive: Option<bool>,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .delete_dir(&relative_path, recursive.unwrap_or(false))
        .map_err(CommandError::from)
}

/// Get file metadata.
#[tauri::command]
pub async fn get_file_metadata(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<FileMetadata, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .file_metadata(&relative_path)
        .map_err(CommandError::from)
}

/// List snapshots available for a file (for file recovery).
#[tauri::command]
pub async fn list_snapshots(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<Vec<String>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .list_snapshots(&relative_path)
        .map_err(CommandError::from)
}

/// Restore a file from a snapshot.
#[tauri::command]
pub async fn restore_snapshot(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
    snapshot_name: String,
) -> Result<FileContent, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .restore_snapshot(&relative_path, &snapshot_name)
        .map_err(CommandError::from)
}

// ---------------------------------------------------------------------------
// CSS snippets (Obsidian-style per-vault .mindzj/snippets/*.css)
// ---------------------------------------------------------------------------

/// List `.css` files in the current vault's `.mindzj/snippets/` folder.
/// Each entry is a bare filename (e.g. `dark.css`) — the frontend pairs
/// this with a per-snippet enabled flag from settings.json.
#[tauri::command]
pub async fn list_css_snippets(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault.list_css_snippets().map_err(CommandError::from)
}

/// Read the raw content of a CSS snippet file by its bare filename.
#[tauri::command]
pub async fn read_css_snippet(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    name: String,
) -> Result<String, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault.read_css_snippet(&name).map_err(CommandError::from)
}

/// Write binary data (base64-encoded) to a file in the vault.
/// Used for saving pasted images and other binary assets.
#[tauri::command]
pub async fn write_binary_file(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
    base64_data: String,
) -> Result<(), CommandError> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| CommandError {
            code: "DECODE_ERROR".into(),
            message: format!("Failed to decode base64 data: {}", e),
        })?;
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .write_binary(&relative_path, &data)
        .map_err(CommandError::from)
}

/// Read binary data from a vault file and return it as a base64 string.
#[tauri::command]
pub async fn read_binary_file(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<String, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let abs_path = ctx.vault.root().join(&relative_path);
    let data = std::fs::read(&abs_path).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to read binary file '{}': {}", relative_path, e),
    })?;
    Ok(base64::engine::general_purpose::STANDARD.encode(data))
}

/// Reveal a file in the operating system file manager.
#[tauri::command]
pub async fn reveal_in_file_manager(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let abs_path = ctx.vault.root().join(&relative_path);

    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("explorer");
        // Strip \\?\ prefix that Windows extended-length paths may have —
        // explorer.exe doesn't understand this prefix.
        let display_path = abs_path.display().to_string();
        let clean_path = display_path.strip_prefix(r"\\?\").unwrap_or(&display_path);
        // Use raw_arg to avoid Rust auto-quoting the entire argument.
        // explorer.exe expects: /select,"C:\path with spaces\file.png"
        // With .arg(), Rust would quote the whole thing: "/select,C:\path..."
        // which explorer.exe doesn't understand.
        cmd.raw_arg(format!("/select,\"{}\"", clean_path));
        cmd
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("open");
        cmd.arg("-R").arg(&abs_path);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut cmd = std::process::Command::new("xdg-open");
        let parent = abs_path.parent().unwrap_or(ctx.vault.root());
        cmd.arg(parent);
        cmd
    };

    cmd.spawn().map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to reveal path '{}': {}", abs_path.display(), e),
    })?;

    Ok(())
}

/// Open a file with the operating system default application.
#[tauri::command]
pub async fn open_in_default_app(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let abs_path = ctx.vault.root().join(&relative_path);

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("cmd");
        // Strip \\?\ prefix and wrap path for paths containing spaces
        let display_path = abs_path.display().to_string();
        let clean_path = display_path.strip_prefix(r"\\?\").unwrap_or(&display_path).to_string();
        cmd.args(["/C", "start", "", &clean_path]);
        cmd
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(&abs_path);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(&abs_path);
        cmd
    };

    cmd.spawn().map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to open path '{}': {}", abs_path.display(), e),
    })?;

    Ok(())
}

/// Open an ABSOLUTE path in the OS file manager. Unlike
/// `reveal_in_file_manager` this:
///   1. Does NOT require an opened vault (useful from the welcome screen,
///      where the user is browsing their vault list before opening any
///      of them).
///   2. Opens the folder DIRECTLY instead of selecting it in its parent
///      — explorer.exe gets `"path"`, not `/select,"path"`, so you land
///      INSIDE the folder.
#[tauri::command]
pub async fn open_path_in_file_manager(absolute_path: String) -> Result<(), CommandError> {
    use std::path::PathBuf;

    let path = PathBuf::from(&absolute_path);

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("explorer");
        // Strip the \\?\ extended-length prefix (explorer.exe cannot
        // parse it).
        let display_path = path.display().to_string();
        let clean_path = display_path
            .strip_prefix(r"\\?\")
            .unwrap_or(&display_path)
            .to_string();
        cmd.arg(clean_path);
        cmd
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(&path);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(&path);
        cmd
    };

    // `explorer` on Windows spawns a new process that outlives our Command
    // handle; calling .spawn() is enough and we DON'T wait — otherwise the
    // await would block forever if the user keeps the window open.
    // explorer.exe also returns exit code 1 even on success for some
    // reason, so we ignore the exit status entirely.
    cmd.spawn().map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to open path '{}': {}", path.display(), e),
    })?;

    Ok(())
}

/// Return the absolute filesystem path to the vault's snippets folder,
/// creating it on demand. The frontend then asks the shell plugin to
/// reveal it in the OS file manager.
#[tauri::command]
pub async fn get_snippets_dir(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .snippets_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(CommandError::from)
}

// ---------------------------------------------------------------------------
// Custom themes / skins (Obsidian-style per-vault `.mindzj/themes/*.css`)
// ---------------------------------------------------------------------------

/// List `.css` files in `.mindzj/themes/`. Each entry is a bare filename
/// (e.g. `my-theme.css`). The frontend renders one entry per file in the
/// skin picker and references them as `custom:<stem>` in settings.
#[tauri::command]
pub async fn list_themes(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault.list_themes().map_err(CommandError::from)
}

/// Read the raw CSS content of a custom theme by its bare filename
/// (e.g. `my-theme.css`). The file must live directly inside
/// `.mindzj/themes/`.
#[tauri::command]
pub async fn read_theme(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    name: String,
) -> Result<String, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault.read_theme(&name).map_err(CommandError::from)
}

/// Import a `.css` file from an ABSOLUTE filesystem path into
/// `.mindzj/themes/`. The frontend gets the absolute path from a
/// `@tauri-apps/plugin-dialog` file picker, so the Tauri frontend
/// scope doesn't need to grant read access for arbitrary locations.
///
/// Returns the sanitized bare filename that ended up on disk — the
/// frontend stores `custom:<stem>` in `settings.theme`.
#[tauri::command]
pub async fn import_theme(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    source_absolute_path: String,
    overwrite: Option<bool>,
) -> Result<String, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .import_theme(&source_absolute_path, overwrite.unwrap_or(false))
        .map_err(CommandError::from)
}

/// Delete a custom theme by its bare filename. A no-op if the file is
/// already gone, so the UI can safely issue deletes even after external
/// file system changes.
#[tauri::command]
pub async fn delete_theme(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    name: String,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault.delete_theme(&name).map_err(CommandError::from)
}

/// Write a CSS string as `<bare_name>.css` inside `.mindzj/themes/`.
/// Used by the "new empty theme" scaffold button in the skin picker.
#[tauri::command]
pub async fn write_theme(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    bare_name: String,
    content: String,
) -> Result<String, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .write_theme(&bare_name, &content)
        .map_err(CommandError::from)
}

/// Return the absolute path of the vault's `.mindzj/themes/` folder
/// (creating it on demand). The frontend uses this to "reveal in file
/// manager" via the shell plugin.
#[tauri::command]
pub async fn get_themes_dir(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.vault
        .themes_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(CommandError::from)
}
