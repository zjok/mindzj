use crate::kernel::error::{KernelError, KernelResult};
use crate::kernel::types::{AppSettings, FileContent, FileMetadata, VaultEntry, VaultInfo};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};
use tracing::{info, warn};

/// Maximum number of file snapshots to keep per file for recovery.
const MAX_SNAPSHOTS_PER_FILE: usize = 50;

/// The hidden config directory inside each vault.
const VAULT_CONFIG_DIR: &str = ".mindzj";

/// Manages all file I/O for a single vault.
/// All filesystem operations MUST go through this module —
/// direct `fs::*` calls from other modules are forbidden.
///
/// # Safety guarantees
/// - Atomic writes via temp file + fsync + rename
/// - Path traversal prevention (no escaping vault root)
/// - Automatic snapshots for file recovery
/// - Concurrent read safety via RwLock on write operations
pub struct Vault {
    /// Vault metadata
    info: VaultInfo,
    /// Absolute, canonicalized vault root path
    root: PathBuf,
    /// Write lock to ensure atomic file operations
    write_lock: RwLock<()>,
    /// In-memory cache of file metadata (path -> metadata)
    #[allow(dead_code)]
    metadata_cache: Arc<RwLock<HashMap<String, FileMetadata>>>,
}

impl Vault {
    fn replace_with_temp(tmp_path: &Path, target_path: &Path) -> KernelResult<()> {
        match fs::rename(tmp_path, target_path) {
            Ok(()) => Ok(()),
            Err(err)
                if target_path.exists()
                    && matches!(
                        err.kind(),
                        std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
                    ) =>
            {
                fs::remove_file(target_path)?;
                fs::rename(tmp_path, target_path)?;
                Ok(())
            }
            Err(err) => Err(KernelError::Io(err)),
        }
    }

    fn rename_case_only(from_path: &Path, to_path: &Path) -> KernelResult<()> {
        let parent = from_path.parent().ok_or_else(|| {
            KernelError::InvalidFileName(from_path.display().to_string())
        })?;
        let file_name = from_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("entry");

        let mut temp_path = None;
        for i in 0..1000 {
            let candidate = parent.join(format!(
                ".{}.mindzj-case-rename-{}-{}.tmp",
                file_name,
                std::process::id(),
                i
            ));
            if !candidate.exists() {
                temp_path = Some(candidate);
                break;
            }
        }
        let temp_path = temp_path.ok_or_else(|| {
            KernelError::Io(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "Unable to allocate a temporary rename path",
            ))
        })?;

        fs::rename(from_path, &temp_path)?;
        if let Err(err) = fs::rename(&temp_path, to_path) {
            let _ = fs::rename(&temp_path, from_path);
            return Err(KernelError::Io(err));
        }

        Ok(())
    }

    /// Open an existing vault or initialize a new one at the given path.
    ///
    /// Creates the `.mindzj/` config directory if it doesn't exist.
    /// Returns an error if the path doesn't exist and can't be created.
    pub fn open(path: impl AsRef<Path>, name: &str) -> KernelResult<Self> {
        let root = path.as_ref().to_path_buf();

        // Ensure the vault directory exists
        if !root.exists() {
            fs::create_dir_all(&root)?;
            info!("Created new vault directory: {}", root.display());
        }

        // Canonicalize to resolve symlinks and get absolute path
        let root = root
            .canonicalize()
            .map_err(|e| KernelError::Io(e))?;

        // Create .mindzj config directory with full structure
        let config_dir = root.join(VAULT_CONFIG_DIR);
        if !config_dir.exists() {
            fs::create_dir_all(&config_dir)?;
        }

        // Create subdirectories
        let subdirs = ["snapshots", "plugins", "snippets", "themes", "images"];
        for subdir in &subdirs {
            let d = config_dir.join(subdir);
            if !d.exists() {
                fs::create_dir_all(&d)?;
            }
        }

        // Create default config files (only if they don't already exist)
        let default_files: &[(&str, &str)] = &[
            ("app.json", "{}"),
            ("appearance.json", "{}"),
            ("hotkeys.json", "[]"),
            (
                "workspace.json",
                r#"{"open_files":[],"active_file":null,"sidebar_tab":"files","sidebar_collapsed":false,"sidebar_width":260,"sidebar_tab_order":["files","outline","search","calendar"]}"#,
            ),
            ("plugins.json", "[]"),
            ("graph.json", "{}"),
            ("backlink.json", "{}"),
            ("types.json", "{}"),
        ];

        for (name, default_content) in default_files {
            let f = config_dir.join(name);
            if !f.exists() {
                fs::write(&f, default_content)?;
            }
        }

        // Create default settings.json with explicit attachment_folder
        // so new vaults are immediately configured to store pasted images
        // in .mindzj/images/.
        let settings_file = config_dir.join("settings.json");
        if !settings_file.exists() {
            let json = serde_json::to_string_pretty(&AppSettings::default())
                .unwrap_or_else(|_| r#"{"attachment_folder":".mindzj/images"}"#.to_string());
            fs::write(&settings_file, json)?;
        }

        let info = VaultInfo {
            name: name.to_string(),
            path: root.clone(),
            created_at: Utc::now(),
            last_opened: Utc::now(),
        };

        info!("Vault opened: {} at {}", name, root.display());

        Ok(Self {
            info,
            root,
            write_lock: RwLock::new(()),
            metadata_cache: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// Get vault metadata.
    pub fn info(&self) -> &VaultInfo {
        &self.info
    }

    /// Get the vault root path.
    pub fn root(&self) -> &Path {
        &self.root
    }

    // -----------------------------------------------------------------------
    // Path safety
    // -----------------------------------------------------------------------

    /// Resolve a relative path to an absolute path within the vault.
    /// Returns an error if the resolved path escapes the vault root
    /// (path traversal attack prevention).
    fn resolve_safe_path(&self, relative: &str) -> KernelResult<PathBuf> {
        // Reject obviously malicious patterns
        if relative.contains("..") {
            // Do a component-level check to catch "../" attempts
            let path = Path::new(relative);
            for component in path.components() {
                if matches!(component, Component::ParentDir) {
                    return Err(KernelError::PathTraversalDenied(
                        relative.to_string(),
                    ));
                }
            }
        }

        let full_path = self.root.join(relative);

        // Canonicalize if the path exists (resolves symlinks)
        let resolved = if full_path.exists() {
            full_path.canonicalize()?
        } else {
            // For new files, canonicalize the parent and append the filename
            if let Some(parent) = full_path.parent() {
                if parent.exists() {
                    let canonical_parent = parent.canonicalize()?;
                    if let Some(file_name) = full_path.file_name() {
                        canonical_parent.join(file_name)
                    } else {
                        return Err(KernelError::InvalidFileName(
                            relative.to_string(),
                        ));
                    }
                } else {
                    full_path.clone()
                }
            } else {
                full_path.clone()
            }
        };

        // Ensure the resolved path is within the vault root
        if !resolved.starts_with(&self.root) {
            return Err(KernelError::PathTraversalDenied(format!(
                "Path '{}' resolves to '{}' which is outside vault root '{}'",
                relative,
                resolved.display(),
                self.root.display()
            )));
        }

        Ok(resolved)
    }

    fn resolve_safe_rename_target(&self, relative: &str) -> KernelResult<PathBuf> {
        // Reject obviously malicious patterns
        if relative.contains("..") {
            // Do a component-level check to catch "../" attempts
            let path = Path::new(relative);
            for component in path.components() {
                if matches!(component, Component::ParentDir) {
                    return Err(KernelError::PathTraversalDenied(
                        relative.to_string(),
                    ));
                }
            }
        }

        let full_path = self.root.join(relative);
        let resolved = if let Some(parent) = full_path.parent() {
            if parent.exists() {
                let canonical_parent = parent.canonicalize()?;
                if let Some(file_name) = full_path.file_name() {
                    canonical_parent.join(file_name)
                } else {
                    return Err(KernelError::InvalidFileName(
                        relative.to_string(),
                    ));
                }
            } else {
                full_path.clone()
            }
        } else {
            full_path.clone()
        };

        // Ensure the resolved path is within the vault root
        if !resolved.starts_with(&self.root) {
            return Err(KernelError::PathTraversalDenied(format!(
                "Path '{}' resolves to '{}' which is outside vault root '{}'",
                relative,
                resolved.display(),
                self.root.display()
            )));
        }

        Ok(resolved)
    }

    /// Validate that a file name is safe to use.
    fn validate_file_name(name: &str) -> KernelResult<()> {
        if name.is_empty() {
            return Err(KernelError::InvalidFileName(
                "File name cannot be empty".to_string(),
            ));
        }

        // Forbid control characters and path separators in names
        let forbidden = ['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|'];
        for c in forbidden {
            if name.contains(c) {
                return Err(KernelError::InvalidFileName(format!(
                    "File name '{}' contains forbidden character '{}'",
                    name, c
                )));
            }
        }

        // Forbid names that are all dots
        if name.chars().all(|c| c == '.') {
            return Err(KernelError::InvalidFileName(format!(
                "File name '{}' is not allowed",
                name
            )));
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // File read operations
    // -----------------------------------------------------------------------

    /// Read the content of a file.
    pub fn read_file(&self, relative_path: &str) -> KernelResult<FileContent> {
        let abs_path = self.resolve_safe_path(relative_path)?;

        if !abs_path.exists() {
            return Err(KernelError::FileNotFound(relative_path.to_string()));
        }

        if !abs_path.is_file() {
            return Err(KernelError::FileNotFound(format!(
                "'{}' is not a file",
                relative_path
            )));
        }

        let content = fs::read_to_string(&abs_path)?;
        let modified = fs::metadata(&abs_path)?
            .modified()?
            .into();

        // Compute SHA-256 hash for conflict detection
        let hash = Self::compute_hash(&content);

        Ok(FileContent {
            path: relative_path.to_string(),
            content,
            modified,
            hash,
        })
    }

    /// List all entries in a directory.
    pub fn list_entries(&self, relative_dir: &str) -> KernelResult<Vec<VaultEntry>> {
        let abs_path = if relative_dir.is_empty() {
            self.root.clone()
        } else {
            self.resolve_safe_path(relative_dir)?
        };

        if !abs_path.is_dir() {
            return Err(KernelError::FileNotFound(format!(
                "'{}' is not a directory",
                relative_dir
            )));
        }

        let mut entries = Vec::new();

        for entry in fs::read_dir(&abs_path)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden files/dirs (starting with '.') in the listing
            if file_name.starts_with('.') {
                continue;
            }

            let metadata = entry.metadata()?;
            let modified: chrono::DateTime<Utc> = metadata.modified()?.into();
            let is_dir = metadata.is_dir();

            let relative = if relative_dir.is_empty() {
                file_name.clone()
            } else {
                format!("{}/{}", relative_dir, file_name)
            };

            let extension = if is_dir {
                String::new()
            } else {
                Path::new(&file_name)
                    .extension()
                    .map(|e| e.to_string_lossy().to_string())
                    .unwrap_or_default()
            };

            entries.push(VaultEntry {
                name: file_name,
                relative_path: relative,
                is_dir,
                size: if is_dir { 0 } else { metadata.len() },
                modified,
                extension,
                children: None,
            });
        }

        // Sort: directories first, then alphabetically
        entries.sort_by(|a, b| {
            b.is_dir.cmp(&a.is_dir).then(
                a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            )
        });

        Ok(entries)
    }

    /// Build a complete file tree (recursive) up to a maximum depth.
    pub fn file_tree(&self, max_depth: u32) -> KernelResult<Vec<VaultEntry>> {
        self.build_tree("", 0, max_depth)
    }

    /// List `.css` files directly under `.mindzj/snippets/`. Used by the
    /// Appearance settings page to show the user's  CSS
    /// snippets. Returns just the base filenames (without extension) so
    /// the caller can show a clean list and persist the enabled-state map
    /// keyed by snippet name. The `.mindzj/snippets/` directory is
    /// created on demand so opening the folder always succeeds.
    pub fn list_css_snippets(&self) -> KernelResult<Vec<String>> {
        let snippets_dir = self.root.join(".mindzj").join("snippets");
        if !snippets_dir.exists() {
            fs::create_dir_all(&snippets_dir)?;
            return Ok(Vec::new());
        }
        if !snippets_dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut names: Vec<String> = Vec::new();
        for entry in fs::read_dir(&snippets_dir)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.to_lowercase().ends_with(".css") && entry.metadata()?.is_file() {
                names.push(file_name);
            }
        }
        names.sort();
        Ok(names)
    }

    /// Read the content of a CSS snippet by its filename (e.g. `dark.css`).
    /// The file must live directly inside `.mindzj/snippets/`.
    pub fn read_css_snippet(&self, name: &str) -> KernelResult<String> {
        // Reject any path separators — snippet names are flat file names.
        if name.contains('/') || name.contains('\\') || name.starts_with('.') {
            return Err(KernelError::PathTraversalDenied(name.to_string()));
        }
        let path = self.root.join(".mindzj").join("snippets").join(name);
        if !path.exists() || !path.is_file() {
            return Err(KernelError::FileNotFound(name.to_string()));
        }
        Ok(fs::read_to_string(&path)?)
    }

    /// Absolute filesystem path of the snippets directory, creating it
    /// on demand. Used by the "Open snippets folder" button to reveal
    /// the directory in Windows Explorer.
    pub fn snippets_dir(&self) -> KernelResult<PathBuf> {
        let dir = self.root.join(".mindzj").join("snippets");
        if !dir.exists() {
            fs::create_dir_all(&dir)?;
        }
        Ok(dir)
    }

    // -----------------------------------------------------------------------
    // Custom theme (skin) storage — same model as CSS snippets, but the
    // enabled theme is singular (at most one custom skin active) and is
    // referenced from `settings.theme` as `custom:<bare_name>`.
    // -----------------------------------------------------------------------

    /// Absolute path of the per-vault themes directory. Created on demand
    /// so callers can always rely on the directory existing.
    pub fn themes_dir(&self) -> KernelResult<PathBuf> {
        let dir = self.root.join(".mindzj").join("themes");
        if !dir.exists() {
            fs::create_dir_all(&dir)?;
        }
        Ok(dir)
    }

    /// List `.css` files directly under `.mindzj/themes/`. Each entry is
    /// a bare filename (e.g. `my-theme.css`). The bare stem without the
    /// `.css` extension is what gets stored in settings as
    /// `custom:<stem>`.
    pub fn list_themes(&self) -> KernelResult<Vec<String>> {
        let dir = self.themes_dir()?;
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut names: Vec<String> = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.to_lowercase().ends_with(".css") && entry.metadata()?.is_file() {
                names.push(file_name);
            }
        }
        names.sort();
        Ok(names)
    }

    /// Read the raw CSS content of a custom theme by its bare filename.
    /// The file must live directly inside `.mindzj/themes/`.
    pub fn read_theme(&self, name: &str) -> KernelResult<String> {
        // Reject any path separators — theme names are flat file names.
        if name.contains('/') || name.contains('\\') || name.starts_with('.') {
            return Err(KernelError::PathTraversalDenied(name.to_string()));
        }
        let path = self.themes_dir()?.join(name);
        if !path.exists() || !path.is_file() {
            return Err(KernelError::FileNotFound(name.to_string()));
        }
        Ok(fs::read_to_string(&path)?)
    }

    /// Copy a user-supplied `.css` file from an ABSOLUTE source path into
    /// `.mindzj/themes/`, preserving its original filename (but with the
    /// extension normalized to lowercase `.css`). Rejects non-`.css`
    /// inputs and files that would overwrite an existing theme unless
    /// `overwrite` is true.
    ///
    /// Returns the bare filename (e.g. `my-theme.css`) the user can
    /// reference as `custom:my-theme`.
    pub fn import_theme(
        &self,
        source_absolute_path: &str,
        overwrite: bool,
    ) -> KernelResult<String> {
        let src = Path::new(source_absolute_path);
        if !src.is_file() {
            return Err(KernelError::FileNotFound(source_absolute_path.to_string()));
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        if ext.as_deref() != Some("css") {
            return Err(KernelError::InvalidFileName(format!(
                "Theme file must have a .css extension, got '{}'",
                source_absolute_path
            )));
        }
        let stem = src
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| KernelError::InvalidFileName(source_absolute_path.to_string()))?;
        // Sanitize the stem: drop any character we forbid in vault file
        // names so a hostile path can't slip past `validate_file_name`.
        let sanitized_stem: String = stem
            .chars()
            .map(|c| {
                if matches!(c, '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                    '-'
                } else {
                    c
                }
            })
            .collect::<String>()
            .trim_matches(|c: char| c.is_whitespace() || c == '.')
            .to_string();
        if sanitized_stem.is_empty() {
            return Err(KernelError::InvalidFileName(source_absolute_path.to_string()));
        }
        Self::validate_file_name(&sanitized_stem)?;
        let file_name = format!("{}.css", sanitized_stem);
        let dest = self.themes_dir()?.join(&file_name);
        if dest.exists() && !overwrite {
            return Err(KernelError::FileAlreadyExists(file_name));
        }
        let bytes = fs::read(&src)?;
        fs::write(&dest, &bytes)?;
        Ok(file_name)
    }

    /// Delete a custom theme by its bare filename. No-op if the file
    /// doesn't exist (so the UI can safely re-issue deletes after an
    /// external delete).
    pub fn delete_theme(&self, name: &str) -> KernelResult<()> {
        if name.contains('/') || name.contains('\\') || name.starts_with('.') {
            return Err(KernelError::PathTraversalDenied(name.to_string()));
        }
        let path = self.themes_dir()?.join(name);
        if path.exists() && path.is_file() {
            fs::remove_file(&path)?;
        }
        Ok(())
    }

    /// Write a CSS string to `.mindzj/themes/<name>.css` (normalising
    /// the extension). Used by "Save as new theme" / scaffolding flows
    /// that don't start from an external file.
    pub fn write_theme(&self, bare_name: &str, content: &str) -> KernelResult<String> {
        let trimmed = bare_name.trim();
        if trimmed.is_empty() {
            return Err(KernelError::InvalidFileName("Theme name cannot be empty".into()));
        }
        // Strip any .css the caller may have tacked on, and re-append it
        // canonically. Keeps the on-disk filenames consistent.
        let stem = trimmed
            .strip_suffix(".css")
            .or_else(|| trimmed.strip_suffix(".CSS"))
            .unwrap_or(trimmed);
        Self::validate_file_name(stem)?;
        let file_name = format!("{}.css", stem);
        let dir = self.themes_dir()?;
        let dest = dir.join(&file_name);
        fs::write(&dest, content)?;
        Ok(file_name)
    }

    fn build_tree(
        &self,
        relative_dir: &str,
        current_depth: u32,
        max_depth: u32,
    ) -> KernelResult<Vec<VaultEntry>> {
        if current_depth >= max_depth {
            return Ok(Vec::new());
        }

        let mut entries = self.list_entries(relative_dir)?;

        for entry in &mut entries {
            if entry.is_dir {
                let children = self.build_tree(
                    &entry.relative_path,
                    current_depth + 1,
                    max_depth,
                )?;
                entry.children = Some(children);
            }
        }

        Ok(entries)
    }

    // -----------------------------------------------------------------------
    // File write operations (atomic + snapshot)
    // -----------------------------------------------------------------------

    /// Write content to a file using atomic write strategy.
    ///
    /// Steps:
    /// 1. Write content to a temporary file (.~name.tmp)
    /// 2. fsync the temporary file to ensure data is on disk
    /// 3. Atomically rename the temp file to the target path
    /// 4. Create a snapshot of the previous version (if file existed)
    pub fn write_file(
        &self,
        relative_path: &str,
        content: &str,
    ) -> KernelResult<FileContent> {
        let abs_path = self.resolve_safe_path(relative_path)?;

        // Validate the file name
        if let Some(name) = abs_path.file_name() {
            Self::validate_file_name(&name.to_string_lossy())?;
        }

        // Ensure parent directory exists
        if let Some(parent) = abs_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }

        // Take snapshot of existing file before overwriting
        if abs_path.exists() {
            if let Err(e) = self.create_snapshot(relative_path) {
                warn!(
                    "Failed to create snapshot for '{}': {}",
                    relative_path, e
                );
            }
        }

        // Acquire write lock for atomicity
        let _lock = self
            .write_lock
            .write()
            .map_err(|_| KernelError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Write lock poisoned",
            )))?;

        // Step 1: Write to temporary file
        let tmp_name = format!(
            ".~{}.tmp",
            abs_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        );
        let tmp_path = abs_path
            .parent()
            .unwrap_or(&self.root)
            .join(&tmp_name);

        let mut tmp_file = fs::File::create(&tmp_path)?;
        tmp_file.write_all(content.as_bytes())?;

        // Step 2: fsync to ensure data is on disk
        tmp_file.sync_all()?;

        // Step 3: Atomic rename. On Windows, renaming over an existing
        // destination can fail with "Access is denied"; remove-and-rename
        // keeps existing-note updates working after the snapshot above.
        Self::replace_with_temp(&tmp_path, &abs_path)?;

        info!("File written atomically: {}", relative_path);

        let hash = Self::compute_hash(content);
        let modified = fs::metadata(&abs_path)?.modified()?.into();

        Ok(FileContent {
            path: relative_path.to_string(),
            content: content.to_string(),
            modified,
            hash,
        })
    }

    /// Write raw bytes to a file (for images and other binary data).
    /// Uses the same atomic-write strategy as `write_file`.
    pub fn write_binary(&self, relative_path: &str, data: &[u8]) -> KernelResult<()> {
        let abs_path = self.resolve_safe_path(relative_path)?;

        if let Some(name) = abs_path.file_name() {
            Self::validate_file_name(&name.to_string_lossy())?;
        }

        if let Some(parent) = abs_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }

        let _lock = self
            .write_lock
            .write()
            .map_err(|_| KernelError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Write lock poisoned",
            )))?;

        let tmp_name = format!(
            ".~{}.tmp",
            abs_path.file_name().unwrap_or_default().to_string_lossy()
        );
        let tmp_path = abs_path.parent().unwrap_or(&self.root).join(&tmp_name);

        let mut tmp_file = fs::File::create(&tmp_path)?;
        tmp_file.write_all(data)?;
        tmp_file.sync_all()?;
        Self::replace_with_temp(&tmp_path, &abs_path)?;

        info!("Binary file written: {}", relative_path);
        Ok(())
    }

    /// Create a new file. Returns an error if the file already exists.
    pub fn create_file(
        &self,
        relative_path: &str,
        content: &str,
    ) -> KernelResult<FileContent> {
        let abs_path = self.resolve_safe_path(relative_path)?;

        if abs_path.exists() {
            return Err(KernelError::FileAlreadyExists(
                relative_path.to_string(),
            ));
        }

        self.write_file(relative_path, content)
    }

    /// Delete a file.
    pub fn delete_file(&self, relative_path: &str) -> KernelResult<()> {
        let abs_path = self.resolve_safe_path(relative_path)?;

        if !abs_path.exists() {
            return Err(KernelError::FileNotFound(relative_path.to_string()));
        }

        // Create a final snapshot before deletion
        if let Err(e) = self.create_snapshot(relative_path) {
            warn!(
                "Failed to create deletion snapshot for '{}': {}",
                relative_path, e
            );
        }

        let _lock = self.write_lock.write().map_err(|_| {
            KernelError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Write lock poisoned",
            ))
        })?;

        fs::remove_file(&abs_path)?;
        info!("File deleted: {}", relative_path);
        Ok(())
    }

    /// Rename/move a file within the vault.
    pub fn rename_file(
        &self,
        from: &str,
        to: &str,
    ) -> KernelResult<()> {
        let from_abs = self.resolve_safe_path(from)?;
        let to_abs = self.resolve_safe_rename_target(to)?;

        if !from_abs.exists() {
            return Err(KernelError::FileNotFound(from.to_string()));
        }
        let same_existing_entry = to_abs.exists()
            && from_abs.canonicalize()? == to_abs.canonicalize()?;
        if to_abs.exists() && !same_existing_entry {
            return Err(KernelError::FileAlreadyExists(to.to_string()));
        }

        // Validate destination file name
        if let Some(name) = to_abs.file_name() {
            Self::validate_file_name(&name.to_string_lossy())?;
        }

        // Ensure destination parent exists
        if let Some(parent) = to_abs.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }

        let _lock = self.write_lock.write().map_err(|_| {
            KernelError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "Write lock poisoned",
            ))
        })?;

        if same_existing_entry {
            if from_abs != to_abs {
                Self::rename_case_only(&from_abs, &to_abs)?;
            }
        } else {
            fs::rename(&from_abs, &to_abs)?;
        }
        info!("File renamed: {} -> {}", from, to);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Directory operations
    // -----------------------------------------------------------------------

    /// Create a new directory.
    pub fn create_dir(&self, relative_path: &str) -> KernelResult<()> {
        let abs_path = self.resolve_safe_path(relative_path)?;

        if abs_path.exists() {
            return Err(KernelError::FileAlreadyExists(
                relative_path.to_string(),
            ));
        }

        fs::create_dir_all(&abs_path)?;
        info!("Directory created: {}", relative_path);
        Ok(())
    }

    /// Delete a directory (must be empty unless recursive is true).
    pub fn delete_dir(
        &self,
        relative_path: &str,
        recursive: bool,
    ) -> KernelResult<()> {
        let abs_path = self.resolve_safe_path(relative_path)?;

        if !abs_path.exists() || !abs_path.is_dir() {
            return Err(KernelError::FileNotFound(relative_path.to_string()));
        }

        // Never allow deleting the vault root or config dir
        if abs_path == self.root
            || abs_path == self.root.join(VAULT_CONFIG_DIR)
        {
            return Err(KernelError::PermissionDenied(
                "Cannot delete vault root or config directory".to_string(),
            ));
        }

        if recursive {
            fs::remove_dir_all(&abs_path)?;
        } else {
            fs::remove_dir(&abs_path)?;
        }

        info!("Directory deleted: {} (recursive={})", relative_path, recursive);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Snapshot / recovery
    // -----------------------------------------------------------------------

    /// Create a snapshot of the current file content for recovery.
    fn create_snapshot(&self, relative_path: &str) -> KernelResult<()> {
        let abs_path = self.resolve_safe_path(relative_path)?;

        if !abs_path.exists() || !abs_path.is_file() {
            return Ok(()); // Nothing to snapshot
        }

        let content = fs::read(&abs_path)?;
        let timestamp = Utc::now().format("%Y%m%d_%H%M%S%.3f");

        // Encode the file path into a safe snapshot name
        let safe_name = relative_path.replace('/', "__");
        let snapshot_name = format!("{}_{}", safe_name, timestamp);

        let snapshots_dir = self
            .root
            .join(VAULT_CONFIG_DIR)
            .join("snapshots");
        let snapshot_path = snapshots_dir.join(&snapshot_name);

        fs::write(&snapshot_path, &content)?;

        // Prune old snapshots if over the limit
        self.prune_snapshots(&safe_name, &snapshots_dir)?;

        Ok(())
    }

    /// Remove old snapshots beyond the maximum limit.
    fn prune_snapshots(
        &self,
        safe_name_prefix: &str,
        snapshots_dir: &Path,
    ) -> KernelResult<()> {
        let mut matching: Vec<PathBuf> = fs::read_dir(snapshots_dir)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with(safe_name_prefix))
                    .unwrap_or(false)
            })
            .collect();

        // Sort by name (which includes timestamp) descending
        matching.sort();
        matching.reverse();

        // Remove snapshots beyond the limit
        for old in matching.iter().skip(MAX_SNAPSHOTS_PER_FILE) {
            if let Err(e) = fs::remove_file(old) {
                warn!("Failed to prune snapshot {}: {}", old.display(), e);
            }
        }

        Ok(())
    }

    /// List all available snapshots for a file.
    pub fn list_snapshots(
        &self,
        relative_path: &str,
    ) -> KernelResult<Vec<String>> {
        let safe_name = relative_path.replace('/', "__");
        let snapshots_dir = self
            .root
            .join(VAULT_CONFIG_DIR)
            .join("snapshots");

        if !snapshots_dir.exists() {
            return Ok(Vec::new());
        }

        let mut snapshots: Vec<String> = fs::read_dir(&snapshots_dir)?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with(&safe_name) {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        snapshots.sort();
        snapshots.reverse(); // Most recent first
        Ok(snapshots)
    }

    /// Restore a file from a specific snapshot.
    pub fn restore_snapshot(
        &self,
        relative_path: &str,
        snapshot_name: &str,
    ) -> KernelResult<FileContent> {
        let snapshots_dir = self
            .root
            .join(VAULT_CONFIG_DIR)
            .join("snapshots");
        let snapshot_path = snapshots_dir.join(snapshot_name);

        if !snapshot_path.exists() {
            return Err(KernelError::FileNotFound(format!(
                "Snapshot '{}' not found",
                snapshot_name
            )));
        }

        // Ensure snapshot is within the snapshots directory (prevent traversal)
        let canonical = snapshot_path.canonicalize()?;
        if !canonical.starts_with(snapshots_dir.canonicalize()?) {
            return Err(KernelError::PathTraversalDenied(
                snapshot_name.to_string(),
            ));
        }

        let content = fs::read_to_string(&snapshot_path)?;
        self.write_file(relative_path, &content)
    }

    // -----------------------------------------------------------------------
    // Utility
    // -----------------------------------------------------------------------

    /// Compute SHA-256 hash of content for conflict detection.
    fn compute_hash(content: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Get metadata for a specific file.
    pub fn file_metadata(&self, relative_path: &str) -> KernelResult<FileMetadata> {
        let abs_path = self.resolve_safe_path(relative_path)?;

        if !abs_path.exists() {
            return Err(KernelError::FileNotFound(relative_path.to_string()));
        }

        let fs_meta = fs::metadata(&abs_path)?;
        let content = if abs_path.is_file() {
            fs::read_to_string(&abs_path).unwrap_or_default()
        } else {
            String::new()
        };

        let is_markdown = abs_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown"))
            .unwrap_or(false);

        let word_count = content.split_whitespace().count() as u32;
        let char_count = content.chars().count() as u32;

        // Extract tags from content (#tag patterns)
        let tags = Self::extract_tags(&content);

        Ok(FileMetadata {
            relative_path: relative_path.to_string(),
            size: fs_meta.len(),
            created: fs_meta.created().unwrap_or(std::time::SystemTime::UNIX_EPOCH).into(),
            modified: fs_meta.modified()?.into(),
            is_markdown,
            word_count,
            char_count,
            tags,
            backlink_count: 0, // Populated by the link index
        })
    }

    /// Extract #tag patterns from markdown content.
    fn extract_tags(content: &str) -> Vec<String> {
        let mut tags = Vec::new();
        // Match #tag patterns (not inside code blocks)
        let mut in_code_block = false;

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("```") {
                in_code_block = !in_code_block;
                continue;
            }
            if in_code_block {
                continue;
            }

            // Find #tag patterns: # followed by word chars, not at start of line
            // (to avoid matching headings)
            for (i, _) in line.match_indices('#') {
                // Skip if this is a heading (# at start after optional whitespace)
                if trimmed.starts_with('#')
                    && (trimmed.len() == 1 || trimmed.as_bytes().get(1) == Some(&b' '))
                {
                    break;
                }

                // Check if this looks like a tag
                if i > 0 {
                    let before = line.as_bytes().get(i - 1);
                    if before.map(|b| b.is_ascii_alphanumeric()).unwrap_or(false) {
                        continue; // Part of a word, not a tag
                    }
                }

                let rest = &line[i + 1..];
                let tag: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == '/')
                    .collect();

                if !tag.is_empty() {
                    tags.push(tag);
                }
            }
        }

        tags.sort();
        tags.dedup();
        tags
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Vault) {
        let tmp = TempDir::new().unwrap();
        let vault = Vault::open(tmp.path(), "test").unwrap();
        (tmp, vault)
    }

    #[test]
    fn test_create_and_read_file() {
        let (_tmp, vault) = setup();
        let content = "# Hello World\n\nThis is a test note.";

        vault.create_file("test.md", content).unwrap();
        let read = vault.read_file("test.md").unwrap();

        assert_eq!(read.content, content);
        assert_eq!(read.path, "test.md");
        assert!(!read.hash.is_empty());
    }

    #[test]
    fn test_atomic_write_creates_no_tmp_files() {
        let (tmp, vault) = setup();

        vault.write_file("note.md", "initial").unwrap();
        vault.write_file("note.md", "updated").unwrap();

        // No .tmp files should remain
        let entries: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .collect();

        assert!(entries.is_empty(), "Temp files should be cleaned up");
    }

    #[test]
    fn test_path_traversal_prevention() {
        let (_tmp, vault) = setup();

        assert!(vault.read_file("../../../etc/passwd").is_err());
        assert!(vault.read_file("foo/../../..").is_err());
        assert!(vault.write_file("../escape.md", "evil").is_err());
    }

    #[test]
    fn test_snapshots() {
        let (_tmp, vault) = setup();

        vault.write_file("note.md", "version 1").unwrap();
        vault.write_file("note.md", "version 2").unwrap();
        vault.write_file("note.md", "version 3").unwrap();

        let snapshots = vault.list_snapshots("note.md").unwrap();
        // Should have 2 snapshots (v1 before v2, v2 before v3)
        assert_eq!(snapshots.len(), 2);
    }

    #[test]
    fn test_directory_operations() {
        let (_tmp, vault) = setup();

        vault.create_dir("subfolder").unwrap();
        vault.create_file("subfolder/note.md", "hello").unwrap();

        let entries = vault.list_entries("subfolder").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "note.md");
    }

    #[test]
    fn test_rename_file_case_change() {
        let (_tmp, vault) = setup();

        vault.create_file("note.md", "hello").unwrap();
        vault.rename_file("note.md", "Note.md").unwrap();

        let entries = vault.list_entries("").unwrap();
        assert!(entries.iter().any(|entry| entry.name == "Note.md"));
        assert!(!entries.iter().any(|entry| entry.name == "note.md"));
        assert_eq!(vault.read_file("Note.md").unwrap().content, "hello");
    }

    #[test]
    fn test_tag_extraction() {
        let content = r#"
# Heading

This has #tag1 and #tag2 in it.
Not a heading #rust/async here.

```
#not_a_tag inside code
```

Another #final-tag.
"#;
        let tags = Vault::extract_tags(content);
        assert!(tags.contains(&"tag1".to_string()));
        assert!(tags.contains(&"tag2".to_string()));
        assert!(tags.contains(&"rust/async".to_string()));
        assert!(tags.contains(&"final-tag".to_string()));
        assert!(!tags.contains(&"not_a_tag".to_string()));
    }

    #[test]
    fn test_invalid_file_names() {
        let (_tmp, vault) = setup();

        assert!(vault.create_file("fo:o.md", "bad").is_err());
        assert!(vault.create_file("fo*o.md", "bad").is_err());
        assert!(vault.create_file("", "bad").is_err());
    }
}
