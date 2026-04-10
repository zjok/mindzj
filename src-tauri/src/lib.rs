mod api;
mod kernel;

use api::settings_api::{apply_window_state, load_window_state_sync};
use kernel::AppState;
use tauri::Manager;

/// High-resolution PNG used to overwrite whatever icon Tauri's codegen
/// embedded from `tauri.conf.json`. Required because Tauri v2's codegen
/// only reads the FIRST entry of an .ico file (see
/// https://github.com/tauri-apps/tauri/issues/14596), so without this
/// runtime override the taskbar/titlebar icon would be whichever size
/// happens to sit at `entries()[0]` — upscaled by Windows for every
/// DPI, which looks blurry at 100%/125%/150%. Embedding the 1024×1024
/// PNG at compile time lets Windows downsample it with high-quality
/// Lanczos for any taskbar size it needs.
const APP_ICON_PNG: &[u8] = include_bytes!("../icons/1024x1024.png");

/// Apply the high-resolution icon to a window at runtime. Called for
/// every webview window we create (main window in `setup()`, plus
/// `open_vault_window` and `open_file_in_split_window` for new windows).
fn apply_hires_icon(window: &tauri::WebviewWindow) {
    match tauri::image::Image::from_bytes(APP_ICON_PNG) {
        Ok(icon) => {
            if let Err(e) = window.set_icon(icon) {
                tracing::warn!(
                    "set_icon failed for window '{}': {}",
                    window.label(),
                    e
                );
            }
        }
        Err(e) => {
            tracing::warn!("failed to decode APP_ICON_PNG: {}", e);
        }
    }
}

/// Exit the application cleanly. Used for explicit full-app shutdown.
/// Calling `AppHandle::exit(0)` terminates the Tauri event loop
/// unconditionally, regardless of how many windows are open.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    tracing::info!("exit_app invoked — shutting down");
    app.exit(0);
}

/// Multi-window-aware close: if there are OTHER webview windows open,
/// only tear down the calling window; if this is the last window,
/// exit the whole app. The custom titlebar close button routes through
/// this so that closing one vault window doesn't kill all other open
/// vault windows.
///
/// For the last-window case we destroy the window FIRST and then call
/// `app.exit(0)` from a short timer. That sequence lets the WebView2
/// runtime unregister its Chromium window class before the process
/// tears down — otherwise Windows prints:
///
///     [ERROR:ui\gfx\win\window_impl.cc:134] Failed to unregister
///     class Chrome_WidgetWin_0. Error = 1412
///
/// ...which is harmless but ugly in the PowerShell output.
#[tauri::command]
fn close_or_exit(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let windows = app.webview_windows();
    let count = windows.len();
    tracing::info!(
        "close_or_exit invoked — window='{}', total_windows={}",
        window.label(),
        count
    );
    if count > 1 {
        // Multiple windows open — only close this one. `destroy()`
        // bypasses the close-requested event so the tear-down is
        // unconditional.
        window.destroy().map_err(|e| e.to_string())?;
    } else {
        // Last remaining window. Destroy it first so WebView2 starts
        // its cleanup, then schedule the app.exit on a background
        // thread with a small delay so Chromium has time to unregister
        // its window class before the Rust process terminates.
        window.destroy().map_err(|e| e.to_string())?;
        let app_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            app_handle.exit(0);
        });
    }
    Ok(())
}

/// Open a new MindZJ window for a specific vault.
///
/// Before creating a new window, checks if any existing window already has
/// this vault open (via the window_vault_map) and focuses it instead.
///
/// New windows are created hidden and then shown after the saved window
/// geometry is applied, so they never flash at the default size.
#[tauri::command]
async fn open_vault_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    vault_path: String,
    vault_name: String,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    // Canonicalize the requested vault path for reliable comparison
    let canonical = std::fs::canonicalize(&vault_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(&vault_path));
    let canonical_str = canonical.to_string_lossy().to_string();

    // Check if ANY existing window already has this vault open (handles the
    // "main" window case where the label doesn't follow the vault_* pattern)
    if let Ok(map) = state.window_vault_map.read() {
        for (win_label, mapped_path) in map.iter() {
            if mapped_path == &canonical_str {
                if let Some(window) = app.get_webview_window(win_label) {
                    let _ = window.unminimize();
                    window.set_focus().map_err(|e| e.to_string())?;
                    return Ok(());
                }
            }
        }
    }

    // Fallback: check by generated label
    let label = format!("vault_{}", vault_path.replace(['/', '\\', ':', ' '], "_"));
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url_path = format!(
        "index.html?vault_path={}&vault_name={}",
        urlencoding::encode(&vault_path),
        urlencoding::encode(&vault_name)
    );

    // Read saved geometry BEFORE building the window so we can apply it
    // before the window is shown (avoids flash at the default size).
    let saved_state = load_window_state_sync(&app);
    let (w, h) = saved_state
        .as_ref()
        .and_then(|s| s.width.zip(s.height))
        .map(|(w, h)| (w as f64, h as f64))
        .unwrap_or((1280.0, 800.0));

    let mut builder = WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url_path.into()))
        .title(format!("MindZJ — {}", vault_name))
        .inner_size(w, h)
        .min_inner_size(100.0, 100.0)
        .resizable(true)
        .decorations(false)
        .visible(false);
    if let Some(ref s) = saved_state {
        if let (Some(x), Some(y)) = (s.x, s.y) {
            builder = builder.position(x as f64, y as f64);
        }
    }

    let window = builder.build().map_err(|e| e.to_string())?;

    apply_hires_icon(&window);

    // Apply full state (handles maximized flag and finalizes size/position)
    if let Some(ref s) = saved_state {
        apply_window_state(&window, s);
    }
    let _ = window.show();
    let _ = window.set_focus();

    Ok(())
}

/// Open a specific file in a new "split" webview window positioned
/// relative to the calling window.
///
/// This is used for tab right-click → "Split right/left/up/down" on
/// plugin-backed file types (e.g. `.mindzj`) where the plugin view
/// cannot be mounted twice in the same window because plugin views
/// are keyed by file path in a per-window Map. Opening a separate
/// window sidesteps the dual-mount problem — each window has its own
/// plugin registry so the same file can coexist.
///
/// The new window is positioned side-by-side with (or above/below)
/// the calling window, each taking half the calling window's size,
/// so the result looks like a real editor split.
#[tauri::command]
async fn open_file_in_split_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    vault_path: String,
    vault_name: String,
    file_path: String,
    view_mode: Option<String>,
    direction: String,
) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize, WebviewWindowBuilder};

    // --- Compute new geometry based on the direction -----------------
    //
    // "left"  → new window on the left half, shrink current to right half
    // "right" → new window on the right half, shrink current to left half
    // "up"    → new window on the top half,  shrink current to bottom half
    // "down"  → new window on the bottom half, shrink current to top half
    //
    // We use logical coordinates so the split looks correct on HiDPI.
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let current_pos = window.outer_position().map_err(|e| e.to_string())?;
    let current_size = window.outer_size().map_err(|e| e.to_string())?;
    let cx = current_pos.x as f64 / scale;
    let cy = current_pos.y as f64 / scale;
    let cw = current_size.width as f64 / scale;
    let ch = current_size.height as f64 / scale;

    // If the current window is maximized we don't shrink it (that feels
    // wrong — user loses their maximized state). Instead we spawn the
    // new window taking half the SCREEN work area in the requested
    // direction, and let the OS handle the layout.
    let is_maximized = window.is_maximized().unwrap_or(false);

    let (new_x, new_y, new_w, new_h, shrink_current) = if is_maximized {
        let monitor = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("no current monitor")?;
        let m_pos = monitor.position();
        let m_size = monitor.size();
        let mx = m_pos.x as f64 / scale;
        let my = m_pos.y as f64 / scale;
        let mw = m_size.width as f64 / scale;
        let mh = m_size.height as f64 / scale;
        match direction.as_str() {
            "left" => (mx, my, mw / 2.0, mh, None),
            "right" => (mx + mw / 2.0, my, mw / 2.0, mh, None),
            "up" => (mx, my, mw, mh / 2.0, None),
            "down" => (mx, my + mh / 2.0, mw, mh / 2.0, None),
            _ => return Err(format!("invalid direction: {}", direction)),
        }
    } else {
        match direction.as_str() {
            "left" => (
                cx,
                cy,
                cw / 2.0,
                ch,
                Some((cx + cw / 2.0, cy, cw / 2.0, ch)),
            ),
            "right" => (
                cx + cw / 2.0,
                cy,
                cw / 2.0,
                ch,
                Some((cx, cy, cw / 2.0, ch)),
            ),
            "up" => (
                cx,
                cy,
                cw,
                ch / 2.0,
                Some((cx, cy + ch / 2.0, cw, ch / 2.0)),
            ),
            "down" => (
                cx,
                cy + ch / 2.0,
                cw,
                ch / 2.0,
                Some((cx, cy, cw, ch / 2.0)),
            ),
            _ => return Err(format!("invalid direction: {}", direction)),
        }
    };

    // --- Build the URL with startup params --------------------------
    let mut url_path = format!(
        "index.html?vault_path={}&vault_name={}&file_path={}&split=1",
        urlencoding::encode(&vault_path),
        urlencoding::encode(&vault_name),
        urlencoding::encode(&file_path),
    );
    if let Some(mode) = view_mode.as_deref() {
        url_path.push_str("&view_mode=");
        url_path.push_str(&urlencoding::encode(mode));
    }

    // Unique label so multiple split windows can coexist.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let label = format!("split_{}_{}", direction, ts);

    let new_window = WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(url_path.into()),
    )
    .title(format!("MindZJ — {}", vault_name))
    .inner_size(new_w, new_h)
    .position(new_x, new_y)
    .min_inner_size(320.0, 240.0)
    .resizable(true)
    .decorations(false)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    apply_hires_icon(&new_window);

    let _ = new_window.show();
    let _ = new_window.set_focus();

    // Shrink the original window so the two panes live side-by-side.
    // We skip this when the source window was maximized — leaving it
    // maximized is less disruptive than unmaximizing it.
    if let Some((ox, oy, ow, oh)) = shrink_current {
        let _ = window.set_position(LogicalPosition::new(ox, oy));
        let _ = window.set_size(LogicalSize::new(ow, oh));
    }

    Ok(())
}

/// Configure and run the Tauri application.
///
/// This is the main setup function called by both desktop and mobile entry points.
/// It registers all Tauri commands, plugins, and initializes the application state.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mindzj=info".into()),
        )
        .init();

    tracing::info!("MindZJ v{} starting", env!("CARGO_PKG_VERSION"));

    // Install a Ctrl+C handler so pressing Ctrl+C in the terminal running
    // `tauri dev` (or otherwise receiving SIGINT) exits cleanly instead of
    // leaving PowerShell with the scary STATUS_CONTROL_C_EXIT (0xC000013A)
    // error. `set_handler` only succeeds once per process; in dev reloads
    // the second attempt is harmless.
    let _ = ctrlc::set_handler(|| {
        tracing::info!("Ctrl+C received — exiting");
        std::process::exit(0);
    });

    tauri::Builder::default()
        // Register plugins
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Initialize application state
        .manage(AppState::new())
        // Apply saved window geometry to the main window BEFORE it is shown,
        // so the app always opens at the user's last size/position regardless
        // of which vault is loaded. Without this hook the JS side has to
        // resize after boot, causing a visible flash.
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
                apply_hires_icon(&main_window);
                if let Some(state) = load_window_state_sync(&app.handle()) {
                    apply_window_state(&main_window, &state);
                }
                let _ = main_window.show();
            }
            Ok(())
        })
        // Register all Tauri commands (the Core API layer)
        .invoke_handler(tauri::generate_handler![
            // Window API
            open_vault_window,
            open_file_in_split_window,
            exit_app,
            close_or_exit,
            // Vault API
            api::vault_api::open_vault,
            api::vault_api::get_vault_info,
            api::vault_api::list_entries,
            api::vault_api::get_file_tree,
            api::vault_api::read_file,
            api::vault_api::write_file,
            api::vault_api::create_file,
            api::vault_api::delete_file,
            api::vault_api::rename_file,
            api::vault_api::create_dir,
            api::vault_api::delete_dir,
            api::vault_api::get_file_metadata,
            api::vault_api::list_snapshots,
            api::vault_api::restore_snapshot,
            api::vault_api::list_css_snippets,
            api::vault_api::read_css_snippet,
            api::vault_api::get_snippets_dir,
            api::vault_api::write_binary_file,
            api::vault_api::read_binary_file,
            api::vault_api::reveal_in_file_manager,
            api::vault_api::open_path_in_file_manager,
            api::vault_api::open_in_default_app,
            // Search & Link API
            api::search_api::search_vault,
            api::search_api::get_forward_links,
            api::search_api::get_backlinks,
            api::search_api::get_graph_data,
            api::search_api::get_unresolved_links,
            // Settings API
            api::settings_api::get_settings,
            api::settings_api::update_settings,
            api::settings_api::set_theme,
            api::settings_api::set_font_size,
            api::settings_api::set_view_mode,
            // Workspace API
            api::settings_api::load_workspace,
            api::settings_api::save_workspace,
            // Hotkeys API
            api::settings_api::get_hotkeys,
            api::settings_api::save_hotkeys,
            // Global window state API
            api::settings_api::get_window_state,
            api::settings_api::save_window_state,
            // Plugin API
            api::plugin_api::list_plugins,
            api::plugin_api::toggle_plugin,
            api::plugin_api::delete_plugin,
            api::plugin_api::read_plugin_main,
            api::plugin_api::read_plugin_styles,
            // Screenshot API
            api::screenshot_api::capture_screen,
            api::screenshot_api::save_screenshot_to_temp,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run MindZJ application");
}
