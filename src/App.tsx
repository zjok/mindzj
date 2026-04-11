import { Component, Show, For, createSignal, createEffect, createMemo, on, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { vaultStore, type FileContent } from "./stores/vault";
import { editorStore, type ViewMode } from "./stores/editor";
import { settingsStore } from "./stores/settings";
import { workspaceStore, type WorkspaceState } from "./stores/workspace";
import { pluginStore, hasPluginViewForExtension, mountPluginView, destroyPluginView, isPluginSaving } from "./stores/plugins";
import {
    FileTree,
    SortBar,
    allFoldersCollapsed,
    resetFolderVisibilityState,
    setAllFoldersVisibility,
    type SortMode,
    type SortOrder,
} from "./components/sidebar/FileTree";
import { Outline } from "./components/sidebar/Outline";
import { SearchPanel } from "./components/sidebar/SearchPanel";
import { Calendar } from "./components/sidebar/Calendar";
import { TabBar } from "./components/tabs/TabBar";
import { Editor } from "./components/editor/Editor";
import { Toolbar } from "./components/editor/Toolbar";
import { ReadingView } from "./components/editor/ReadingView";
import { ConfirmDialog } from "./components/common/ConfirmDialog";
import { StatusBar } from "./components/common/StatusBar";
import { WelcomeScreen } from "./components/common/WelcomeScreen";
import { CommandPalette } from "./components/common/CommandPalette";
import { SettingsModal } from "./components/settings/SettingsModal";
import { WindowControls } from "./components/common/TitleBar";
import { createPersistableWindowState } from "./utils/windowState";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { ScreenshotOverlay } from "./components/screenshot/ScreenshotOverlay";
import { promptDialog } from "./components/common/ConfirmDialog";
import { t } from "./i18n";

type SidebarTab = "files" | "outline" | "search" | "calendar";
type SplitDirection = "left" | "right" | "up" | "down";
type PaneSlot = "primary" | "secondary";

function normalizeVaultPath(path: string | null | undefined): string {
    if (!path) return "";
    return path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
}

const App: Component = () => {
    const [showCommandPalette, setShowCommandPalette] = createSignal(false);
    const [showSettings, setShowSettings] = createSignal(false);
    const [sidebarTab, setSidebarTab] = createSignal<SidebarTab>("files");
    const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
    const [showVaultMenu, setShowVaultMenu] = createSignal(false);
    const [sortMode, setSortMode] = createSignal<SortMode>("custom");
    const [sortOrder, setSortOrder] = createSignal<SortOrder>("asc");
    const [sidebarWidth, setSidebarWidth] = createSignal(260);
    const [primaryPanePath, setPrimaryPanePath] = createSignal<string | null>(null);
    const [secondaryPanePath, setSecondaryPanePath] = createSignal<string | null>(null);
    const [activePaneSlot, setActivePaneSlot] = createSignal<PaneSlot>("primary");
    const [splitDirection, setSplitDirection] = createSignal<SplitDirection>("right");
    const startupParams = new URLSearchParams(window.location.search);
    const startupVaultPath = startupParams.get("vault_path");
    const startupVaultName = startupParams.get("vault_name");
    const startupFilePath = startupParams.get("file_path");
    const startupViewMode = startupParams.get("view_mode");
    const startupUiZoomParam = startupParams.get("ui_zoom");
    const startupUiZoom = startupUiZoomParam ? Number(startupUiZoomParam) : null;
    const [startupPayloadApplied, setStartupPayloadApplied] = createSignal(false);
    const isTransientWindow = () => startupParams.get("split") === "1";

    // When the app restarts with a previously-opened vault saved in
    // localStorage, onMount will asynchronously restore it. Between the
    // first SolidJS render and that restore completing, the render
    // logic would otherwise show <WelcomeScreen/> for ~100ms — a
    // visible "welcome page flash" the user complained about.
    //
    // The fix: detect at construction time whether we're about to
    // restore a vault (either from URL params or from localStorage)
    // and start in a `bootstrapping` state that renders a blank dark
    // canvas instead of either welcome or main UI. Once onMount
    // finishes the restore attempt — successfully or not — we drop
    // out of bootstrapping and the normal <Show when={vaultInfo()}>
    // render takes over. If there's nothing to restore, we skip
    // bootstrapping entirely and go straight to the welcome screen.
    const hasRestorableVault = (() => {
        if (startupParams.get("vault_path") && startupParams.get("vault_name")) return true;
        try {
            return !!localStorage.getItem("mindzj-last-vault");
        } catch {
            return false;
        }
    })();
    const [isBootstrapping, setIsBootstrapping] = createSignal(hasRestorableVault);
    const uiScale = createMemo(() => editorStore.uiZoom() / 100);
    const activePanePath = createMemo(() =>
        activePaneSlot() === "secondary"
            ? secondaryPanePath() ?? primaryPanePath()
            : primaryPanePath(),
    );
    const splitPaneActive = createMemo(() => secondaryPanePath() !== null);

    // Screenshot state
    const [screenshotData, setScreenshotData] = createSignal<string | null>(null);
    const [screenshotLoading, setScreenshotLoading] = createSignal(false);

    function isViewMode(value: string | null): value is ViewMode {
        return value === "source" || value === "live-preview" || value === "reading";
    }

    function resolveDefaultViewMode(value: string | null | undefined): ViewMode {
        switch (value) {
            case "Source":
            case "source":
                return "source";
            case "Reading":
            case "reading":
                return "reading";
            case "LivePreview":
            case "live-preview":
            default:
                return "live-preview";
        }
    }

    function buildDefaultSidebarTabs(): { id: SidebarTab; title: string; icon: string }[] {
        return [
            { id: "files", title: t("sidebar.files"), icon: "M3 3h7l2 2h5a1 1 0 011 1v9a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1z" },
            { id: "outline", title: t("sidebar.outline"), icon: "M4 6h16M4 10h10M4 14h13M4 18h7" },
            { id: "search", title: t("sidebar.search"), icon: "M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" },
            { id: "calendar", title: t("sidebar.calendar"), icon: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" },
        ];
    }

    function normalizeHotkeyKey(key: string): string {
        const normalized = key.length === 1 ? key.toUpperCase() : key;
        if (normalized === "+" || normalized === "ADD" || normalized === "Plus") return "=";
        if (normalized === "SUBTRACT" || normalized === "Minus") return "-";
        return normalized;
    }

    function buildWorkspaceSnapshot(): Partial<WorkspaceState> {
        return {
            open_files: vaultStore.openFiles().map((file) => file.path),
            active_file: vaultStore.activeFile()?.path ?? null,
            sidebar_tab: sidebarTab(),
            sidebar_collapsed: sidebarCollapsed(),
            sidebar_width: sidebarWidth(),
            sidebar_tab_order: sidebarTabs().map((tab) => tab.id),
            file_scroll_positions: editorStore.fileScrollPositions(),
            file_top_lines: editorStore.fileTopLines(),
            file_view_modes: editorStore.fileViewModes(),
            file_last_non_reading_view_modes:
                editorStore.fileLastNonReadingViewModes(),
        };
    }

    function getPanePath(slot: PaneSlot): string | null {
        return slot === "primary" ? primaryPanePath() : secondaryPanePath();
    }

    function setPanePath(slot: PaneSlot, path: string | null) {
        if (slot === "primary") {
            setPrimaryPanePath(path);
            return;
        }
        setSecondaryPanePath(path);
    }

    function findOpenFile(path: string | null | undefined): FileContent | null {
        if (!path) return null;
        return vaultStore.openFiles().find((file) => file.path === path) ?? null;
    }

    function activatePane(slot: PaneSlot) {
        setActivePaneSlot(slot);
        const path = getPanePath(slot);
        const file = findOpenFile(path);
        if (file) {
            vaultStore.setActiveFile(file);
        }
    }

    function closeSplitPane(slot: PaneSlot) {
        if (slot === "secondary") {
            setSecondaryPanePath(null);
            activatePane("primary");
            return;
        }

        const secondary = secondaryPanePath();
        if (secondary) {
            setPrimaryPanePath(secondary);
            setSecondaryPanePath(null);
            activatePane("primary");
        }
    }

    function handleTabSelect(path: string) {
        setPanePath(activePaneSlot(), path);
        vaultStore.switchToFile(path);
    }

    function handleTabClose(path: string) {
        const remainingPaths = vaultStore
            .openFiles()
            .filter((file) => file.path !== path)
            .map((file) => file.path);
        const primaryBefore = primaryPanePath();
        const secondaryBefore = secondaryPanePath();
        const activeBefore = activePaneSlot();

        vaultStore.closeFile(path);

        const pickReplacement = (exclude: string | null = null) =>
            remainingPaths.find((candidate) => candidate !== exclude) ??
            remainingPaths[remainingPaths.length - 1] ??
            null;

        let nextPrimary = primaryBefore === path ? pickReplacement(secondaryBefore === path ? null : secondaryBefore) : primaryBefore;
        let nextSecondary = secondaryBefore === path ? pickReplacement(nextPrimary) : secondaryBefore;

        if (nextSecondary === nextPrimary) {
            nextSecondary = remainingPaths.find((candidate) => candidate !== nextPrimary) ?? null;
        }

        if (!remainingPaths.length) {
            nextPrimary = null;
            nextSecondary = null;
        }

        setPrimaryPanePath(nextPrimary);
        setSecondaryPanePath(nextSecondary);

        const nextSlot = activeBefore === "secondary" && nextSecondary ? "secondary" : "primary";
        setActivePaneSlot(nextSlot);
        const nextActivePath = nextSlot === "secondary" ? nextSecondary : nextPrimary;
        const nextActiveFile = findOpenFile(nextActivePath);
        if (nextActiveFile) {
            vaultStore.setActiveFile(nextActiveFile);
        }
    }

    function handleOpenSplitInPane(path: string, direction: SplitDirection) {
        // Plugin-backed files (`.mindzj` etc.) now work in same-window
        // panes too: `mountPluginView` generates a unique mount handle
        // per call, so the same file path can be mounted in the
        // primary AND the secondary pane concurrently without either
        // clobbering the other's DOM. Previously this branch contained
        // a safety check that silently bailed out for plugin views and
        // either did nothing or opened a whole new Tauri window — now
        // we take the same fast path as .md files.
        setSplitDirection(direction);
        const currentActivePath = activePanePath() ?? vaultStore.activeFile()?.path ?? path;

        if (direction === "left" || direction === "up") {
            if (!splitPaneActive()) {
                setSecondaryPanePath(currentActivePath);
            }
            setPrimaryPanePath(path);
            activatePane("primary");
            return;
        }

        if (!primaryPanePath()) {
            setPrimaryPanePath(currentActivePath);
        }
        setSecondaryPanePath(path);
        activatePane("secondary");
    }

    createEffect(
        on(
            () => vaultStore.activeFile()?.path ?? null,
            (path) => {
                if (!path) return;
                if (getPanePath(activePaneSlot()) !== path) {
                    setPanePath(activePaneSlot(), path);
                }
                if (!primaryPanePath()) {
                    setPrimaryPanePath(path);
                }
            },
        ),
    );

    createEffect(() => {
        const openPaths = new Set(vaultStore.openFiles().map((file) => file.path));
        const primary = primaryPanePath();
        const secondary = secondaryPanePath();

        if (primary && !openPaths.has(primary)) {
            setPrimaryPanePath(vaultStore.activeFile()?.path ?? null);
        } else if (!primary && vaultStore.activeFile()) {
            setPrimaryPanePath(vaultStore.activeFile()!.path);
        }

        if (secondary && !openPaths.has(secondary)) {
            setSecondaryPanePath(null);
        }
    });

    async function flushWorkspaceNow() {
        if (!vaultStore.vaultInfo() || isTransientWindow()) return;
        document.dispatchEvent(new CustomEvent("mindzj:remember-active-viewport"));
        await workspaceStore.saveWorkspace(buildWorkspaceSnapshot());
    }

    async function closeCurrentVault() {
        await flushWorkspaceNow();
        vaultStore.closeVault();
        editorStore.resetWorkspaceState();
        resetFolderVisibilityState();
    }

    /** Trigger screenshot capture (called by Alt+F) */
    async function startScreenshot() {
        if (screenshotLoading() || screenshotData()) return;
        setScreenshotLoading(true);
        try {
            const base64 = await invoke<string>("capture_screen");
            setScreenshotData(base64);
        } catch (err) {
            console.error("[Screenshot] capture_screen failed:", err);
        } finally {
            setScreenshotLoading(false);
        }
    }

    /** Save annotated screenshot to vault and insert markdown link */
    async function handleScreenshotSave(base64Png: string) {
        try {
            const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
            const filename = `screenshot_${timestamp}.png`;
            const s = settingsStore.settings();
            const folder = s.attachment_folder || ".mindzj/images";
            const relativePath = `${folder}/${filename}`;

            // Save to vault
            await invoke("write_binary_file", {
                relativePath,
                base64Data: base64Png,
            });

            // Insert markdown image reference at cursor in the active file
            const activeFile = vaultStore.activeFile();
            if (activeFile) {
                const imgMarkdown = `![${filename}](${relativePath})`;
                document.dispatchEvent(
                    new CustomEvent("mindzj:insert-text", { detail: { text: imgMarkdown } }),
                );
            }
        } catch (err) {
            console.error("[Screenshot] save failed:", err);
        } finally {
            setScreenshotData(null);
        }
    }

    onMount(async () => {
        (window as any).__mindzj_flush_workspace = flushWorkspaceNow;
        document.body.style.removeProperty("zoom");
        document.documentElement.style.removeProperty("font-size");

        if (startupUiZoom !== null && Number.isFinite(startupUiZoom)) {
            editorStore.setUiZoom(startupUiZoom);
        }
        // Use capture phase so global shortcuts (Ctrl+E, etc.) fire BEFORE
        // CodeMirror's own keydown handlers consume the event.
        document.addEventListener("keydown", handleGlobalKeydown, true);

        // Disable the native browser/webview context menu globally so that
        // items like Refresh, Save as, Print, Insert never appear.
        // Individual components (e.g. editor images, plugin views) install
        // their own contextmenu handlers that call stopPropagation, so
        // those custom menus still work.
        const suppressNativeContextMenu = (e: MouseEvent) => {
            e.preventDefault();
        };
        document.addEventListener("contextmenu", suppressNativeContextMenu, false);
        onCleanup(() => document.removeEventListener("contextmenu", suppressNativeContextMenu, false));

        // ── Register global screenshot shortcut (works even when app is in background) ──
        try {
            const screenshotCombo = getHotkey("screenshot", "Alt+G");
            await register(screenshotCombo, (e) => {
                if (e.state === "Pressed") startScreenshot();
            });
            onCleanup(() => { unregister(screenshotCombo).catch(() => {}); });
        } catch (err) {
            console.warn("[GlobalShortcut] Failed to register screenshot shortcut:", err);
        }

        // ── Listen for plugin settings open requests ──
        const handleOpenSettings = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            setShowSettings(true);
            if (detail?.pluginId) {
                // Dispatch a follow-up event that the SettingsModal can use
                // to navigate to the specific plugin settings tab.
                setTimeout(() => {
                    document.dispatchEvent(new CustomEvent("mindzj:settings-navigate", {
                        detail: { pluginId: detail.pluginId },
                    }));
                }, 100);
            }
        };
        document.addEventListener("mindzj:open-settings", handleOpenSettings);
        onCleanup(() => document.removeEventListener("mindzj:open-settings", handleOpenSettings));

        // ── Reveal-in-tree: triggered from tab context menu ──
        const handleRevealInTree = () => {
            setSidebarTab("files");
            setSidebarCollapsed(false);
        };
        document.addEventListener("mindzj:reveal-in-tree", handleRevealInTree);
        onCleanup(() => document.removeEventListener("mindzj:reveal-in-tree", handleRevealInTree));

        const handleAppCommand = (e: Event) => {
            const command = (e as CustomEvent).detail?.command;
            if (command === "toggle-left-sidebar" || command === "toggle-right-sidebar") {
                setSidebarCollapsed(v => !v);
            }
        };
        document.addEventListener("mindzj:app-command", handleAppCommand);
        onCleanup(() => document.removeEventListener("mindzj:app-command", handleAppCommand));
        onCleanup(() => {
            if ((window as any).__mindzj_flush_workspace === flushWorkspaceNow) {
                delete (window as any).__mindzj_flush_workspace;
            }
        });

        // ── Window state: Rust applies the saved geometry BEFORE the window
        //    is shown (see settings_api::apply_window_state in setup hook),
        //    so the frontend only needs to PERSIST subsequent changes. ──
        const _aw = getCurrentWindow();

        // ── Window state: save on move/resize (debounced) ──
        async function captureAndSaveWindowState() {
            if (isTransientWindow()) return;
            try {
                const maximized = await _aw.isMaximized();
                const minimized = await _aw.isMinimized();
                // Don't save position/size when maximized — restore the pre-maximized geometry
                if (maximized) {
                    await invoke("save_window_state", { windowState: { maximized: true } });
                    return;
                }
                if (minimized) {
                    return;
                }
                const pos = await _aw.outerPosition();
                const size = await _aw.outerSize();
                const sf = await _aw.scaleFactor();
                const windowState = createPersistableWindowState({
                    x: pos.x / sf,
                    y: pos.y / sf,
                    width: size.width / sf,
                    height: size.height / sf,
                });
                if (!windowState) {
                    return;
                }
                await invoke("save_window_state", { windowState });
            } catch (e) {
                console.warn("[Window] Failed to save window state:", e);
            }
        }
        let _winSaveTimer: ReturnType<typeof setTimeout> | null = null;
        const debouncedSaveWindowState = () => {
            if (_winSaveTimer) clearTimeout(_winSaveTimer);
            _winSaveTimer = setTimeout(captureAndSaveWindowState, 500);
        };
        const unlistenResize = await _aw.onResized(debouncedSaveWindowState);
        const unlistenMove = await _aw.onMoved(debouncedSaveWindowState);
        // NOTE: we deliberately do NOT register an `onCloseRequested`
        // handler. Registering one — even a fire-and-forget one — was
        // making the close button unresponsive on Windows. The WindowControls
        // titlebar button now performs a synchronous final save and then
        // calls `appWindow.destroy()` itself, which bypasses the close-
        // request event entirely. The debounced move/resize saves above
        // already keep the window geometry up-to-date, so we never lose
        // more than 500ms of movement on the hard-close path.
        onCleanup(() => { unlistenResize(); unlistenMove(); });

        // Listen for file system watcher events from Rust backend
        listen<{ kind: string; path?: string; from?: string; to?: string }>("file-changed", async (event) => {
            const e = event.payload;
            if (e.kind === "Modified" && e.path) {
                // Skip reload if a plugin is currently saving this file.
                // Re-loading would reset in-memory plugin state (e.g., node selection
                // after pressing Tab to add a child node in the mindmap plugin).
                if (!isPluginSaving(e.path)) {
                    // Use reloadFile so that a background save on tab A
                    // (or an external editor change) never yanks the user
                    // off whatever tab they currently have focused.
                    const openFile = vaultStore.openFiles().find(f => f.path === e.path);
                    if (openFile) {
                        await vaultStore.reloadFile(e.path!);
                    }
                }
            }
            // Refresh file tree for any change
            await vaultStore.refreshFileTree();
        });

        // Auto-open vault from URL params (for new-window vault opening)
        if (startupVaultPath && startupVaultName) {
            try {
                await vaultStore.openVault(startupVaultPath, startupVaultName);
            } catch (e) {
                console.error("Failed to auto-open vault from URL params:", e);
            }
        } else {
            // No URL params — try to restore last opened vault
            try {
                const last = localStorage.getItem("mindzj-last-vault");
                const savedVaults = localStorage.getItem("mindzj-vault-list");
                if (last) {
                    const { name, path } = JSON.parse(last);
                    const parsedVaults = savedVaults ? JSON.parse(savedVaults) : [];
                    const stillListed = Array.isArray(parsedVaults)
                        && parsedVaults.some((vault: { path?: string }) =>
                            normalizeVaultPath(vault.path) === normalizeVaultPath(path),
                        );
                    if (name && path && stillListed) {
                        await vaultStore.openVault(path, name);
                    } else if (!stillListed) {
                        localStorage.removeItem("mindzj-last-vault");
                    }
                }
            } catch {
                // Ignore — show welcome screen
            }
        }
        // Restore attempt finished (success or failure). Drop out of
        // the bootstrapping blank-canvas state so the render logic can
        // now show either the main vault UI or the welcome screen
        // based on whether vaultInfo() ended up truthy.
        setIsBootstrapping(false);
    });

    createEffect(() => {
        const screenshotCombo = getHotkey("screenshot", "Alt+G");
        let released = false;

        const syncShortcut = async () => {
            try {
                await unregister(screenshotCombo).catch(() => {});
                if (released) return;
                await register(screenshotCombo, (event) => {
                    if (event.state === "Pressed") startScreenshot();
                });
            } catch (err) {
                console.warn("[GlobalShortcut] Failed to sync screenshot shortcut:", err);
            }
        };

        void syncShortcut();

        onCleanup(() => {
            released = true;
            unregister(screenshotCombo).catch(() => {});
        });
    });

    // Update window title when vault changes
    createEffect(() => {
        const info = vaultStore.vaultInfo();
        if (info) {
            document.title = `MindZJ — ${info.name}`;
            // Record last opened vault
            localStorage.setItem("mindzj-last-vault", JSON.stringify({ name: info.name, path: info.path }));
        } else {
            document.title = "MindZJ";
        }
    });

    // Restore workspace and load plugins when vault opens
    createEffect(on(() => vaultStore.vaultInfo()?.path ?? null, async () => {
        const info = vaultStore.vaultInfo();
        resetFolderVisibilityState();
        editorStore.resetWorkspaceState();
        if (info) {
            const loadedSettings = await settingsStore.loadSettings();
            // If the user picked a language on the welcome screen before
            // this vault existed, apply it now so the new vault's
            // settings.json persists the right locale. This is a
            // one-shot override — we delete the key after consuming it
            // so later vault switches use the vault's own locale.
            try {
                const pendingLocale = localStorage.getItem("mindzj-pending-locale");
                if (pendingLocale && pendingLocale !== loadedSettings.locale) {
                    await settingsStore.updateSetting("locale", pendingLocale);
                }
                if (pendingLocale) {
                    localStorage.removeItem("mindzj-pending-locale");
                }
            } catch (e) {
                console.warn("[vault-open] pending locale apply failed:", e);
            }
            editorStore.setDefaultViewMode(
                isViewMode(startupViewMode)
                    ? startupViewMode
                    : resolveDefaultViewMode(loadedSettings.default_view_mode),
            );
            if (!isTransientWindow()) {
                const ws = await workspaceStore.loadWorkspace();
                editorStore.restoreWorkspaceState(ws);
                // Restore sidebar state
                if (ws.sidebar_tab) setSidebarTab(ws.sidebar_tab as SidebarTab);
                setSidebarCollapsed(!!ws.sidebar_collapsed);
                if (ws.sidebar_width) setSidebarWidth(ws.sidebar_width);
                const defaultTabs = buildDefaultSidebarTabs();
                if (ws.sidebar_tab_order?.length) {
                    const reordered = ws.sidebar_tab_order
                        .map((id) => defaultTabs.find((tab) => tab.id === id))
                        .filter(Boolean) as typeof defaultTabs;
                    for (const tab of defaultTabs) {
                        if (!reordered.find((item) => item.id === tab.id)) {
                            reordered.push(tab);
                        }
                    }
                    setSidebarTabs(reordered);
                } else {
                    setSidebarTabs(defaultTabs);
                }
                // Window geometry is restored from global database on app start
                // (not per-vault) — see onMount above. No override here.
                // Restore open files
                const filesToOpen = [...ws.open_files];
                if (ws.active_file && !filesToOpen.includes(ws.active_file)) {
                    filesToOpen.push(ws.active_file);
                }
                for (const filePath of filesToOpen) {
                    try { await vaultStore.openFile(filePath); } catch { /* skip missing files */ }
                }
                if (ws.active_file) {
                    try { vaultStore.switchToFile(ws.active_file); } catch { /* skip */ }
                }
            }
            // Load enabled plugins
            await pluginStore.loadAllPlugins();
            if (!startupPayloadApplied() && (startupFilePath || isViewMode(startupViewMode))) {
                if (startupFilePath) {
                    try {
                        await vaultStore.openFile(startupFilePath);
                    } catch (e) {
                        console.warn("Failed to open startup file from URL params:", e);
                    }
                }
                if (isViewMode(startupViewMode)) {
                    editorStore.setViewMode(startupViewMode);
                }
                setStartupPayloadApplied(true);
            }
        } else {
            // Vault closed — unload all plugins
            settingsStore.resetSettings();
            editorStore.resetWorkspaceState();
            await pluginStore.unloadAllPlugins();
        }
    }));

    // Save workspace on changes (debounced)
    createEffect(() => {
        const info = vaultStore.vaultInfo();
        if (!info || isTransientWindow()) return;
        workspaceStore.scheduleSave(buildWorkspaceSnapshot());
    });

    /**
     * Match a KeyboardEvent against a hotkey combo string like "Alt+G", "Ctrl+Shift+S".
     * Returns true if the event matches the combo.
     */
    function matchesHotkey(e: KeyboardEvent, combo: string): boolean {
        const parts = combo.split("+");
        const keyPart = parts[parts.length - 1];
        const needCtrl = parts.includes("Ctrl");
        const needShift = parts.includes("Shift");
        const needAlt = parts.includes("Alt");
        const needMeta = parts.includes("Meta");

        if (needCtrl !== (e.ctrlKey || e.metaKey)) return false;
        if (needShift !== e.shiftKey) return false;
        if (needAlt !== e.altKey) return false;
        if (needMeta && !e.metaKey) return false;

        const eventKey = normalizeHotkeyKey(e.key);
        const comboKey = normalizeHotkeyKey(keyPart);
        return eventKey === comboKey;
    }

    /** Get the effective hotkey combo for a command (override or default) */
    function getHotkey(command: string, defaultKeys: string): string {
        const overrides = settingsStore.settings().hotkey_overrides || {};
        return overrides[command] || defaultKeys;
    }

    function toggleViewModeWithSave(path: string | null | undefined) {
        const resolvedPath = path ?? null;
        const currentMode = editorStore.getViewModeForFile(resolvedPath);
        if (currentMode === "reading") {
            editorStore.toggleReadingMode(resolvedPath ?? undefined);
            return;
        }

        const event = new CustomEvent("mindzj:toggle-view-mode-with-save", {
            cancelable: true,
            detail: { path: resolvedPath },
        });
        const handled = !document.dispatchEvent(event);
        if (!handled) {
            editorStore.toggleReadingMode(resolvedPath ?? undefined);
        }
    }

    function handleGlobalKeydown(e: KeyboardEvent) {
        // Prevent the bare Alt key from activating the system menu bar,
        // which steals focus from the editor. We only suppress the Alt
        // key itself (no combo) — Alt+<key> combos are handled below.
        if (e.key === "Alt") {
            e.preventDefault();
            return;
        }

        // If the settings hotkey capture is active, let the HotkeysPanel handle the event
        if ((window as any).__mindzj_hotkey_capturing) return;

        // Check if the editor (CodeMirror) is focused
        const editorFocused = !!(document.activeElement?.closest(".cm-editor"));

        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "r") {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Screenshot (default Alt+G, configurable)
        if (matchesHotkey(e, getHotkey("screenshot", "Alt+G"))) {
            e.preventDefault();
            e.stopPropagation();
            startScreenshot();
            return;
        }

        // Plugin: timestamp-header commands (configurable hotkeys)
        if (matchesHotkey(e, getHotkey("plugin:timestamp-header:insert-timestamp", "Alt+F"))) {
            e.preventDefault();
            e.stopPropagation();
            document.dispatchEvent(new CustomEvent("mindzj:plugin-command", {
                detail: { command: "insert-custom-timestamp" },
            }));
            return;
        }
        if (matchesHotkey(e, getHotkey("plugin:timestamp-header:insert-separator", "Alt+A"))) {
            e.preventDefault();
            e.stopPropagation();
            document.dispatchEvent(new CustomEvent("mindzj:plugin-command", {
                detail: { command: "insert-triple-asterisk" },
            }));
            return;
        }

        if (matchesHotkey(e, getHotkey("command-palette", "Ctrl+P"))) {
            e.preventDefault();
            e.stopPropagation();
            setShowCommandPalette(v => !v);
            return;
        }
        if (matchesHotkey(e, getHotkey("save", "Ctrl+S"))) {
            e.preventDefault();
            e.stopPropagation();
            document.dispatchEvent(new CustomEvent("mindzj:force-save"));
            return;
        }
        if (matchesHotkey(e, getHotkey("task-list", "Ctrl+L"))) {
            e.preventDefault();
            e.stopPropagation();
            document.dispatchEvent(new CustomEvent("mindzj:editor-command", {
                detail: { command: "task-list" },
            }));
            return;
        }
        if (matchesHotkey(e, getHotkey("toggle-view-mode", "Ctrl+E"))) {
            e.preventDefault();
            e.stopPropagation();
            toggleViewModeWithSave(activePanePath() ?? undefined);
            return;
        }
        if (matchesHotkey(e, getHotkey("toggle-sidebar", "Ctrl+`"))) {
            e.preventDefault();
            e.stopPropagation();
            setSidebarCollapsed(v => !v);
            return;
        }
        if (matchesHotkey(e, getHotkey("settings", "Ctrl+,"))) {
            e.preventDefault();
            e.stopPropagation();
            setShowSettings(v => !v);
            return;
        }
        if (matchesHotkey(e, getHotkey("zoom-in", "Ctrl+="))) {
            e.preventDefault();
            e.stopPropagation();
            editorStore.zoomUI(10);
            return;
        }
        if (matchesHotkey(e, getHotkey("zoom-out", "Ctrl+-"))) {
            e.preventDefault();
            e.stopPropagation();
            editorStore.zoomUI(-10);
            return;
        }
        // Ctrl+0: only zoom reset when editor is NOT focused (Ctrl+0 = normal text in editor)
        if (matchesHotkey(e, getHotkey("zoom-reset", "Ctrl+0")) && !editorFocused) {
            e.preventDefault();
            e.stopPropagation();
            editorStore.zoomUI(100 - editorStore.uiZoom());
            return;
        }
        // Ctrl+1~6: don't intercept when editor is focused (heading shortcuts)

        // F2: rename the currently active file (global — works from any focus)
        if (e.key === "F2" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            const active = vaultStore.activeFile();
            if (active) {
                e.preventDefault();
                e.stopPropagation();
                document.dispatchEvent(new CustomEvent("mindzj:rename-active-file"));
            }
            return;
        }

        // Ctrl+Shift+F: switch to sidebar search panel
        if (e.ctrlKey && e.shiftKey && e.key === "F") {
            e.preventDefault();
            e.stopPropagation();
            setSidebarTab("search");
            if (sidebarCollapsed()) setSidebarCollapsed(false);
            // Focus the search input after a short delay for DOM update
            setTimeout(() => {
                const searchInput = document.querySelector('.mz-sidebar-search-input') as HTMLInputElement;
                if (searchInput) searchInput.focus();
            }, 100);
            return;
        }

        // Alt+3: always switch to sidebar search (regardless of tab order)
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "3") {
            e.preventDefault();
            e.stopPropagation();
            setSidebarTab("search");
            if (sidebarCollapsed()) setSidebarCollapsed(false);
            setTimeout(() => {
                const searchInput = document.querySelector('.mz-sidebar-search-input') as HTMLInputElement;
                if (searchInput) searchInput.focus();
            }, 100);
            return;
        }

        // Alt+1..4: activate the corresponding sidebar icon tab (respects the
        // user's current drag-sorted order). Also expands the sidebar if
        // collapsed so the switch has a visible effect.
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
            const n = parseInt(e.key, 10);
            if (n >= 1 && n <= 4) {
                const tabs = sidebarTabs();
                const target = tabs[n - 1];
                if (target) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSidebarTab(target.id);
                    if (sidebarCollapsed()) setSidebarCollapsed(false);
                }
            }
        }
    }

    // Sidebar icon tabs config (signal so they can be reordered via drag)
    const [sidebarTabs, setSidebarTabs] = createSignal(buildDefaultSidebarTabs());
    function reorderSidebarTab(fromIdx: number, toIdx: number) {
        const tabs = [...sidebarTabs()];
        const [moved] = tabs.splice(fromIdx, 1);
        tabs.splice(toIdx, 0, moved);
        setSidebarTabs(tabs);
    }

    async function handleNewTab() {
        const n = await promptDialog(t("app.noteNamePrompt"), t("app.newNoteDefault"));
        if (!n) return;
        const fileName = n.endsWith(".md") ? n : `${n}.md`;
        await vaultStore.createFile(fileName, "");
        await vaultStore.openFile(fileName);
    }

    function toggleAllFolders() {
        setAllFoldersVisibility(allFoldersCollapsed() ? "expand" : "collapse");
    }

    return (
        <div style={{
            display: "flex",
            "flex-direction": "column",
            position: "fixed",
            inset: "0",
            width: `${100 / uiScale()}%`,
            height: `${100 / uiScale()}%`,
            transform: `scale(${uiScale()})`,
            "transform-origin": "top left",
            overflow: "hidden",
        }}>
            <div style={{ display: "flex", flex: "1", overflow: "hidden" }}>
                {/* ===== SIDEBAR ===== */}
                <Show when={vaultStore.vaultInfo()}>
                    <aside style={{
                        width: sidebarCollapsed() ? "0px" : `${sidebarWidth()}px`,
                        "min-width": sidebarCollapsed() ? "0px" : "160px",
                        "max-width": sidebarCollapsed() ? "0px" : "600px",
                        background: "var(--mz-bg-secondary)",
                        "border-right": sidebarCollapsed() ? "none" : "1px solid var(--mz-border)",
                        display: "flex", "flex-direction": "column", overflow: "hidden",
                        transition: sidebarCollapsed() ? "width 200ms ease, min-width 200ms ease" : "none",
                        "flex-shrink": "0",
                        position: "relative",
                    }}>
                        {/* Top icon bar (also drag region) */}
                        <div data-tauri-drag-region style={{
                            display: "flex", "align-items": "center",
                            "justify-content": "space-between",
                            padding: "6px 4px",
                            "border-bottom": "1px solid var(--mz-border)",
                            "min-height": "36px",
                        }}>
                            {/* Left: tab icons (draggable to reorder) */}
                            <div style={{ display: "flex", gap: "2px" }}>
                                <For each={sidebarTabs()}>
                                    {(tab, idx) => (
                                    <button
                                        draggable={true}
                                        onDragStart={(e) => { e.dataTransfer!.setData("text/sidebar-idx", String(idx())); e.dataTransfer!.effectAllowed = "move"; }}
                                        onDragOver={(e) => { e.preventDefault(); e.dataTransfer!.dropEffect = "move"; }}
                                        onDragLeave={(e) => { e.currentTarget.style.outline = ""; e.currentTarget.style.outlineOffset = ""; }}
                                        onDrop={(e) => { e.preventDefault(); e.currentTarget.style.outline = ""; e.currentTarget.style.outlineOffset = ""; const from = parseInt(e.dataTransfer!.getData("text/sidebar-idx")); if (!isNaN(from) && from !== idx()) reorderSidebarTab(from, idx()); }}
                                        onClick={() => setSidebarTab(tab.id)}
                                        title={t(`sidebar.${tab.id}`)}
                                        style={{
                                            width: "30px", height: "30px",
                                            display: "flex", "align-items": "center", "justify-content": "center",
                                            border: "none", "border-radius": "var(--mz-radius-sm)",
                                            background: sidebarTab() === tab.id ? "var(--mz-bg-active)" : "transparent",
                                            color: sidebarTab() === tab.id ? "var(--mz-accent)" : "var(--mz-text-muted)",
                                            cursor: "pointer", transition: "all 100ms",
                                        }}
                                        onMouseEnter={e => { if (sidebarTab() !== tab.id) e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
                                        onMouseLeave={e => { if (sidebarTab() !== tab.id) e.currentTarget.style.background = "transparent"; }}
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <path d={tab.icon} />
                                        </svg>
                                    </button>
                                    )}
                                </For>
                            </div>

                            {/* Right: collapse button */}
                            <button
                                onClick={() => setSidebarCollapsed(true)}
                                title={t("app.collapseSidebar")}
                                style={{
                                    width: "30px", height: "30px",
                                    display: "flex", "align-items": "center", "justify-content": "center",
                                    border: "none", "border-radius": "var(--mz-radius-sm)",
                                    background: "transparent", color: "var(--mz-text-muted)",
                                    cursor: "pointer",
                                }}
                                onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
                                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M11 19l-7-7 7-7M18 19l-7-7 7-7" />
                                </svg>
                            </button>
                        </div>

                        {/* File action bar (only for files tab) */}
                        <Show when={sidebarTab() === "files"}>
                            <div style={{
                                display: "flex", "align-items": "center", "justify-content": "space-between",
                                gap: "2px", padding: "4px",
                                "border-bottom": "1px solid var(--mz-border)",
                            }}>
                                <div style={{ display: "flex", gap: "2px" }}>
                                    {[
                                        { title: t("app.newNote"), icon: "M12 5v14M5 12h14", action: () => handleNewTab() },
                                        { title: t("app.newFolder"), icon: "M12 10v6M9 13h6M3 7.5A2.5 2.5 0 015.5 5H10l2 2h6.5A2.5 2.5 0 0121 9.5v7a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 16.5z", action: async () => {
                                            const name = await promptDialog(t("app.folderNamePrompt"));
                                            if (name) await vaultStore.createDir(name);
                                        }},
                                        {
                                            title: allFoldersCollapsed()
                                                ? t("app.expandAllFolders")
                                                : t("app.collapseAllFolders"),
                                            icon: "M7 9l5-5 5 5M7 15l5 5 5-5",
                                            action: () => toggleAllFolders(),
                                        },
                                    ].map(btn => (
                                        <button
                                            onClick={btn.action}
                                            title={btn.title}
                                            style={{
                                                width: "28px", height: "28px",
                                                display: "flex", "align-items": "center", "justify-content": "center",
                                                border: "none", "border-radius": "var(--mz-radius-sm)",
                                                background: "transparent", color: "var(--mz-text-muted)",
                                                cursor: "pointer",
                                            }}
                                            onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; e.currentTarget.style.color = "var(--mz-text-primary)"; }}
                                            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--mz-text-muted)"; }}
                                        >
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                <path d={btn.icon} />
                                            </svg>
                                        </button>
                                    ))}
                                </div>
                                <SortBar
                                    mode={sortMode()}
                                    order={sortOrder()}
                                    onModeChange={setSortMode}
                                    onOrderChange={setSortOrder}
                                />
                            </div>
                        </Show>

                        {/* Sidebar content — each panel fills the available space */}
                        <div style={{ flex: "1", overflow: "hidden", "min-height": "0", display: "flex", "flex-direction": "column" }}>
                            <Show when={sidebarTab() === "files"}>
                                <div style={{ flex: "1", "min-height": "0", overflow: "auto" }}>
                                    <FileTree
                                        entries={vaultStore.fileTree()}
                                        onFileClick={(p: string) => vaultStore.openFile(p)}
                                        activePath={vaultStore.activeFile()?.path ?? null}
                                        sortMode={sortMode()}
                                        sortOrder={sortOrder()}
                                    />
                                </div>
                            </Show>
                            <Show when={sidebarTab() === "outline"}><Outline /></Show>
                            <Show when={sidebarTab() === "search"}>
                                <div style={{ flex: "1", "min-height": "0", overflow: "auto" }}>
                                    <SearchPanel />
                                </div>
                            </Show>
                            <Show when={sidebarTab() === "calendar"}><Calendar /></Show>
                        </div>

                        {/* Bottom: vault name + settings */}
                        <div style={{
                            display: "flex", "align-items": "center",
                            "justify-content": "space-between",
                            padding: "8px 12px",
                            "border-top": "1px solid var(--mz-border)",
                            position: "relative",
                        }}>
                            <button
                                onClick={() => setShowVaultMenu(v => !v)}
                                style={{
                                    border: "none", background: "transparent",
                                    color: "var(--mz-text-primary)",
                                    "font-size": "var(--mz-font-size-sm)", "font-weight": "500",
                                    "font-family": "var(--mz-font-sans)",
                                    cursor: "pointer", padding: "4px 0",
                                    display: "flex", "align-items": "center", gap: "4px",
                                }}
                            >
                                {vaultStore.vaultInfo()?.name ?? "Vault"}
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4L5 7L8 4" /></svg>
                            </button>

                            {/* Settings button */}
                            <button
                                onClick={() => setShowSettings(true)}
                                title={t("app.settings")}
                                style={{
                                    width: "28px", height: "28px",
                                    display: "flex", "align-items": "center", "justify-content": "center",
                                    border: "none", "border-radius": "var(--mz-radius-sm)",
                                    background: "transparent", color: "var(--mz-text-muted)", cursor: "pointer",
                                }}
                                onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
                                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="3" />
                                    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                                </svg>
                            </button>

                            {/* Vault switcher popup */}
                            <Show when={showVaultMenu()}>
                                <VaultSwitcher
                                    onClose={() => setShowVaultMenu(false)}
                                    onCloseVault={closeCurrentVault}
                                />
                            </Show>
                        </div>
                    </aside>
                    {/* Sidebar resize handle */}
                    <Show when={!sidebarCollapsed()}>
                        <div
                            style={{
                                width: "4px",
                                cursor: "col-resize",
                                background: "transparent",
                                "flex-shrink": "0",
                                "z-index": "10",
                                "margin-left": "-2px",
                                "margin-right": "-2px",
                                transition: "background 150ms ease",
                            }}
                            onMouseEnter={() => {}}
                            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                            onMouseDown={(e: MouseEvent) => {
                                e.preventDefault();
                                const startX = e.clientX;
                                const startW = sidebarWidth();
                                const onMove = (me: MouseEvent) => {
                                    const newW = Math.max(160, Math.min(600, startW + me.clientX - startX));
                                    setSidebarWidth(newW);
                                };
                                const onUp = () => {
                                    document.removeEventListener("mousemove", onMove);
                                    document.removeEventListener("mouseup", onUp);
                                };
                                document.addEventListener("mousemove", onMove);
                                document.addEventListener("mouseup", onUp);
                            }}
                        />
                    </Show>
                </Show>

                {/* ===== MAIN AREA ===== */}
                <main style={{ flex: "1", "min-width": "0", "min-height": "0", display: "flex", "flex-direction": "column", overflow: "hidden", background: "var(--mz-bg-primary)" }}>
                    <Show when={vaultStore.vaultInfo()} fallback={
                        <Show
                            when={!isBootstrapping()}
                            fallback={
                                // Blank dark canvas while we're still trying to
                                // restore a saved vault. Prevents the welcome
                                // screen from flashing for ~100ms before the
                                // restored vault replaces it.
                                <div style={{ flex: "1", background: "var(--mz-bg-primary)" }} />
                            }
                        >
                            {/* Drag region + window controls for welcome screen */}
                            <div data-tauri-drag-region style={{
                                display: "flex", "align-items": "center", "justify-content": "flex-end",
                                height: "var(--mz-tab-height)", background: "var(--mz-bg-secondary)",
                                "border-bottom": "1px solid var(--mz-border)",
                                "-webkit-app-region": "drag",
                            }}>
                                <div style={{ "-webkit-app-region": "no-drag" }}>
                                    <WindowControls />
                                </div>
                            </div>
                            <WelcomeScreen />
                        </Show>
                    }>
                        {/* Tab bar (also acts as drag region for frameless window).
                            Use -webkit-app-region: drag on the bar itself so clicking ANY
                            empty space allows window dragging. Interactive children use no-drag. */}
                        <div
                            data-tauri-drag-region
                            style={{
                                display: "flex", "align-items": "center",
                                background: "var(--mz-bg-secondary)",
                                "border-bottom": "1px solid var(--mz-border)",
                                "-webkit-app-region": "drag",
                            }}
                        >
                            {/* Expand sidebar button (when collapsed) */}
                            <Show when={sidebarCollapsed()}>
                                <button
                                    onClick={() => setSidebarCollapsed(false)}
                                    title={t("app.expandSidebar")}
                                    style={{
                                        width: "36px", height: "var(--mz-tab-height)",
                                        display: "flex", "align-items": "center", "justify-content": "center",
                                        border: "none", "border-right": "1px solid var(--mz-border)",
                                        background: "transparent", color: "var(--mz-text-muted)", cursor: "pointer",
                                        "-webkit-app-region": "no-drag",
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.color = "var(--mz-text-primary)"; }}
                                    onMouseLeave={e => { e.currentTarget.style.color = "var(--mz-text-muted)"; }}
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M13 5l7 7-7 7M6 5l7 7-7 7" />
                                    </svg>
                                </button>
                            </Show>

                            {/* Tab area: takes remaining space but CAN shrink so window controls stay visible */}
                            <div style={{ flex: "1 1 0px", "min-width": "0", overflow: "hidden", "-webkit-app-region": "no-drag" }}>
                                <TabBar
                                    files={vaultStore.openFiles()}
                                    activeFile={vaultStore.activeFile()}
                                    onSelect={handleTabSelect}
                                    onClose={handleTabClose}
                                    onSetViewMode={(path, mode) => editorStore.setViewMode(mode, path)}
                                    onOpenSplit={handleOpenSplitInPane}
                                    onReorder={(from: number, to: number) => vaultStore.reorderOpenFiles(from, to)}
                                />
                            </div>

                            {/* New tab + (never shrinks) */}
                            <button
                                onClick={handleNewTab}
                                title={t("app.newTab")}
                                style={{
                                    "flex-shrink": "0",
                                    width: "32px", height: "var(--mz-tab-height)",
                                    display: "flex", "align-items": "center", "justify-content": "center",
                                    border: "none", "border-left": "1px solid var(--mz-border)",
                                    background: "transparent", color: "var(--mz-text-muted)", cursor: "pointer",
                                    "font-size": "16px",
                                    "-webkit-app-region": "no-drag",
                                }}
                                onMouseEnter={e => { e.currentTarget.style.color = "var(--mz-text-primary)"; }}
                                onMouseLeave={e => { e.currentTarget.style.color = "var(--mz-text-muted)"; }}
                            >
                                +
                            </button>

                            {/* Drag spacer (never shrinks) */}
                            <div
                                data-tauri-drag-region
                                style={{
                                    "flex-shrink": "0",
                                    width: "40px",
                                    height: "var(--mz-tab-height)",
                                    "border-left": "1px solid var(--mz-border)",
                                    "-webkit-app-region": "drag",
                                }}
                            />

                            {/* Window controls: minimize, maximize, close (never shrinks, always visible) */}
                            <div style={{ "flex-shrink": "0", "-webkit-app-region": "no-drag" }}>
                                <WindowControls />
                            </div>
                        </div>

                        {/* Editor area — uses createMemo to derive stable values so
                            PluginViewHost is NOT destroyed/recreated on every save. */}
                        <Show when={vaultStore.activeFile()} fallback={
                            <div style={{ flex: "1", display: "flex", "align-items": "center", "justify-content": "center", color: "var(--mz-text-muted)", "font-size": "var(--mz-font-size-sm)" }}>
                                {t("app.openFileOrSearch")}
                            </div>
                        }>
                            <Show
                                when={
                                    settingsStore.settings().show_markdown_toolbar &&
                                    !hasPluginViewForExtension(
                                        (vaultStore.activeFile()?.path ?? "").split(".").pop()?.toLowerCase() ?? "",
                                    )
                                }
                            >
                                <Toolbar />
                            </Show>
                            <SplitWorkspaceView
                                primaryPath={primaryPanePath() ?? vaultStore.activeFile()?.path ?? null}
                                secondaryPath={secondaryPanePath()}
                                activeSlot={activePaneSlot()}
                                direction={splitDirection()}
                                onActivatePane={activatePane}
                                onClosePane={closeSplitPane}
                            />
                        </Show>
                    </Show>
                </main>
            </div>

            <StatusBar />
            <Show when={showCommandPalette()}>
                <CommandPalette onClose={() => setShowCommandPalette(false)} />
            </Show>
            <Show when={showSettings()}>
                <SettingsModal onClose={() => setShowSettings(false)} />
            </Show>
            <Show when={screenshotData()}>
                <ScreenshotOverlay
                    screenshotBase64={screenshotData()!}
                    onClose={() => setScreenshotData(null)}
                    onSave={handleScreenshotSave}
                />
            </Show>
            <ConfirmDialog />
        </div>
    );
};

// ============================================================================
// ActiveFileView — stable wrapper that prevents PluginViewHost re-creation
// ============================================================================
// CRITICAL: In Solid.js, an IIFE inside JSX is a reactive computation.
// If `vaultStore.activeFile()` is read inside such an IIFE, the ENTIRE
// subtree is destroyed and recreated on every signal change (including saves).
// This caused the mind-map plugin to call setViewData(data, true) on every
// save, resetting the selected node to the root node.
//
// This component uses createMemo to derive stable values from the active file
// signal, so child components are only recreated when the FILE PATH changes,
// not when content changes.

const SplitWorkspaceView: Component<{
    primaryPath: string | null;
    secondaryPath: string | null;
    activeSlot: PaneSlot;
    direction: SplitDirection;
    onActivatePane: (slot: PaneSlot) => void;
    onClosePane: (slot: PaneSlot) => void;
}> = (props) => {
    let containerRef: HTMLDivElement | undefined;
    const [splitRatio, setSplitRatio] = createSignal(0.5);
    const isSplit = createMemo(() => !!props.secondaryPath);
    const flexDirection = createMemo(() =>
        props.direction === "up" || props.direction === "down" ? "column" : "row",
    );
    const isHorizontalSplit = createMemo(() => flexDirection() === "row");
    const dividerThickness = 6;
    const dividerStyle = createMemo(() =>
        isHorizontalSplit()
            ? { width: `${dividerThickness}px`, height: "100%", cursor: "col-resize" }
            : { width: "100%", height: `${dividerThickness}px`, cursor: "row-resize" },
    );
    const paneStyle = (slot: PaneSlot) => ({
        flex: `${slot === "primary" ? splitRatio() : 1 - splitRatio()} 1 0`,
        "min-width": "0",
        "min-height": "0",
        display: "flex",
    });

    const startDividerDrag = (event: MouseEvent) => {
        event.preventDefault();
        if (!containerRef) return;

        const updateRatio = (clientX: number, clientY: number) => {
            const rect = containerRef!.getBoundingClientRect();
            const size = isHorizontalSplit() ? rect.width : rect.height;
            if (!size) return;
            const offset = isHorizontalSplit()
                ? clientX - rect.left
                : clientY - rect.top;
            const nextRatio = Math.max(0.2, Math.min(0.8, offset / size));
            setSplitRatio(nextRatio);
        };

        updateRatio(event.clientX, event.clientY);
        const previousCursor = document.body.style.cursor;
        document.body.style.cursor = isHorizontalSplit() ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";

        const onMove = (moveEvent: MouseEvent) => {
            updateRatio(moveEvent.clientX, moveEvent.clientY);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = previousCursor;
            document.body.style.removeProperty("user-select");
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    };

    return (
        <Show
            when={props.primaryPath}
            fallback={
                <div
                    style={{
                        flex: "1",
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        color: "var(--mz-text-muted)",
                        "font-size": "var(--mz-font-size-sm)",
                    }}
                >
                    {t("app.openFileOrSearch")}
                </div>
            }
        >
            <Show
                when={isSplit()}
                fallback={
                    <PaneFileView
                        filePath={props.primaryPath!}
                        active={true}
                        split={false}
                        onActivate={() => props.onActivatePane("primary")}
                    />
                }
            >
                <div
                    ref={containerRef}
                    style={{
                        flex: "1",
                        display: "flex",
                        "flex-direction": flexDirection(),
                        "min-width": "0",
                        "min-height": "0",
                        overflow: "hidden",
                        background: "var(--mz-bg-primary)",
                    }}
                >
                    <div style={paneStyle("primary")}>
                        <PaneFileView
                            filePath={props.primaryPath!}
                            active={props.activeSlot === "primary"}
                            split={true}
                            onActivate={() => props.onActivatePane("primary")}
                        />
                    </div>
                    <div
                        onMouseDown={startDividerDrag}
                        style={{
                            ...dividerStyle(),
                            background: "var(--mz-border)",
                            "flex-shrink": "0",
                            position: "relative",
                        }}
                    />
                    <div style={paneStyle("secondary")}>
                        <PaneFileView
                            filePath={props.secondaryPath!}
                            active={props.activeSlot === "secondary"}
                            split={true}
                            onActivate={() => props.onActivatePane("secondary")}
                            onClose={() => props.onClosePane("secondary")}
                        />
                    </div>
                </div>
            </Show>
        </Show>
    );
};

const PaneFileView: Component<{
    filePath: string;
    active: boolean;
    split: boolean;
    onActivate: () => void;
    onClose?: () => void;
}> = (props) => {
    const file = createMemo(
        () =>
            vaultStore.openFiles().find((entry) => entry.path === props.filePath) ??
            (vaultStore.activeFile()?.path === props.filePath ? vaultStore.activeFile() : null),
    );
    const fileExt = createMemo(() => props.filePath.split(".").pop()?.toLowerCase() ?? "");
    const isPluginView = createMemo(() => hasPluginViewForExtension(fileExt()));
    const viewMode = createMemo(() => editorStore.getViewModeForFile(props.filePath));
    const title = createMemo(() => props.filePath.split("/").pop() ?? props.filePath);

    return (
        <div
            onMouseDown={() => props.onActivate()}
            onFocusIn={() => props.onActivate()}
            style={{
                flex: "1",
                display: "flex",
                "flex-direction": "column",
                "min-width": "0",
                "min-height": "0",
                overflow: "hidden",
                background: "var(--mz-bg-primary)",
                "box-shadow": props.split && props.active ? "inset 0 0 0 1px var(--mz-accent)" : "none",
            }}
        >
            <Show when={props.split}>
                <div
                    style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "8px",
                        height: "30px",
                        padding: "0 10px",
                        background: props.active ? "var(--mz-bg-secondary)" : "var(--mz-bg-tertiary)",
                        "border-bottom": "1px solid var(--mz-border)",
                        "flex-shrink": "0",
                        color: props.active ? "var(--mz-text-primary)" : "var(--mz-text-secondary)",
                        "font-size": "var(--mz-font-size-xs)",
                    }}
                >
                    <span
                        style={{
                            flex: "1",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                        }}
                    >
                        {title()}
                    </span>
                    <Show when={props.onClose}>
                        <button
                            onClick={(event) => {
                                event.stopPropagation();
                                props.onClose?.();
                            }}
                            style={{
                                width: "20px",
                                height: "20px",
                                border: "none",
                                background: "transparent",
                                color: "var(--mz-text-muted)",
                                cursor: "pointer",
                                "border-radius": "var(--mz-radius-sm)",
                                "line-height": "1",
                                padding: "0",
                                "flex-shrink": "0",
                            }}
                            onMouseEnter={(event) => {
                                event.currentTarget.style.background = "var(--mz-bg-hover)";
                                event.currentTarget.style.color = "var(--mz-text-primary)";
                            }}
                            onMouseLeave={(event) => {
                                event.currentTarget.style.background = "transparent";
                                event.currentTarget.style.color = "var(--mz-text-muted)";
                            }}
                        >
                            ×
                        </button>
                    </Show>
                </div>
            </Show>

            <Show
                when={file()}
                fallback={
                    <div
                        style={{
                            flex: "1",
                            display: "flex",
                            "align-items": "center",
                            "justify-content": "center",
                            color: "var(--mz-text-muted)",
                            "font-size": "var(--mz-font-size-sm)",
                        }}
                    >
                        {t("app.openFileOrSearch")}
                    </div>
                }
            >
                <Show
                    when={isPluginView()}
                    fallback={
                        <Show
                            when={viewMode() === "reading"}
                            fallback={
                                <Editor
                                    file={file()}
                                    viewMode={viewMode()}
                                    isActive={props.active}
                                    onActivate={props.onActivate}
                                />
                            }
                        >
                            <ReadingView
                                file={file()}
                                isActive={props.active}
                                onActivate={props.onActivate}
                            />
                        </Show>
                    }
                >
                    <PluginViewHost
                        filePath={props.filePath}
                        content={file()!.content}
                        extension={fileExt()}
                    />
                </Show>
            </Show>
        </div>
    );
};

// ============================================================================
// Plugin View Host — renders plugin-managed views for registered extensions
// ============================================================================

const PluginViewHost: Component<{ filePath: string; content: string; extension: string }> = (props) => {
    let containerRef: HTMLDivElement | undefined;
    // Each PluginViewHost instance owns its OWN mount handle returned
    // from mountPluginView. Destroying by handle (instead of file path)
    // means that if the same file is mounted in another pane, this
    // pane's cleanup won't clobber that other pane.
    let currentPath: string | null = null;
    let currentHandle: string | null = null;
    const isMindzjInternalFile = () =>
        props.filePath.startsWith(".mindzj/") || props.filePath.includes("/.mindzj/");

    // Only track path changes — ignore content changes.
    // Content changes from plugin saves must NOT trigger re-mount, because
    // setViewData(data, true) resets the plugin's selection to the root node.
    createEffect(on(
        () => props.filePath,
        async (path) => {
            if (!containerRef || !path) return;
            if (path !== currentPath) {
                // Destroy THIS pane's previous view (if any) — by handle,
                // so a sibling pane showing the same file is unaffected.
                if (currentHandle) destroyPluginView(currentHandle);
                // Clear container
                containerRef.innerHTML = "";
                currentPath = path;
                currentHandle = null;
                // Use current content from props at mount time
                const mounted = await mountPluginView(
                    props.extension,
                    path,
                    props.content,
                    containerRef,
                );
                if (mounted) currentHandle = mounted.handle;
            }
        },
    ));

    onCleanup(() => {
        if (currentHandle) destroyPluginView(currentHandle);
    });

    return (
        <div
            ref={containerRef}
            on:contextmenu={(event: MouseEvent) => {
                if (!isMindzjInternalFile()) return;
                const target = event.target as HTMLElement | null;
                if (
                    target?.closest(
                        "button, [role='button'], [role='toolbar'], .clickable-icon, .view-header, .mod-toolbar",
                    )
                ) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
            style={{
                flex: "1",
                overflow: "hidden",
                width: "100%",
                height: "100%",
                position: "relative",
                // Ensure the plugin container fills all available space and
                // doesn't interfere with the plugin's own event handling.
                display: "flex",
                "flex-direction": "column",
            }}
        />
    );
};

// ============================================================================
// Vault Switcher Popup (bottom-left of sidebar)
// ============================================================================

const VaultSwitcher: Component<{
    onClose: () => void;
    onCloseVault: () => Promise<void>;
}> = (props) => {
    const [vaults, setVaults] = createSignal<{ name: string; path: string }[]>([]);

    // Normalize path for comparison (handle Windows \\?\ prefix and slash differences)
    function normalizePath(p: string | undefined): string {
        if (!p) return "";
        return p.replace(/^\\\\?\?\\/i, "").replace(/\\/g, "/").toLowerCase();
    }

    onMount(() => {
        try {
            const saved = localStorage.getItem("mindzj-vault-list");
            if (saved) setVaults(JSON.parse(saved));
        } catch {}

        const handleClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest(".mz-vault-switcher")) props.onClose();
        };
        setTimeout(() => document.addEventListener("click", handleClick), 0);
        onCleanup(() => document.removeEventListener("click", handleClick));
    });

    async function openVaultInNewWindow(path: string, name: string) {
        try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("open_vault_window", { vaultPath: path, vaultName: name });
        } catch (e) {
            console.error("Failed to open vault in new window:", e);
            // Fallback: open in current window
            await vaultStore.openVault(path, name);
        }
    }

    return (
        <div class="mz-vault-switcher" style={{
            position: "absolute", bottom: "100%", left: "0",
            "min-width": "220px", "margin-bottom": "4px",
            background: "var(--mz-bg-secondary)",
            border: "1px solid var(--mz-border-strong)",
            "border-radius": "var(--mz-radius-md)",
            "box-shadow": "0 8px 24px rgba(0,0,0,0.25)",
            padding: "4px 0", "z-index": "1000",
        }}>
            {/* Vault list */}
            <For each={vaults()}>
                {(v) => {
                    const isCurrent = normalizePath(v.path) === normalizePath(vaultStore.vaultInfo()?.path as unknown as string);
                    return (
                        <button
                            onClick={async () => {
                                if (!isCurrent) {
                                    await openVaultInNewWindow(v.path, v.name);
                                }
                                props.onClose();
                            }}
                            style={{
                                display: "flex", "align-items": "center", "justify-content": "space-between",
                                width: "100%", padding: "8px 12px", border: "none",
                                background: "transparent", color: "var(--mz-text-primary)",
                                cursor: "pointer", "font-size": "var(--mz-font-size-sm)",
                                "font-family": "var(--mz-font-sans)", "text-align": "left",
                                gap: "8px",
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
                            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                        >
                            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" style={{ "flex-shrink": "0" }}>
                                <rect x="2" y="4" width="16" height="13" rx="2" stroke={isCurrent ? "var(--mz-accent)" : "var(--mz-text-muted)"} stroke-width="1.5" fill="none" />
                                <path d="M2 7H18" stroke={isCurrent ? "var(--mz-accent)" : "var(--mz-text-muted)"} stroke-width="1.5" />
                            </svg>
                            <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", flex: "1" }}>{v.name}</span>
                            <Show when={isCurrent}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--mz-accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style={{ "flex-shrink": "0" }}>
                                    <path d="M20 6L9 17l-5-5" />
                                </svg>
                            </Show>
                            <Show when={!isCurrent}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--mz-text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "flex-shrink": "0", opacity: "0.5" }}>
                                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                                </svg>
                            </Show>
                        </button>
                    );
                }}
            </For>

            {/* Divider */}
            <Show when={vaults().length > 0}>
                <div style={{ height: "1px", background: "var(--mz-border)", margin: "4px 8px" }} />
            </Show>

            {/* Manage vaults */}
            <button
                onClick={async () => {
                    props.onClose();
                    await props.onCloseVault();
                }}
                style={{
                    display: "flex", "align-items": "center", gap: "8px",
                    width: "100%", padding: "8px 12px", border: "none",
                    background: "transparent", color: "var(--mz-text-secondary)",
                    cursor: "pointer", "font-size": "var(--mz-font-size-sm)",
                    "font-family": "var(--mz-font-sans)", "text-align": "left",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 3h7a2 2 0 012 2v14a2 2 0 01-2 2h-7M19 12H5M5 12l4-4M5 12l4 4" />
                </svg>
                {t("common.manageVaults")}
            </button>
        </div>
    );
};

export default App;
