mod api;
mod kernel;
// Kept on disk for reference / rollback but NOT installed at startup.
// The low-level WH_KEYBOARD_LL hook used to install here was the only
// in-process way to claim Ctrl+Alt+Left/Right tab-switching against
// Intel graphics driver hotkeys — but any `WH_KEYBOARD_LL` the app
// installs joins the system-wide hook chain, and even though the
// hook proc only consumes Ctrl+Alt+Arrow (falling through via
// `CallNextHookEx` for everything else), the added latency trips
// `LowLevelHooksTimeout` on this user's machine and causes Windows
// to silently drop Win+F, Win+E and PowerToys hotkeys. The correct
// fix is to disable Intel's screen-rotation hotkeys at the source
// (Intel Graphics Command Center → System → Hot Keys → off, or
// disable the `igfxHK` startup task). With Intel's hook out of the
// chain, Ctrl+Alt+Arrow arrives at the DOM keydown listener
// unmolested and the in-JS `handleTabSwitchKeydown` handles it.
#[cfg(windows)]
#[allow(dead_code)]
mod keyboard_hook;

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

/// Windows-only: disable WebView2's built-in browser accelerator keys
/// AND the default context menu.
///
/// Why: with the stock WebView2 settings, keyboard shortcuts like
/// Ctrl+F (find-in-page popup), F5 / Ctrl+R (refresh), Ctrl+P (print),
/// and the Alt-to-activate-menu-bar behaviour are handled inside the
/// webview BEFORE our DOM `keydown` listener sees them. The user kept
/// hitting this when focus was on the tab bar or sidebar: bare Alt
/// put the webview into menu mode, and the very next letter press
/// (e.g. G) fired the webview's built-in find-in-page dialog instead
/// of our Alt+G screenshot handler.
///
/// `SetAreBrowserAcceleratorKeysEnabled(false)` turns the whole family
/// off in one call. We re-implement the shortcuts we actually want
/// (Ctrl+F → in-app search, F12 → devtools) via the existing DOM
/// keydown handler in `App.tsx`, so disabling the webview's versions
/// doesn't lose functionality.
///
/// Also disables the default right-click menu. The frontend has
/// already suppressed it via a `contextmenu` preventDefault listener
/// (see App.tsx:608), but doing it at the WebView2 layer too stops
/// the menu from flashing on slow paints.
///
/// Non-fatal: any step that fails is logged and swallowed — the app
/// keeps working, just with the default WebView2 settings.
#[cfg(windows)]
fn disable_webview2_browser_accelerator_keys(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings3, ICoreWebView2_2,
    };
    // NOTE: `windows_core::Interface` — NOT `windows::core::Interface` —
    // because `webview2-com-sys 0.38` was generated against
    // `windows-core 0.61` and its COM interfaces only implement
    // `Interface` from that exact version. `windows 0.58` ships its
    // own `windows_core 0.58` under the `windows::core::` path and
    // `cast::<ICoreWebView2Settings3>()` would fail to resolve if we
    // reached for it here.
    use windows_core::Interface;

    let label = window.label().to_string();
    let result = window.with_webview(move |webview| unsafe {
        // `controller().CoreWebView2()` → the underlying
        // `ICoreWebView2` instance for this webview. Tauri only
        // exposes `controller()` on Windows, so this whole block is
        // already inside `#[cfg(windows)]`.
        let controller = webview.controller();
        let core_webview = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    "[webview2] CoreWebView2() failed on '{}': {:?}",
                    label,
                    e,
                );
                return;
            }
        };

        // `Settings()` returns `ICoreWebView2Settings`, which doesn't
        // have `AreBrowserAcceleratorKeysEnabled`. We need to cast to
        // the newer `ICoreWebView2Settings3` — shipped in WebView2
        // 88.0.705 / March 2021, so effectively always present on any
        // system that can install our app.
        let settings = match core_webview.Settings() {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    "[webview2] Settings() failed on '{}': {:?}",
                    label,
                    e,
                );
                return;
            }
        };

        // Default context menus off. Purely defensive — the JS side
        // already cancels `contextmenu` — but this prevents the
        // briefest paint of the native menu on slow frames.
        if let Err(e) = settings.SetAreDefaultContextMenusEnabled(false) {
            tracing::warn!(
                "[webview2] SetAreDefaultContextMenusEnabled(false) failed on '{}': {:?}",
                label,
                e,
            );
        }

        match settings.cast::<ICoreWebView2Settings3>() {
            Ok(settings3) => {
                if let Err(e) = settings3.SetAreBrowserAcceleratorKeysEnabled(false) {
                    tracing::warn!(
                        "[webview2] SetAreBrowserAcceleratorKeysEnabled(false) failed on '{}': {:?}",
                        label,
                        e,
                    );
                } else {
                    tracing::info!(
                        "[webview2] browser accelerator keys disabled on '{}'",
                        label,
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    "[webview2] cast to ICoreWebView2Settings3 failed on '{}': {:?}",
                    label,
                    e,
                );
            }
        }

        // Silence the unused-import warning on the ICoreWebView2_2
        // name — keeping the import available makes it easy to add
        // `NavigationStarting`-style callbacks here later without
        // chasing down the correct crate path again.
        let _ = std::marker::PhantomData::<ICoreWebView2_2>;
    });

    if let Err(e) = result {
        tracing::warn!(
            "[webview2] with_webview on '{}' failed to schedule: {:?}",
            window.label(),
            e,
        );
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

/// Open the webview devtools for the calling window.
///
/// The `devtools` Cargo feature on `tauri = { ... }` is already enabled
/// in `Cargo.toml`, so the underlying WebView2 runtime is compiled with
/// devtools support in both debug and release builds. This command is
/// the programmatic entry point — the frontend calls it from the
/// Ctrl+Shift+I global keydown handler so the shortcut works whether
/// or not WebView2 happens to have its own hotkey binding active.
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    tracing::info!("open_devtools invoked — window='{}'", window.label());
    window.open_devtools();
}

/// Minimize the calling window to the taskbar. Wired to Ctrl+M in the
/// frontend global keydown handler. We go through a Tauri command (as
/// opposed to calling `getCurrentWindow().minimize()` in JS) because
/// the JS path has occasionally raced with the capture-phase keydown
/// event's propagation and left the minimize silently dropped. A
/// dedicated Rust-side command is synchronous with respect to the
/// window handle and always takes effect.
#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) {
    tracing::info!("minimize_window invoked — window='{}'", window.label());
    if let Err(e) = window.minimize() {
        tracing::warn!("minimize_window failed: {}", e);
    }
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
    //
    // The fallback `(1080.0, 720.0)` matches the main window's
    // `inner_size` in `tauri.conf.json` — a compact, centered-
    // friendly default for the very first time the user opens a
    // new vault window (no persisted state yet). Matches the
    // first-launch behavior in `setup()` below.
    let saved_state = load_window_state_sync(&app);
    let (w, h) = saved_state
        .as_ref()
        .and_then(|s| s.width.zip(s.height))
        .map(|(w, h)| (w as f64, h as f64))
        .unwrap_or((1080.0, 720.0));

    let mut builder = WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url_path.into()))
        .title(format!("MindZJ — {}", vault_name))
        .inner_size(w, h)
        .min_inner_size(480.0, 320.0)
        .resizable(true)
        .decorations(false)
        // Paint the native window AND webview backbuffer dark to match
        // the theme. Without this, there's a brief white flash both on
        // startup (before WebView2's first paint) and during window
        // resize (where WebView2 lags the window geometry by a frame).
        .background_color(tauri::window::Color(30, 30, 30, 255))
        .visible(false);
    if let Some(ref s) = saved_state {
        if let (Some(x), Some(y)) = (s.x, s.y) {
            builder = builder.position(x as f64, y as f64);
        }
    }

    let window = builder.build().map_err(|e| e.to_string())?;

    apply_hires_icon(&window);
    #[cfg(windows)]
    disable_webview2_browser_accelerator_keys(&window);

    // Apply full state (handles maximized flag and finalizes size/position)
    if let Some(ref s) = saved_state {
        apply_window_state(&window, s);
    } else {
        // No saved state → center on the current monitor. Same
        // rationale as the main-window setup hook: first launch
        // shouldn't pin the window to the top-left corner.
        let _ = window.center();
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
    // Match the main window — dark native backbuffer to eliminate
    // white flash during startup and resize.
    .background_color(tauri::window::Color(30, 30, 30, 255))
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    apply_hires_icon(&new_window);
    #[cfg(windows)]
    disable_webview2_browser_accelerator_keys(&new_window);

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

/// Open an image file in a dedicated image-viewer window.
///
/// Used when the user clicks a .png / .jpg / .gif etc. in the file
/// tree. The new window loads `index.html?image_viewer=1&vault_path=
/// …&file_path=…`, and App.tsx has an early branch that detects the
/// `image_viewer=1` param and renders only the ImageViewer component
/// (no sidebar, no editor, no plugin system).
///
/// We reuse the asset protocol for the actual image bytes so there's
/// no base64 encoding or IPC round-trip involved — the `<img src>` in
/// the ImageViewer component resolves to `http://asset.localhost/…`
/// and WebView2 streams the bytes directly from disk.
#[tauri::command]
async fn open_image_in_new_window(
    app: tauri::AppHandle,
    vault_path: String,
    vault_name: String,
    file_path: String,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    let url_path = format!(
        "index.html?image_viewer=1&vault_path={}&vault_name={}&file_path={}",
        urlencoding::encode(&vault_path),
        urlencoding::encode(&vault_name),
        urlencoding::encode(&file_path),
    );

    // Unique label so multiple image-viewer windows can coexist.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let label = format!("image_viewer_{}", ts);

    // Title shows just the filename so it's readable in the taskbar.
    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&file_path)
        .to_string();

    let new_window = WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(url_path.into()),
    )
    .title(format!("MindZJ — {}", file_name))
    .inner_size(900.0, 700.0)
    .min_inner_size(320.0, 240.0)
    .resizable(true)
    .decorations(false)
    .background_color(tauri::window::Color(30, 30, 30, 255))
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    apply_hires_icon(&new_window);
    #[cfg(windows)]
    disable_webview2_browser_accelerator_keys(&new_window);

    let _ = new_window.show();
    let _ = new_window.set_focus();

    Ok(())
}

/// Configure and run the Tauri application.
///
/// This is the main setup function called by both desktop and mobile entry points.
/// It registers all Tauri commands, plugins, and initializes the application state.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging.
    //
    // Windows release builds are GUI-subsystem apps with no stdout, so
    // `tracing_subscriber::fmt()` would write into the void. We instead
    // tee logs into a rolling file under the per-user data directory
    // so that when the release exe misbehaves we can read the log
    // post-mortem without rebuilding.
    //
    // Debug builds keep stdout so `tauri dev` still shows logs live.
    let log_dir = dirs::data_local_dir()
        .map(|p| p.join("MindZJ").join("logs"))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&log_dir);
    let file_appender = tracing_appender::rolling::daily(&log_dir, "mindzj.log");
    // Leak the guard on purpose — we want the appender to live for the
    // entire process lifetime. The alternative (storing it in AppState)
    // fights the borrow checker for no practical benefit here.
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    std::mem::forget(guard);

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "mindzj=info,mindzj_lib=info".into());

    #[cfg(debug_assertions)]
    {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::util::SubscriberInitExt;
        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer())
            .with(tracing_subscriber::fmt::layer().with_writer(non_blocking).with_ansi(false))
            .init();
    }
    #[cfg(not(debug_assertions))]
    {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_writer(non_blocking)
            .with_ansi(false)
            .init();
    }

    tracing::info!("MindZJ v{} starting — logs at {}", env!("CARGO_PKG_VERSION"), log_dir.display());

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
                #[cfg(windows)]
                disable_webview2_browser_accelerator_keys(&main_window);
                if let Some(state) = load_window_state_sync(&app.handle()) {
                    apply_window_state(&main_window, &state);
                } else {
                    // No persisted window state — this is either
                    // the very first launch after install, or
                    // `.mindzj/window-state.json` was wiped. Place
                    // the window at the center of the primary
                    // monitor so the user doesn't see it pinned
                    // to the top-left corner on first run. The
                    // inner_size comes from tauri.conf.json
                    // (currently 1080×720, deliberately smaller
                    // than a typical screen so the centered
                    // window has plenty of desktop visible
                    // around it — the user explicitly asked for
                    // a more compact first-launch window).
                    //
                    // `WebviewWindow::center` uses the current
                    // monitor's geometry and accounts for DPI
                    // scaling; we don't have to compute positions
                    // manually.
                    let _ = main_window.center();
                }
                let _ = main_window.show();
            }
            // NOTE: `keyboard_hook::install(app.handle())` is
            // deliberately NOT called here. Installing any
            // WH_KEYBOARD_LL hook in-process adds latency to the
            // system-wide hook chain and, on the user's machine,
            // trips `LowLevelHooksTimeout` — Windows then drops
            // Win+F and PowerToys hotkeys. To enable Ctrl+Alt+Arrow
            // tab-switching, disable Intel's screen-rotation hotkeys
            // at the source instead (see the top-of-file comment on
            // `mod keyboard_hook`).
            Ok(())
        })
        // Register all Tauri commands (the Core API layer)
        .invoke_handler(tauri::generate_handler![
            // Window API
            open_vault_window,
            open_file_in_split_window,
            open_image_in_new_window,
            exit_app,
            close_or_exit,
            open_devtools,
            minimize_window,
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
            // Custom themes / skins
            api::vault_api::list_themes,
            api::vault_api::read_theme,
            api::vault_api::import_theme,
            api::vault_api::delete_theme,
            api::vault_api::write_theme,
            api::vault_api::get_themes_dir,
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
            api::settings_api::get_ai_api_key,
            api::settings_api::set_ai_api_key,
            api::settings_api::ai_chat_completion,
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
