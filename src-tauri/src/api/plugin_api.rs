use crate::kernel::error::CommandError;
use crate::kernel::AppState;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

/// Obsidian-compatible plugin manifest (manifest.json)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default, rename = "authorUrl")]
    pub author_url: String,
    #[serde(default, rename = "minAppVersion")]
    pub min_app_version: String,
    #[serde(default, rename = "isDesktopOnly")]
    pub is_desktop_only: bool,
}

/// Core plugins that are always enabled by default
const CORE_PLUGIN_IDS: &[&str] = &[""];

/// Plugin info returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub manifest: PluginManifest,
    pub enabled: bool,
    pub has_styles: bool,
    pub dir_path: String,
    /// Whether this is a built-in core plugin (always enabled, not deletable)
    #[serde(default)]
    pub is_core: bool,
}

fn find_plugin_dir(vault_root: &Path, plugin_id: &str) -> Option<std::path::PathBuf> {
    let plugins_dir = vault_root.join(".mindzj").join("plugins");
    if !plugins_dir.exists() {
        return None;
    }

    // Fast path: folder name exactly matches the requested id.
    let exact = plugins_dir.join(plugin_id);
    if exact.is_dir() {
        return Some(exact);
    }

    let entries = std::fs::read_dir(&plugins_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }

        let content = match std::fs::read_to_string(&manifest_path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        let manifest = match serde_json::from_str::<PluginManifest>(&content) {
            Ok(manifest) => manifest,
            Err(_) => continue,
        };

        if manifest.id == plugin_id {
            return Some(path);
        }
    }

    None
}

/// List all installed plugins (reads from .mindzj/plugins/ directory)
#[tauri::command]
pub async fn list_plugins(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<PluginInfo>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let vault_root = ctx.vault.root();
    let plugins_dir = vault_root.join(".mindzj").join("plugins");

    if !plugins_dir.exists() {
        return Ok(Vec::new());
    }

    let mut plugins = Vec::new();

    let entries = std::fs::read_dir(&plugins_dir).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to read plugins directory: {}", e),
    })?;

    // Read enabled plugins list
    let mut enabled_plugins = read_enabled_plugins(vault_root);

    // Auto-enable core plugins if not already in the list
    let mut core_added = false;
    for &core_id in CORE_PLUGIN_IDS {
        if !enabled_plugins.contains(&core_id.to_string()) {
            enabled_plugins.push(core_id.to_string());
            core_added = true;
        }
    }
    if core_added {
        let _ = write_enabled_plugins(vault_root, &enabled_plugins);
    }

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }

        match std::fs::read_to_string(&manifest_path) {
            Ok(content) => match serde_json::from_str::<PluginManifest>(&content) {
                Ok(manifest) => {
                    let is_core = CORE_PLUGIN_IDS.contains(&manifest.id.as_str());
                    let enabled = is_core || enabled_plugins.contains(&manifest.id);
                    let has_styles = path.join("styles.css").exists();
                    plugins.push(PluginInfo {
                        dir_path: path.to_string_lossy().to_string(),
                        manifest,
                        enabled,
                        has_styles,
                        is_core,
                    });
                }
                Err(e) => {
                    tracing::warn!(
                        "Invalid plugin manifest at {:?}: {}",
                        manifest_path,
                        e
                    );
                }
            },
            Err(e) => {
                tracing::warn!(
                    "Failed to read plugin manifest {:?}: {}",
                    manifest_path,
                    e
                );
            }
        }
    }

    plugins.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    Ok(plugins)
}

/// Toggle a plugin's enabled state
#[tauri::command]
pub async fn toggle_plugin(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    plugin_id: String,
    enabled: bool,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let vault_root = ctx.vault.root();
    let mut enabled_plugins = read_enabled_plugins(vault_root);

    if enabled {
        if !enabled_plugins.contains(&plugin_id) {
            enabled_plugins.push(plugin_id);
        }
    } else {
        enabled_plugins.retain(|id| id != &plugin_id);
    }

    write_enabled_plugins(vault_root, &enabled_plugins)?;
    Ok(())
}

/// Delete a plugin from the filesystem
#[tauri::command]
pub async fn delete_plugin(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    plugin_id: String,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let vault_root = ctx.vault.root();
    let plugin_dir = find_plugin_dir(vault_root, &plugin_id).unwrap_or_else(|| {
        vault_root
            .join(".mindzj")
            .join("plugins")
            .join(&plugin_id)
    });

    if plugin_dir.exists() {
        std::fs::remove_dir_all(&plugin_dir).map_err(|e| CommandError {
            code: "IO_ERROR".into(),
            message: format!("Failed to delete plugin: {}", e),
        })?;
    }

    // Remove from enabled list
    let mut enabled = read_enabled_plugins(vault_root);
    enabled.retain(|id| id != &plugin_id);
    let _ = write_enabled_plugins(vault_root, &enabled);

    Ok(())
}

/// Read the plugin main.js file content
#[tauri::command]
pub async fn read_plugin_main(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    plugin_id: String,
) -> Result<String, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let plugin_dir = find_plugin_dir(ctx.vault.root(), &plugin_id).ok_or_else(|| CommandError {
        code: "NOT_FOUND".into(),
        message: format!("Plugin directory not found for '{}'", plugin_id),
    })?;
    let main_path = plugin_dir.join("main.js");

    std::fs::read_to_string(&main_path).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to read plugin main.js: {}", e),
    })
}

/// Read plugin styles.css content
#[tauri::command]
pub async fn read_plugin_styles(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    plugin_id: String,
) -> Result<String, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let plugin_dir = find_plugin_dir(ctx.vault.root(), &plugin_id).ok_or_else(|| CommandError {
        code: "NOT_FOUND".into(),
        message: format!("Plugin directory not found for '{}'", plugin_id),
    })?;
    let styles_path = plugin_dir.join("styles.css");

    if styles_path.exists() {
        std::fs::read_to_string(&styles_path).map_err(|e| CommandError {
            code: "IO_ERROR".into(),
            message: format!("Failed to read plugin styles: {}", e),
        })
    } else {
        Ok(String::new())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read_enabled_plugins(vault_root: &Path) -> Vec<String> {
    let config_path = vault_root.join(".mindzj").join("plugins.json");
    if !config_path.exists() {
        return Vec::new();
    }
    match std::fs::read_to_string(&config_path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn write_enabled_plugins(vault_root: &Path, plugins: &[String]) -> Result<(), CommandError> {
    let mindzj_dir = vault_root.join(".mindzj");
    if !mindzj_dir.exists() {
        std::fs::create_dir_all(&mindzj_dir).map_err(|e| CommandError {
            code: "IO_ERROR".into(),
            message: format!("Failed to create .mindzj directory: {}", e),
        })?;
    }

    let config_path = mindzj_dir.join("plugins.json");
    let content = serde_json::to_string_pretty(plugins).map_err(|e| CommandError {
        code: "SERIALIZE_ERROR".into(),
        message: format!("Failed to serialize plugin list: {}", e),
    })?;

    std::fs::write(&config_path, content).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to write plugin config: {}", e),
    })
}
