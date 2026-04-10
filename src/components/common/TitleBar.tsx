import { Component, Show, createSignal, onMount, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { createPersistableWindowState } from "../../utils/windowState";

/**
 * Window control buttons (minimize, maximize/restore, close).
 * Designed to be embedded in the tab bar — no wrapping container or drag region.
 */
export const WindowControls: Component = () => {
    const [isMaximized, setIsMaximized] = createSignal(false);
    const appWindow = getCurrentWindow();

    onMount(async () => {
        setIsMaximized(await appWindow.isMaximized());

        const unlisten = await appWindow.onResized(async () => {
            setIsMaximized(await appWindow.isMaximized());
        });
        onCleanup(() => { unlisten(); });
    });

    const minimize = () => appWindow.minimize();
    const toggleMaximize = () => appWindow.toggleMaximize();

    // Close button: capture the current window geometry, persist it,
    // then route through the Rust `close_or_exit` command. That command
    // is multi-window aware — if other vault windows are still open it
    // destroys only THIS window; if this is the last one it calls
    // `app.exit(0)` to shut the app down cleanly.
    //
    // We go through Rust instead of `appWindow.close()` / `destroy()`
    // directly because the Rust-side check is atomic with the tear-down
    // (no JS races) and because earlier revisions found both JS paths
    // flaky on Windows.
    const close = async () => {
        try {
            await (window as any).__mindzj_flush_workspace?.();
        } catch (e) {
            console.warn("[WindowControls] workspace flush failed:", e);
        }
        try {
            const maximized = await appWindow.isMaximized();
            if (maximized) {
                await invoke("save_window_state", { windowState: { maximized: true } });
            } else {
                const pos = await appWindow.outerPosition();
                const size = await appWindow.outerSize();
                const sf = await appWindow.scaleFactor();
                const windowState = createPersistableWindowState({
                    x: pos.x / sf,
                    y: pos.y / sf,
                    width: size.width / sf,
                    height: size.height / sf,
                });
                if (!windowState) {
                    throw new Error("Refusing to persist invalid window bounds");
                }
                await invoke("save_window_state", {
                    windowState,
                });
            }
        } catch (e) {
            console.warn("[WindowControls] final save failed:", e);
        }
        try {
            await invoke("close_or_exit");
        } catch (e) {
            console.error("[WindowControls] close_or_exit failed, falling back:", e);
            try {
                await appWindow.destroy();
            } catch (destroyErr) {
                console.error("[WindowControls] destroy also failed:", destroyErr);
            }
        }
    };

    return (
        <div style={{ display: "flex", "align-items": "center", height: "100%", "flex-shrink": "0" }}>
            {/* Minimize */}
            <button
                onClick={minimize}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
                style={btnStyle()}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M1 5h8" stroke="var(--mz-text-secondary)" stroke-width="1.2" />
                </svg>
            </button>

            {/* Maximize / Restore */}
            <button
                onClick={toggleMaximize}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
                style={btnStyle()}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
                <Show when={isMaximized()} fallback={
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <rect x="1" y="1" width="8" height="8" rx="1" stroke="var(--mz-text-secondary)" stroke-width="1.2" fill="none" />
                    </svg>
                }>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <rect x="2.5" y="0.5" width="7" height="7" rx="1" stroke="var(--mz-text-secondary)" stroke-width="1" fill="none" />
                        <rect x="0.5" y="2.5" width="7" height="7" rx="1" stroke="var(--mz-text-secondary)" stroke-width="1" fill="var(--mz-bg-secondary)" />
                    </svg>
                </Show>
            </button>

            {/* Close */}
            <button
                onClick={close}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
                style={btnStyle()}
                onMouseEnter={e => {
                    e.currentTarget.style.background = "#e81123";
                    e.currentTarget.querySelectorAll("path, rect").forEach(p => p.setAttribute("stroke", "#fff"));
                }}
                onMouseLeave={e => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.querySelectorAll("path, rect").forEach(p => p.setAttribute("stroke", "var(--mz-text-secondary)"));
                }}
            >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M1 1l8 8M9 1l-8 8" stroke="var(--mz-text-secondary)" stroke-width="1.2" stroke-linecap="round" />
                </svg>
            </button>
        </div>
    );
};

function btnStyle(): Record<string, string> {
    return {
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        width: "46px",
        height: "var(--mz-tab-height)",
        border: "none",
        background: "transparent",
        cursor: "pointer",
        padding: "0",
        outline: "none",
    };
}
