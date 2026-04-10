pub mod error;
pub mod links;
pub mod search;
pub mod types;
pub mod vault;
pub mod watcher;

use crate::kernel::error::{CommandError, KernelError, KernelResult};
use crate::kernel::links::LinkIndex;
use crate::kernel::search::SearchIndex;
use crate::kernel::types::{AppSettings, HotkeyBinding, VaultEntry, VaultInfo, WorkspaceState};
use crate::kernel::vault::Vault;
use crate::kernel::watcher::VaultWatcher;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tracing::info;

// ---------------------------------------------------------------------------
// Per-vault state bundle
// ---------------------------------------------------------------------------

/// Holds all state for a single open vault: file manager, indexes, settings.
/// Shared across windows that display the same vault via `Arc`.
pub struct VaultContext {
    pub vault: Vault,
    pub link_index: Mutex<LinkIndex>,
    pub search_index: Mutex<SearchIndex>,
    pub settings: RwLock<AppSettings>,
    pub watcher: Mutex<Option<VaultWatcher>>,
}

impl VaultContext {
    fn mindzj_dir(&self) -> PathBuf {
        self.vault.root().join(".mindzj")
    }

    fn ensure_mindzj_dir(&self) -> KernelResult<PathBuf> {
        let dir = self.mindzj_dir();
        if !dir.exists() {
            std::fs::create_dir_all(&dir)?;
        }
        Ok(dir)
    }

    // -- Settings persistence ------------------------------------------------

    pub fn load_settings(&self) -> KernelResult<()> {
        let path = self.mindzj_dir().join("settings.json");
        if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            if let Ok(loaded) = serde_json::from_str::<AppSettings>(&content) {
                if let Ok(mut s) = self.settings.write() {
                    *s = loaded;
                    info!("Settings loaded from {:?}", path);
                }
            }
        }
        Ok(())
    }

    pub fn save_settings(&self) -> KernelResult<()> {
        let dir = self.ensure_mindzj_dir()?;
        let s = self.settings.read().map_err(|_| {
            KernelError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Settings lock poisoned",
            ))
        })?;
        let json = serde_json::to_string_pretty(&*s)?;
        std::fs::write(dir.join("settings.json"), json)?;
        Ok(())
    }

    // -- Workspace persistence -----------------------------------------------

    pub fn load_workspace(&self) -> KernelResult<WorkspaceState> {
        let p = self.mindzj_dir().join("workspace.json");
        if p.exists() {
            let c = std::fs::read_to_string(&p)?;
            if let Ok(ws) = serde_json::from_str::<WorkspaceState>(&c) {
                return Ok(ws);
            }
        }
        Ok(WorkspaceState::default())
    }

    pub fn save_workspace(&self, ws: &WorkspaceState) -> KernelResult<()> {
        let dir = self.ensure_mindzj_dir()?;
        let json = serde_json::to_string_pretty(ws)?;
        std::fs::write(dir.join("workspace.json"), json)?;
        Ok(())
    }

    // -- Hotkey persistence --------------------------------------------------

    pub fn load_hotkeys(&self) -> KernelResult<Vec<HotkeyBinding>> {
        let p = self.mindzj_dir().join("hotkeys.json");
        if p.exists() {
            let c = std::fs::read_to_string(&p)?;
            if let Ok(b) = serde_json::from_str::<Vec<HotkeyBinding>>(&c) {
                return Ok(b);
            }
        }
        Ok(Vec::new())
    }

    pub fn save_hotkeys(&self, bindings: &[HotkeyBinding]) -> KernelResult<()> {
        let dir = self.ensure_mindzj_dir()?;
        let json = serde_json::to_string_pretty(bindings)?;
        std::fs::write(dir.join("hotkeys.json"), json)?;
        Ok(())
    }

    // -- Index updates -------------------------------------------------------

    pub fn on_file_changed(&self, path: &str, content: &str) {
        if let Ok(mut li) = self.link_index.lock() {
            li.update_file_links(path, content);
        }
        if let Ok(mut si) = self.search_index.lock() {
            si.index_document(path, content);
        }
    }

    pub fn on_file_deleted(&self, path: &str) {
        if let Ok(mut li) = self.link_index.lock() {
            li.remove_file(path);
        }
        if let Ok(mut si) = self.search_index.lock() {
            si.remove_document(path);
        }
    }
}

// ---------------------------------------------------------------------------
// Central application state (shared across all Tauri windows)
// ---------------------------------------------------------------------------

/// Central application state shared across all Tauri commands.
///
/// Supports multiple simultaneous vaults — each Tauri window is mapped to
/// exactly one vault via `window_vault_map`.
pub struct AppState {
    /// Open vaults keyed by canonicalized path string.
    pub vaults: RwLock<HashMap<String, Arc<VaultContext>>>,
    /// Window label -> vault path key mapping.
    pub window_vault_map: RwLock<HashMap<String, String>>,
    /// Recently opened vaults.
    pub recent_vaults: Mutex<Vec<VaultInfo>>,
}

impl AppState {
    /// Create a new AppState with no open vaults.
    pub fn new() -> Self {
        Self {
            vaults: RwLock::new(HashMap::new()),
            window_vault_map: RwLock::new(HashMap::new()),
            recent_vaults: Mutex::new(Vec::new()),
        }
    }

    /// Open a vault and associate it with the calling window.
    ///
    /// If the vault is already open (from another window), reuses the existing
    /// `VaultContext` and simply adds a new window mapping.
    pub fn open_vault(
        &self,
        path: PathBuf,
        name: &str,
        window_label: &str,
    ) -> KernelResult<(VaultInfo, Arc<VaultContext>)> {
        let vault = Vault::open(&path, name)?;
        let vault_info = vault.info().clone();
        let key = vault.root().to_string_lossy().to_string();

        // Reuse existing context if the same vault is already open
        {
            let vaults = self.vaults.read().map_err(|_| {
                KernelError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "Vaults lock poisoned",
                ))
            })?;
            if let Some(ctx) = vaults.get(&key) {
                let mut map = self.window_vault_map.write().map_err(|_| {
                    KernelError::Io(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "Window map lock poisoned",
                    ))
                })?;
                map.insert(window_label.to_string(), key);
                return Ok((vault_info, ctx.clone()));
            }
        }

        // Create new vault context
        let ctx = Arc::new(VaultContext {
            vault,
            link_index: Mutex::new(LinkIndex::new()),
            search_index: Mutex::new(SearchIndex::new()),
            settings: RwLock::new(AppSettings::default()),
            watcher: Mutex::new(None),
        });

        // Build indexes from vault content
        Self::build_indexes(&ctx)?;

        // Load per-vault settings
        let _ = ctx.load_settings();

        // Store the vault context
        {
            let mut vaults = self.vaults.write().map_err(|_| {
                KernelError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "Vaults lock poisoned",
                ))
            })?;
            vaults.insert(key.clone(), ctx.clone());
        }

        // Map this window to the vault
        {
            let mut map = self.window_vault_map.write().map_err(|_| {
                KernelError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "Window map lock poisoned",
                ))
            })?;
            map.insert(window_label.to_string(), key);
        }

        // Add to recent vaults
        if let Ok(mut recent) = self.recent_vaults.lock() {
            recent.retain(|v| v.path != vault_info.path);
            recent.insert(0, vault_info.clone());
            if recent.len() > 10 {
                recent.truncate(10);
            }
        }

        info!("Vault opened and indexed: {}", name);
        Ok((vault_info, ctx))
    }

    /// Look up the vault context for the window that issued the command.
    ///
    /// Tauri auto-injects `window: WebviewWindow` into commands, so each
    /// command can identify which vault it should operate on.
    pub fn get_vault_context(
        &self,
        window_label: &str,
    ) -> Result<Arc<VaultContext>, CommandError> {
        let map = self.window_vault_map.read().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire window map lock".into(),
        })?;

        let vault_path = map.get(window_label).ok_or(CommandError {
            code: "NO_VAULT".into(),
            message: format!("No vault associated with window '{}'", window_label),
        })?;

        let vaults = self.vaults.read().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire vaults lock".into(),
        })?;

        vaults.get(vault_path).cloned().ok_or(CommandError {
            code: "NO_VAULT".into(),
            message: "Vault context not found".into(),
        })
    }

    // -----------------------------------------------------------------------
    // Index building
    // -----------------------------------------------------------------------

    fn build_indexes(ctx: &VaultContext) -> KernelResult<()> {
        let entries = ctx.vault.file_tree(10)?;

        let mut li = ctx.link_index.lock().map_err(|_| {
            KernelError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Link index lock poisoned",
            ))
        })?;

        let mut si = ctx.search_index.lock().map_err(|_| {
            KernelError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Search index lock poisoned",
            ))
        })?;

        Self::index_entries_recursive(&ctx.vault, &entries, &mut li, &mut si)?;

        info!(
            "Indexes built: {} documents in search index",
            si.document_count()
        );
        Ok(())
    }

    fn index_entries_recursive(
        vault: &Vault,
        entries: &[VaultEntry],
        li: &mut LinkIndex,
        si: &mut SearchIndex,
    ) -> KernelResult<()> {
        for entry in entries {
            if entry.is_dir {
                if let Some(ref children) = entry.children {
                    Self::index_entries_recursive(vault, children, li, si)?;
                }
            } else if entry.extension == "md" {
                if let Ok(fc) = vault.read_file(&entry.relative_path) {
                    li.register_file(&entry.relative_path);
                    li.update_file_links(&entry.relative_path, &fc.content);
                    si.index_document(&entry.relative_path, &fc.content);
                }
            }
        }
        Ok(())
    }
}
