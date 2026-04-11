//! Windows low-level keyboard hook.
//!
//! Why this exists:
//!
//! On Windows, the normal ways of claiming a global hotkey all have
//! their events intercepted BEFORE they reach us on a stock consumer
//! laptop:
//!
//!   1. DOM `keydown` on the WebView2 element — Intel Graphics Command
//!      Center's screen-rotation hotkeys (`Ctrl+Alt+←/→/↑/↓`) are
//!      installed via their own WH_KEYBOARD_LL hook and consume the
//!      keypress by returning 1 from the hook proc, so WebView2
//!      never sees the event.
//!   2. `RegisterHotKey` (via `tauri-plugin-global-shortcut` →
//!      `global-hotkey` → `RegisterHotKey`) — registered against
//!      the application's own message queue via `WM_HOTKEY`, which
//!      sits ABOVE the WH_KEYBOARD_LL hook chain. By the time a
//!      Ctrl+Alt+Left press reaches the hotkey table, the Intel
//!      driver's hook has already eaten it.
//!
//! The only way to win this race is to install OUR OWN
//! `SetWindowsHookExW(WH_KEYBOARD_LL, ...)` — a hook chain runs in
//! registration order, and we install first (at Tauri setup time,
//! before the Intel driver has installed its own hook for this
//! process). Even if the Intel driver installs first at system
//! level, our hook runs for our own process' input queue, which is
//! what matters when our window is focused.
//!
//! When the hook proc detects `Ctrl+Alt+Left` or `Ctrl+Alt+Right`,
//! it:
//!   1. Emits a Tauri event (`mindzj://tab-switch`) with the
//!      direction as payload. The JS side listens via
//!      `listen("mindzj://tab-switch", ...)` and calls
//!      `switchOpenTab(direction)` from the App.tsx context.
//!   2. Returns `LRESULT(1)` to consume the event so nothing
//!      downstream (including Intel's own hook, if it was later in
//!      the chain) sees it.

#![cfg(windows)]

use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LEFT, VK_MENU, VK_RIGHT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

/// Global AppHandle stash. Set once at hook-install time. The hook
/// proc runs on a Windows-owned thread so we can't pass it through
/// the normal Tauri `State<T>` channel; an owned `AppHandle` in a
/// `Mutex<Option<...>>` is the simplest thread-safe transport.
static APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);

/// Hook handle. Stored so `uninstall` can reverse the hook on exit.
/// `HHOOK` is a raw void pointer under the hood, not `Send`, so we
/// store it as an `isize` and cast back at unhook time.
static HOOK_HANDLE: Mutex<isize> = Mutex::new(0);

unsafe extern "system" fn keyboard_hook_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code >= 0 {
        let msg = w_param.0 as u32;
        // Arrow keys with Alt held fire WM_SYSKEYDOWN, not
        // WM_KEYDOWN, because Alt puts the window into "system"
        // menu mode. Both have to be handled.
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            let kbd = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
            let vk = kbd.vkCode;

            // `GetAsyncKeyState` high bit = currently pressed.
            // We read Ctrl + Alt state directly rather than
            // tracking them via prior keydown events because the
            // hook proc fires for EVERY key and tracking state
            // across calls is bug-prone.
            let ctrl_down =
                (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
            let alt_down =
                (GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0;

            if ctrl_down && alt_down {
                let is_left = vk == VK_LEFT.0 as u32;
                let is_right = vk == VK_RIGHT.0 as u32;

                if is_left || is_right {
                    let direction = if is_left { "prev" } else { "next" };
                    // Emit to the frontend. `emit` is synchronous
                    // but fast — it just drops the payload onto an
                    // internal channel for the JS main thread.
                    // Failures are logged and swallowed so a
                    // broken emit can never crash the hook proc
                    // (which would crash the whole process).
                    if let Ok(guard) = APP_HANDLE.lock() {
                        if let Some(handle) = guard.as_ref() {
                            if let Err(e) = handle.emit(
                                "mindzj://tab-switch",
                                direction.to_string(),
                            ) {
                                tracing::warn!(
                                    "[keyboard_hook] emit failed: {}",
                                    e
                                );
                            } else {
                                tracing::info!(
                                    "[keyboard_hook] emitted tab-switch '{}'",
                                    direction
                                );
                            }
                        }
                    }
                    // Consume the event so no one else (including a
                    // later Intel hook in the chain) sees it.
                    return LRESULT(1);
                }
            }
        }
    }
    CallNextHookEx(None, n_code, w_param, l_param)
}

/// Install the hook. Called once from Tauri's `setup()` after the
/// main window is created. The hook runs for the current thread
/// (the Tauri main thread). Further keyboard events generated in
/// this process that match Ctrl+Alt+Left/Right will fire the proc.
pub fn install(app: &AppHandle) {
    // Stash the AppHandle so the hook proc can reach the JS side.
    if let Ok(mut guard) = APP_HANDLE.lock() {
        *guard = Some(app.clone());
    }

    // `SetWindowsHookExW` with `WH_KEYBOARD_LL` requires a module
    // handle of zero and a null thread id — it installs a global
    // low-level hook that receives events for ALL threads on the
    // same desktop. We tried the thread-local variant but it only
    // sees events routed to that specific thread's message queue,
    // which excludes synthesized events from the Intel driver.
    unsafe {
        match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), None, 0) {
            Ok(hook) => {
                tracing::info!(
                    "[keyboard_hook] WH_KEYBOARD_LL installed, hook={:?}",
                    hook
                );
                if let Ok(mut guard) = HOOK_HANDLE.lock() {
                    *guard = hook.0 as isize;
                }
            }
            Err(e) => {
                tracing::warn!(
                    "[keyboard_hook] SetWindowsHookExW failed: {}",
                    e
                );
            }
        }
    }
}

/// Uninstall the hook. Called on app exit / window cleanup. Safe to
/// call even if `install` was never called — the stored handle is
/// zero in that case and `UnhookWindowsHookEx` on a zero hook is a
/// harmless no-op at our level (we just skip it).
#[allow(dead_code)]
pub fn uninstall() {
    if let Ok(mut guard) = HOOK_HANDLE.lock() {
        let raw = *guard;
        if raw != 0 {
            unsafe {
                let _ = UnhookWindowsHookEx(HHOOK(raw as *mut _));
            }
            *guard = 0;
        }
    }
    if let Ok(mut guard) = APP_HANDLE.lock() {
        *guard = None;
    }
}
