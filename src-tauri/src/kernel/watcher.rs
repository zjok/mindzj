use crate::kernel::types::FileEvent;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

/// File system watcher for a vault directory.
/// Monitors changes and emits events to the frontend.
pub struct VaultWatcher {
    _watcher: RecommendedWatcher,
}

impl VaultWatcher {
    /// Start watching a vault directory. Emits "file-changed" events to the frontend.
    pub fn new(vault_root: PathBuf, app_handle: AppHandle) -> notify::Result<Self> {
        let root = vault_root.clone();
        // Track files we recently wrote ourselves, to avoid echo events
        let self_writes: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
        // Debounce: track last event time per path
        let last_events: Arc<Mutex<std::collections::HashMap<PathBuf, Instant>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));

        let debounce_ms = 300;

        let handle = app_handle.clone();
        let root_clone = root.clone();
        let self_writes_clone = self_writes.clone();
        let last_events_clone = last_events.clone();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                Self::process_event(
                    &event,
                    &root_clone,
                    &handle,
                    &self_writes_clone,
                    &last_events_clone,
                    debounce_ms,
                );
            }
        })?;

        watcher.watch(&vault_root, RecursiveMode::Recursive)?;
        info!("File watcher started for {:?}", vault_root);

        Ok(Self { _watcher: watcher })
    }

    fn process_event(
        event: &Event,
        vault_root: &Path,
        app_handle: &AppHandle,
        self_writes: &Arc<Mutex<HashSet<PathBuf>>>,
        last_events: &Arc<Mutex<std::collections::HashMap<PathBuf, Instant>>>,
        debounce_ms: u64,
    ) {
        for path in &event.paths {
            // Skip .mindzj directory changes
            if let Ok(rel) = path.strip_prefix(vault_root) {
                let rel_str = rel.to_string_lossy();
                if rel_str.starts_with(".mindzj") || rel_str.starts_with(".git") {
                    return;
                }
                // Skip temporary files
                if rel_str.ends_with(".tmp") || rel_str.ends_with("~") {
                    return;
                }
            } else {
                return;
            }

            // Skip self-written files
            if let Ok(mut writes) = self_writes.lock() {
                if writes.remove(path) {
                    return;
                }
            }

            // Debounce: skip if we got an event for this path recently
            if let Ok(mut events) = last_events.lock() {
                let now = Instant::now();
                if let Some(last) = events.get(path) {
                    if now.duration_since(*last) < Duration::from_millis(debounce_ms) {
                        return;
                    }
                }
                events.insert(path.clone(), now);
                // Clean up old entries
                events.retain(|_, t| now.duration_since(*t) < Duration::from_secs(10));
            }

            let relative = path
                .strip_prefix(vault_root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");

            let file_event = match event.kind {
                EventKind::Create(_) => Some(FileEvent::Created {
                    path: relative.clone(),
                }),
                EventKind::Modify(_) => Some(FileEvent::Modified {
                    path: relative.clone(),
                }),
                EventKind::Remove(_) => Some(FileEvent::Deleted {
                    path: relative.clone(),
                }),
                _ => None,
            };

            if let Some(fe) = file_event {
                if let Err(e) = app_handle.emit("file-changed", &fe) {
                    warn!("Failed to emit file-changed event: {}", e);
                }
            }
        }
    }

    /// Register a path as a self-write (to suppress echo watcher events).
    /// Not currently wired, but available for future use.
    #[allow(dead_code)]
    pub fn register_self_write(&self, _path: &Path) {
        // Would need access to self_writes Arc - future enhancement
    }
}
