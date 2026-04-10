use crate::kernel::error::CommandError;
use crate::kernel::types::{FileContent, FileMetadata, VaultEntry, VaultInfo};
use crate::kernel::watcher::VaultWatcher;
use crate::kernel::AppState;
use base64::Engine;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri::State;

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), CommandError> {
    std::fs::create_dir_all(dst).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to create directory '{}': {}", dst.display(), e),
    })?;

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
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| CommandError {
                    code: "IO_ERROR".into(),
                    message: format!("Failed to create directory '{}': {}", parent.display(), e),
                })?;
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

fn read_plugin_manifest_id(plugin_dir: &Path) -> Option<String> {
    let manifest_path = plugin_dir.join("manifest.json");
    let content = std::fs::read_to_string(manifest_path).ok()?;
    let manifest = serde_json::from_str::<Value>(&content).ok()?;
    manifest.get("id")?.as_str().map(|id| id.to_string())
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

fn install_default_plugins_if_needed(
    app: &tauri::AppHandle,
    vault_root: &Path,
) -> Result<(), CommandError> {
    let mindzj_dir = vault_root.join(".mindzj");
    let plugins_dir = mindzj_dir.join("plugins");
    let enabled_plugins_path = mindzj_dir.join("plugins.json");

    let has_installed_plugins = plugins_dir.exists()
        && std::fs::read_dir(&plugins_dir)
            .ok()
            .map(|mut entries| entries.any(|entry| entry.ok().map(|e| e.path().is_dir()).unwrap_or(false)))
            .unwrap_or(false);

    let enabled_plugins = if enabled_plugins_path.exists() {
        std::fs::read_to_string(&enabled_plugins_path)
            .ok()
            .and_then(|content| serde_json::from_str::<Vec<String>>(&content).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    if has_installed_plugins || !enabled_plugins.is_empty() {
        return Ok(());
    }

    let source_root = match bundled_default_plugins_dir(app) {
        Some(path) => path,
        None => return Ok(()),
    };

    std::fs::create_dir_all(&plugins_dir).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to create plugins directory '{}': {}", plugins_dir.display(), e),
    })?;

    let mut installed_plugin_ids = Vec::new();
    for entry in std::fs::read_dir(&source_root).map_err(|e| CommandError {
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
        let target_path = plugins_dir.join(entry.file_name());
        if target_path.exists() {
            continue;
        }
        copy_dir_recursive(&source_path, &target_path)?;
        if let Some(plugin_id) = read_plugin_manifest_id(&target_path) {
            installed_plugin_ids.push(plugin_id);
        }
    }

    if installed_plugin_ids.is_empty() {
        return Ok(());
    }

    let enabled_json = serde_json::to_string_pretty(&installed_plugin_ids).map_err(|e| CommandError {
        code: "SERIALIZE_ERROR".into(),
        message: format!("Failed to serialize default plugin list: {}", e),
    })?;
    std::fs::write(&enabled_plugins_path, enabled_json).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!(
            "Failed to write default plugin config '{}': {}",
            enabled_plugins_path.display(),
            e
        ),
    })?;

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
