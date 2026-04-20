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
    loadFolderState,
    saveFolderState,
    setAllFoldersVisibility,
    revealFileInTree,
    type SortMode,
    type SortOrder,
} from "./components/sidebar/FileTree";
import { Outline } from "./components/sidebar/Outline";
import {
    SearchPanel,
    setQuery as setGlobalSearchQuery,
    runSearchNow as runGlobalSearchNow,
} from "./components/sidebar/SearchPanel";
import { Calendar } from "./components/sidebar/Calendar";
import { TabBar } from "./components/tabs/TabBar";
import { Editor } from "./components/editor/Editor";
import { Toolbar } from "./components/editor/Toolbar";
import { ReadingView } from "./components/editor/ReadingView";
import { ConfirmDialog } from "./components/common/ConfirmDialog";
import { StatusBar } from "./components/common/StatusBar";
import { WelcomeScreen } from "./components/common/WelcomeScreen";
import { CommandPalette } from "./components/common/CommandPalette";
import { GotoLinePanel } from "./components/common/GotoLinePanel";
import { SettingsModal } from "./components/settings/SettingsModal";
import { WindowControls } from "./components/common/TitleBar";
import { ImageViewer } from "./components/common/ImageViewer";
import { FilePreview } from "./components/common/FilePreview";
import { createPersistableWindowState } from "./utils/windowState";
import { register, unregister, isRegistered } from "@tauri-apps/plugin-global-shortcut";
import { ScreenshotOverlay } from "./components/screenshot/ScreenshotOverlay";
import { promptDialog } from "./components/common/ConfirmDialog";
import { openFileRouted } from "./utils/openFileRouted";
import {
    openSearchPanel,
    closeSearchPanel,
    searchPanelOpen,
    setSearchQuery,
    SearchQuery,
} from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { t } from "./i18n";
import {
    setFindQuery,
    findCaseSensitive,
    findWholeWord,
    findRegex,
    findReplaceText,
} from "./stores/findState";

type SidebarTab = "files" | "outline" | "search" | "calendar";
type SplitDirection = "left" | "right" | "up" | "down";
type PaneSlot = "primary" | "secondary";

function normalizeVaultPath(path: string | null | undefined): string {
    if (!path) return "";
    return path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
}

const App: Component = () => {
    // If the window was created via `open_image_in_new_window`, the
    // URL carries `image_viewer=1` plus a vault_path/file_path. In that
    // case we render ONLY the ImageViewer component — no sidebar, no
    // editor, no plugin system, no bootstrapping/workspace-restore
    // machinery. This is what lets an image .png pop up in a tiny
    // clean viewer window instead of the full app.
    {
        const params = new URLSearchParams(window.location.search);
        if (params.get("image_viewer") === "1") {
            return (
                <ImageViewer
                    vaultPath={params.get("vault_path") ?? ""}
                    filePath={params.get("file_path") ?? ""}
                />
            );
        }
    }

    const [showCommandPalette, setShowCommandPalette] = createSignal(false);
    // Ctrl+P opens the palette in "commands" mode (commands only);
    // Ctrl+O opens it in "files" mode (notes + a synthetic "Create"
    // entry when the query doesn't match an existing file). See the
    // keydown branch for `command-palette` / `command-palette-alt`.
    const [commandPaletteMode, setCommandPaletteMode] = createSignal<
        "commands" | "files"
    >("commands");
    // Ctrl+G goto-line popup. A compact floating widget; on Enter it
    // dispatches `mindzj:editor-command` with `goto-line`, which
    // both Editor and ReadingView already handle (scroll + 1s line
    // flash in the shared `.mz-search-flash` colour).
    const [showGotoLine, setShowGotoLine] = createSignal(false);
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

    // Recently-closed tab history (LIFO stack of vault-relative
    // file paths). Used by Ctrl+T to "reopen the last closed tab",
    // mirroring the same shortcut in browsers / VS Code / Obsidian.
    //
    // The stack is bounded so a user who closes thousands of tabs in
    // a long session doesn't accumulate unbounded state. The most
    // recent entry is at the END of the array (LIFO push/pop).
    const MAX_CLOSED_HISTORY = 50;
    const [closedTabsHistory, setClosedTabsHistory] = createSignal<string[]>([]);

    function pushClosedTab(path: string) {
        setClosedTabsHistory((prev) => {
            // De-dupe: drop any earlier occurrence of the same path
            // so closing a file that was already in history bumps it
            // to the top instead of leaving stale duplicates that
            // would Ctrl+T-reopen the same file twice in a row.
            const deduped = prev.filter((p) => p !== path);
            const next = [...deduped, path];
            // Cap from the OLD end (drop oldest entries first).
            return next.length > MAX_CLOSED_HISTORY
                ? next.slice(next.length - MAX_CLOSED_HISTORY)
                : next;
        });
    }

    function reopenLastClosedTab() {
        const history = closedTabsHistory();
        if (history.length === 0) return;
        const path = history[history.length - 1];
        // Pop FIRST, then reopen — popping after reopen would risk
        // leaving the entry stuck in the stack if openFileRouted
        // throws synchronously somewhere we don't expect.
        setClosedTabsHistory((prev) => prev.slice(0, -1));
        void openFileRouted(path);
    }

    // Ephemeral "shortcut fired" toast. Lets us verify, without
    // needing to open devtools, whether a keyboard shortcut handler
    // actually ran. When a path calls `showShortcutToast(msg)` the
    // toast appears top-center for 1.2s then fades out. Used by
    // `switchOpenTab` so the user can SEE that the handler fired
    // even if tab switching itself looks like it didn't do anything
    // (e.g. only one tab open, so prev/next is a no-op).
    const [shortcutToast, setShortcutToast] = createSignal<string | null>(null);
    let shortcutToastTimer: ReturnType<typeof setTimeout> | null = null;
    function showShortcutToast(message: string) {
        setShortcutToast(message);
        if (shortcutToastTimer) clearTimeout(shortcutToastTimer);
        shortcutToastTimer = setTimeout(() => setShortcutToast(null), 1200);
    }

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
        // Normalise arrow keys so hotkey strings like "Ctrl+Alt+Left"
        // actually match DOM events whose `e.key` is `"ArrowLeft"`.
        // The HotkeysPanel capture UI already uses the short form
        // (Up / Down / Left / Right / Space) when saving overrides,
        // so we must match that when comparing.
        if (normalized === "ArrowLeft") return "Left";
        if (normalized === "ArrowRight") return "Right";
        if (normalized === "ArrowUp") return "Up";
        if (normalized === "ArrowDown") return "Down";
        if (normalized === " ") return "Space";
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
        document.dispatchEvent(new CustomEvent("mindzj:remember-active-viewport"));
        setPanePath(activePaneSlot(), path);
        vaultStore.switchToFile(path);
    }

    function switchOpenTab(direction: "prev" | "next"): boolean {
        const files = vaultStore.openFiles();
        // Fire the visible toast unconditionally — if the user sees
        // it, they know the shortcut reached this function. If they
        // don't, we know the keyboard event never made it here (which
        // is the interesting debugging signal).
        showShortcutToast(
            direction === "prev"
                ? `← tab (${files.length} open)`
                : `tab → (${files.length} open)`,
        );

        if (files.length === 0) return false;

        const currentPath =
            activePanePath() ?? vaultStore.activeFile()?.path ?? null;
        const idx = currentPath
            ? files.findIndex((file) => file.path === currentPath)
            : -1;
        const newIdx = direction === "prev"
            ? idx <= 0
                ? files.length - 1
                : idx - 1
            : idx < 0 || idx >= files.length - 1
                ? 0
                : idx + 1;
        const next = files[newIdx];
        if (!next) return false;

        handleTabSelect(next.path);
        return true;
    }

    function handleTabClose(path: string) {
        // Snapshot the open files BEFORE closing so we can compute
        // which tab to focus next based on the closed tab's position.
        const openFilesBefore = vaultStore.openFiles();
        const closedIndex = openFilesBefore.findIndex((f) => f.path === path);
        if (closedIndex === -1) return;

        const remainingPaths = openFilesBefore
            .filter((file) => file.path !== path)
            .map((file) => file.path);

        // Push the closed path onto the recently-closed history so
        // the user can reopen it with Ctrl+T. We do this BEFORE the
        // actual close so we don't end up with an inconsistent state
        // if anything below throws.
        pushClosedTab(path);

        const primaryBefore = primaryPanePath();
        const secondaryBefore = secondaryPanePath();
        const activeBefore = activePaneSlot();

        vaultStore.closeFile(path);

        // Replacement-picker policy:
        //   1. Prefer the LEFT neighbour of the closed tab — i.e. the
        //      file that sits at index `closedIndex - 1` in the
        //      original openFiles array. After removal it's at the
        //      same index in `remainingPaths`.
        //   2. If the closed tab was the LEFTMOST (closedIndex === 0),
        //      fall back to the new leftmost (which used to be at
        //      index 1, and is now at index 0 in `remainingPaths`).
        //   3. If `exclude` is given (because the OTHER pane is already
        //      showing that candidate and we don't want both panes
        //      pointing at the same file), skip past it in either
        //      direction.
        const pickReplacement = (exclude: string | null = null): string | null => {
            if (remainingPaths.length === 0) return null;

            // Build the search order: left neighbour first, then walk
            // further LEFT, then walk RIGHT from the original position.
            // This way "select the closest existing tab" works even
            // when the immediate neighbour also happens to be excluded.
            const order: number[] = [];
            for (let i = closedIndex - 1; i >= 0; i--) order.push(i);
            // After removal, indices >= closedIndex shift down by one,
            // but the i-th remaining file IS the original (i+1)-th
            // file. We want to traverse those in the original order,
            // which corresponds to remaining indices `closedIndex,
            // closedIndex+1, …` IF closedIndex < remainingPaths.length.
            for (let i = closedIndex; i < remainingPaths.length; i++) order.push(i);

            for (const idx of order) {
                const candidate = remainingPaths[idx];
                if (candidate && candidate !== exclude) return candidate;
            }
            return null;
        };

        // Pane reassignment. If a pane was pointing at the closed
        // file, replace it with the picker's choice; the OTHER pane
        // is unaffected unless both happened to point at the same
        // (now closed) file.
        let nextPrimary = primaryBefore === path
            ? pickReplacement(secondaryBefore === path ? null : secondaryBefore)
            : primaryBefore;
        let nextSecondary = secondaryBefore === path
            ? pickReplacement(nextPrimary)
            : secondaryBefore;

        if (nextSecondary === nextPrimary && nextSecondary !== null) {
            nextSecondary = pickReplacement(nextPrimary);
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

    async function handleOpenSplitInPane(path: string, direction: SplitDirection) {
        // Plugin-backed files (`.mindzj` etc.) now work in same-window
        // panes too: `mountPluginView` generates a unique mount handle
        // per call, so the same file path can be mounted in the
        // primary AND the secondary pane concurrently without either
        // clobbering the other's DOM. Previously this branch contained
        // a safety check that silently bailed out for plugin views and
        // either did nothing or opened a whole new Tauri window — now
        // we take the same fast path as .md files.
        const previousActivePath = activePanePath() ?? vaultStore.activeFile()?.path ?? null;

        if (!findOpenFile(path)) {
            await openFileRouted(path);
            if (!findOpenFile(path)) return;
        }

        if (
            previousActivePath &&
            previousActivePath !== path &&
            getPanePath(activePaneSlot()) === path
        ) {
            setPanePath(activePaneSlot(), previousActivePath);
            const previousFile = findOpenFile(previousActivePath);
            if (previousFile) {
                vaultStore.setActiveFile(previousFile);
            }
        }

        if (!previousActivePath) {
            setPrimaryPanePath(path);
            setSecondaryPanePath(null);
            activatePane("primary");
            return;
        }

        setSplitDirection(direction);
        const currentActivePath = previousActivePath;

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
        await Promise.all([
            workspaceStore.saveWorkspace(buildWorkspaceSnapshot()),
            saveFolderState(),
        ]);
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
            // Copy the screenshot to the system clipboard instead
            // of writing it directly into `.mindzj/images/` + inserting
            // markdown. The user wanted a two-step flow: snip → appear
            // on clipboard → paste with Ctrl+V into whichever note they
            // choose, at whichever position they want.
            //
            // The existing CM6 `paste` dom-event handler
            // (`src/components/editor/Editor.tsx`) already intercepts
            // image items from `clipboardData.items`, generates a
            // filename like `Pasted image YYYYMMDDHHmmss.png`, saves
            // to the attachment folder, and inserts the markdown
            // reference. So by putting the PNG on the clipboard here,
            // pressing Ctrl+V in an editor re-uses that whole
            // infrastructure for free.
            //
            // We use the browser Clipboard API (`navigator.clipboard
            // .write`) with a `ClipboardItem` carrying the PNG blob.
            // Tauri's custom protocol origin counts as a secure
            // context in WebView2, so this API is available.
            //
            // (Tauri's own `writeImage` from `plugin-clipboard-manager`
            // expects a `Uint8Array` of RGBA pixels, not a PNG byte
            // stream, so we'd have to decode the PNG first — lots of
            // extra code. The Blob path is simpler and works.)

            // Decode base64 → Uint8Array → Blob(image/png)
            const binary = atob(base64Png);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: "image/png" });

            // Write to the system clipboard. The `ClipboardItem`
            // MIME → Blob map is how `navigator.clipboard.write`
            // signals "this item is an image/png". Any paste
            // target — including MindZJ's own editor paste handler,
            // which reads `clipboardData.items` — will see this as
            // an image.
            try {
                await navigator.clipboard.write([
                    new ClipboardItem({ "image/png": blob }),
                ]);
            } catch (clipErr) {
                // If Clipboard API is unavailable for any reason
                // (e.g. secure-context check failed, browser
                // policy blocked it), fall back to the old save-
                // to-vault behavior so the screenshot isn't lost.
                console.warn(
                    "[Screenshot] clipboard.write failed, falling back to disk:",
                    clipErr,
                );
                // Build a filename. NOTE: `.slice(0, 15)` used to
                // keep the `.` that separates seconds from
                // milliseconds in ISO 8601 ("20260411194532.123Z"),
                // producing filenames like `screenshot_20260411194532..png`
                // (double dot). `.slice(0, 14)` trims to exactly
                // `YYYYMMDDHHmmss` (14 chars).
                const timestamp = new Date()
                    .toISOString()
                    .replace(/[-:T]/g, "")
                    .slice(0, 14);
                const filename = `screenshot_${timestamp}.png`;
                const s = settingsStore.settings();
                const folder = s.attachment_folder || ".mindzj/images";
                const relativePath = `${folder}/${filename}`;
                await invoke("write_binary_file", {
                    relativePath,
                    base64Data: base64Png,
                });
                const activeFile = vaultStore.activeFile();
                if (activeFile) {
                    const imgMarkdown = `![${filename}](${relativePath})`;
                    document.dispatchEvent(
                        new CustomEvent("mindzj:insert-text", {
                            detail: { text: imgMarkdown },
                        }),
                    );
                }
            }
        } catch (err) {
            console.error("[Screenshot] save failed:", err);
        } finally {
            setScreenshotData(null);
        }
    }

    onMount(async () => {
        (window as any).__mindzj_flush_workspace = flushWorkspaceNow;
        (window as any).__mindzj_switch_open_tab = switchOpenTab;
        document.body.style.removeProperty("zoom");
        document.documentElement.style.removeProperty("font-size");

        if (startupUiZoom !== null && Number.isFinite(startupUiZoom)) {
            editorStore.setUiZoom(startupUiZoom);
        }
        // Use capture phase so global shortcuts (Ctrl+E, etc.) fire BEFORE
        // CodeMirror's own keydown handlers consume the event.
        window.addEventListener("keydown", handleTabSwitchKeydown, true);
        document.addEventListener("keydown", handleGlobalKeydown, true);
        onCleanup(() => {
            window.removeEventListener("keydown", handleTabSwitchKeydown, true);
            document.removeEventListener("keydown", handleGlobalKeydown, true);
        });

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
        onCleanup(() => {
            if ((window as any).__mindzj_switch_open_tab === switchOpenTab) {
                (window as any).__mindzj_switch_open_tab = null;
            }
        });

        // NOTE: the global screenshot shortcut is registered by the
        // dedicated `createEffect` further below — we used to ALSO
        // register it here, which caused the OS to see two register()
        // calls in the same boot and emit "HotKey already registered:
        // KeyG" warnings on every startup. The createEffect handles
        // both the initial registration AND re-registration when the
        // user changes the hotkey in Settings, so this onMount block
        // is now redundant and removed.

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
        // Fail-safe: if the vault open didn't actually succeed (file
        // gone, permission denied, missing from list, etc.) the
        // workspace-restore createEffect won't fire and would leave
        // us stuck on the dark canvas forever. In that case drop the
        // gate now so the welcome screen shows.
        //
        // The HAPPY path — vaultInfo() became truthy — leaves
        // bootstrapping ON; the workspace-restore createEffect will
        // drop the gate AFTER it has loaded the workspace, opened all
        // saved tabs, switched to the active tab and mounted plugin
        // views. That avoids the visible "empty main area → tabs
        // appear one by one → final settled state" flicker the user
        // was reporting.
        if (!vaultStore.vaultInfo()) {
            setIsBootstrapping(false);
        }
    });

    // Screenshot hotkey lifecycle.
    //
    // We need to:
    //   1. Register the hotkey once on app boot.
    //   2. Re-register if the user changes the hotkey in Settings.
    //   3. Unregister on app exit so a stale OS-level binding doesn't
    //      survive into the next launch.
    //
    // The previous version naively wrapped a `createEffect` around
    // `getHotkey(...)`. Because settings is reactive and gets
    // RE-WRITTEN at boot (defaults → loadSettings() result), the
    // effect would fire twice in the same second — both times calling
    // unregister() then register(). The OS doesn't release the
    // binding fast enough between the two calls and we got
    // "HotKey already registered" warnings on every startup.
    //
    // The fix: track the LAST registered combo manually and skip
    // re-registration if the value didn't actually change.
    {
        let lastCombo: string | null = null;
        let pending: Promise<void> = Promise.resolve();

        const syncShortcut = (nextCombo: string) => {
            if (nextCombo === lastCombo) return;
            const previousCombo = lastCombo;
            lastCombo = nextCombo;
            // Chain off the previous in-flight register/unregister so
            // we never have two flows touching the OS hotkey table
            // concurrently.
            pending = pending.then(async () => {
                if (previousCombo) {
                    try { await unregister(previousCombo); } catch {}
                }
                try {
                    await register(nextCombo, (event) => {
                        if (event.state === "Pressed") startScreenshot();
                    });
                } catch (err) {
                    console.warn(
                        "[GlobalShortcut] Failed to (re)register screenshot shortcut:",
                        err,
                    );
                    // Roll back so the next change attempt can retry.
                    lastCombo = previousCombo;
                }
            });
        };

        createEffect(() => {
            const combo = getHotkey("screenshot", "Alt+G");
            syncShortcut(combo);
        });

        onCleanup(() => {
            const combo = lastCombo;
            if (combo) {
                pending = pending.then(() => unregister(combo).catch(() => {}));
                lastCombo = null;
            }
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  Ctrl+Alt+Left / Ctrl+Alt+Right — OS-level global shortcuts
    // ─────────────────────────────────────────────────────────────
    //
    // After multiple failed attempts to get this to work via the DOM
    // keydown path, we ALSO register at the OS level via Tauri's
    // global-shortcut plugin. The most likely explanation for the
    // DOM path never firing on the user's machine is that Windows'
    // Intel Graphics Command Center hijacks Ctrl+Alt+Arrow at the OS
    // level for screen rotation BEFORE the webview even sees the
    // keypress. Registering at the OS level tells Windows "this app
    // owns this shortcut" and typically supersedes the graphics
    // driver binding.
    //
    // Key design decisions vs. earlier versions of this block:
    //  - NO `isFocused()` check. Previously we bailed out of the
    //    callback if another window was on top, but `isFocused()` is
    //    async and racing with the keydown → the first press would
    //    sometimes resolve false even though the user was actively
    //    focused on MindZJ. Now we just switch unconditionally. A
    //    global shortcut fire while another app is on top is a
    //    corner case the user would have to go out of their way to
    //    produce; if it matters we can re-add focus filtering later.
    //  - We call `switchOpenTab` SYNCHRONOUSLY from inside the
    //    plugin-global-shortcut callback. It triggers the visible
    //    toast, which is our smoke-test signal.
    //  - `isRegistered()` is called immediately after `register()`
    //    so the user-facing log shows whether registration actually
    //    succeeded. If it didn't, the most likely cause is another
    //    application (or OS component) already claiming the key.
    onMount(async () => {
        const tryRegister = async (combo: string, direction: "prev" | "next") => {
            try {
                await register(combo, (event) => {
                    if (event.state === "Pressed") switchOpenTab(direction);
                });
                const ok = await isRegistered(combo).catch(() => false);
                // eslint-disable-next-line no-console
                console.log(`[GlobalShortcut] register('${combo}') success=${ok}`);
            } catch (err) {
                console.warn(
                    `[GlobalShortcut] register('${combo}') failed:`,
                    err,
                );
            }
        };
        await tryRegister("CommandOrControl+Alt+Left", "prev");
        await tryRegister("CommandOrControl+Alt+Right", "next");

        // Listen for the `mindzj://tab-switch` event emitted by the
        // Rust-side Windows low-level keyboard hook
        // (src-tauri/src/keyboard_hook.rs). That hook catches
        // Ctrl+Alt+Left/Right at the kernel-driver level, BEFORE
        // Intel/AMD graphics drivers can intercept them for screen
        // rotation. The payload is the string "prev" or "next".
        // This is the "nuclear option" path — it should always
        // fire on Windows whether or not any of the higher-level
        // (DOM keydown, RegisterHotKey) paths manage to see the
        // event first.
        const unlistenTabSwitch = await listen<string>(
            "mindzj://tab-switch",
            (event) => {
                const direction = event.payload === "prev" ? "prev" : "next";
                // eslint-disable-next-line no-console
                console.log(`[tab-switch] event from Rust hook: ${direction}`);
                switchOpenTab(direction);
            },
        );

        onCleanup(() => {
            unregister("CommandOrControl+Alt+Left").catch(() => {});
            unregister("CommandOrControl+Alt+Right").catch(() => {});
            try { unlistenTabSwitch(); } catch {}
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

    // Restore workspace and load plugins when vault opens.
    //
    // CRITICAL: `defer: true` is required. Without it, this effect
    // fires on initial mount with `vaultInfo() === null` (because
    // onMount hasn't started the openVault call yet), hits the else
    // branch and would drop the bootstrapping gate prematurely — the
    // user would see a one-frame flash of the welcome screen before
    // the real vault loads. With `defer: true`, the effect only runs
    // when vaultInfo() ACTUALLY transitions (null → vault, or
    // vault → null). The initial null state is silently skipped.
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
                    try { await openFileRouted(filePath); } catch { /* skip missing files */ }
                }
                if (ws.active_file) {
                    try { vaultStore.switchToFile(ws.active_file); } catch { /* skip */ }
                }
            }
            // Load persisted folder expand/collapse state BEFORE the
            // sidebar becomes visible. Previously this ran in the
            // FileTree component's own onMount which fires AFTER the
            // bootstrapping gate drops — so for one frame the user
            // saw every folder in the default "collapsed" state,
            // then the saved state snapped in. Loading here keeps
            // the folder tree visually stable from the first paint.
            try {
                await loadFolderState();
            } catch (e) {
                console.warn("[vault-open] loadFolderState failed:", e);
            }
            // Load enabled plugins
            await pluginStore.loadAllPlugins();
            if (!startupPayloadApplied() && (startupFilePath || isViewMode(startupViewMode))) {
                if (startupFilePath) {
                    try {
                        await openFileRouted(startupFilePath);
                    } catch (e) {
                        console.warn("Failed to open startup file from URL params:", e);
                    }
                }
                if (isViewMode(startupViewMode)) {
                    editorStore.setViewMode(startupViewMode);
                }
                setStartupPayloadApplied(true);
            }
            // Workspace fully restored: tabs are open, the active
            // tab is selected, plugins are loaded. Drop the
            // bootstrapping gate so the UI becomes visible. We
            // wait two animation frames first because:
            //   1. Solid still has pending effects to flush
            //      (PluginViewHost's mount effect, Editor's scroll
            //      restoration createEffect, etc.).
            //   2. The webview itself needs one paint to draw the
            //      mounted DOM before we reveal it — otherwise the
            //      user sees the dark canvas → flash of unstyled
            //      content → settled state.
            //
            // Two RAFs is the minimum delay that guarantees both the
            // microtask queue AND a full layout/paint cycle have
            // completed. Total wait is ~32ms at 60 Hz which is
            // imperceptible to the user.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setIsBootstrapping(false);
                });
            });
        } else {
            // Vault closed — unload all plugins. With defer: true on
            // the on() above, this branch only ever runs when the
            // user actively closes a vault (truthy → null transition),
            // never on initial mount. So we DO NOT touch the
            // bootstrapping gate here; it's handled exclusively by
            // onMount (fail-safe path) and the truthy branch above.
            settingsStore.resetSettings();
            editorStore.resetWorkspaceState();
            await pluginStore.unloadAllPlugins();
        }
    }, { defer: true }));

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
    // Platform detection: on macOS the `Cmd` key (aka Meta) is the
    // primary modifier, so a hotkey string of "Ctrl+X" should match
    // Cmd+X. On Windows/Linux the Meta key is the Win/Super key and
    // is RESERVED for system use — "Ctrl+X" must match Ctrl+X ONLY,
    // never Win+X. Folding them together (the previous behavior of
    // `needCtrl !== (e.ctrlKey || e.metaKey)`) caused Win+F to
    // accidentally trigger our Ctrl+F handlers AND prevented
    // Windows' own Win+F (Feedback Hub) from firing properly.
    const _isMacPlatform = /mac|iphone|ipod|ipad/i.test(
        typeof navigator !== "undefined" ? navigator.platform : "",
    );

    /** Returns true when the primary "Ctrl-like" modifier is held.
     *  On Mac that's Cmd (metaKey); on Windows/Linux it's strictly
     *  Ctrl, NEVER the Win key. */
    function isCtrlHeld(e: KeyboardEvent): boolean {
        if (_isMacPlatform) return e.ctrlKey || e.metaKey;
        // Windows/Linux: require Ctrl AND require metaKey to NOT be
        // down — otherwise Win+X would flow through as if it were
        // Ctrl+X, breaking Windows-reserved combos like Win+F /
        // Win+S / Win+R.
        return e.ctrlKey && !e.metaKey;
    }

    function matchesHotkey(e: KeyboardEvent, combo: string): boolean {
        const parts = combo.split("+");
        const keyPart = parts[parts.length - 1];
        const needCtrl = parts.includes("Ctrl");
        const needShift = parts.includes("Shift");
        const needAlt = parts.includes("Alt");
        const needMeta = parts.includes("Meta");

        // On Mac, the Ctrl slot is satisfied by Cmd (metaKey). On
        // Windows/Linux it's strictly the real Ctrl key — holding
        // the Win key alone must NOT count as Ctrl.
        const ctrlHeld = _isMacPlatform
            ? e.ctrlKey || e.metaKey
            : e.ctrlKey;
        if (needCtrl !== ctrlHeld) return false;
        if (needShift !== e.shiftKey) return false;
        if (needAlt !== e.altKey) return false;
        // Windows: if metaKey is down and we DIDN'T ask for it in
        // the combo, bail out. This is the other half of the
        // Win+F fix: it stops e.g. Win+S from firing our Ctrl+S
        // save handler (because needCtrl=true but ctrlHeld=false,
        // we'd return early anyway — but this guards cases like
        // "just F" hotkeys where the user has Win held down as
        // they start typing something).
        if (!_isMacPlatform && !needMeta && e.metaKey) return false;
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

    function getTabSwitchDirectionFromEvent(e: KeyboardEvent): "prev" | "next" | null {
        const keyCode = e.keyCode || e.which;
        const isLeft =
            e.code === "ArrowLeft" ||
            e.key === "ArrowLeft" ||
            e.key === "Left" ||
            keyCode === 37;
        const isRight =
            e.code === "ArrowRight" ||
            e.key === "ArrowRight" ||
            e.key === "Right" ||
            keyCode === 39;
        const isTabSwitchHotkey =
            isCtrlHeld(e) &&
            (isLeft || isRight) &&
            ((e.shiftKey && !e.altKey) || (e.altKey && !e.shiftKey));

        if (!isTabSwitchHotkey) return null;
        return isLeft ? "prev" : "next";
    }

    function handleTabSwitchKeydown(e: KeyboardEvent): boolean {
        // ═══════════════════════════════════════════════════════════
        //  Ctrl+Shift+Left / Ctrl+Shift+Right → switch to prev/next tab.
        //  Ctrl+Alt+Left / Ctrl+Alt+Right is kept as a compatibility alias.
        // ═══════════════════════════════════════════════════════════
        //
        // This check is DELIBERATELY placed at the very top of the
        // keydown handler, BEFORE any other early-return or the
        // `__mindzj_hotkey_capturing` bail-out. Previous attempts
        // that used `matchesHotkey(getHotkey("tab-prev"))` further
        // down the function never worked for the user — diagnosis
        // was eating too much time, so this version:
        //
        //   1. Matches by `e.code === "ArrowLeft"/"ArrowRight"`
        //      (layout-independent — doesn't care if the user has a
        //      non-US keyboard that maps the left-arrow key to a
        //      non-"ArrowLeft" `e.key` value).
        //   2. Also accepts `e.key === "ArrowLeft"/"ArrowRight"` and
        //      `"Left"/"Right"` as a fallback.
        //   3. Calls `stopImmediatePropagation()` on top of the
        //      usual `preventDefault`+`stopPropagation`, so no other
        //      capture-phase listener on `document` (e.g. the plugin
        //      hotkey handler in stores/plugins.ts) gets a chance
        //      to swallow or re-dispatch the event.
        //   4. Switches tabs through `switchOpenTab(...)`, which
        //      goes through `handleTabSelect(path)` — the same
        //      routine a TabBar click uses, so the pane-path signal
        //      and the vault-store active file stay in lock-step.
        //
        // If this STILL doesn't fire for someone, set
        // `localStorage.setItem("mindzj-debug-tab-switch", "1")` in
        // devtools; the next press will dump the event details to
        // the console so we can see exactly what the webview is
        // sending.
        const direction = getTabSwitchDirectionFromEvent(e);
        if (!direction) return false;

        if (localStorage.getItem("mindzj-debug-tab-switch") === "1") {
            // eslint-disable-next-line no-console
            console.debug(
                "[tab-switch] Ctrl+Shift/Alt+Arrow caught",
                { key: e.key, code: e.code, keyCode: e.keyCode, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey },
            );
        }
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        switchOpenTab(direction);
        return true;
    }

    function handleGlobalKeydown(e: KeyboardEvent) {
        if (handleTabSwitchKeydown(e)) return;

        // NOTE: the bare-Alt preventDefault guard that used to live
        // here has been removed. It was originally needed to stop
        // WebView2 from entering menu-activation mode on an isolated
        // Alt press (which then caused the next letter, e.g. G, to
        // fire the WebView's built-in find dialog instead of our
        // Alt+G screenshot shortcut). Now that the Rust setup hook
        // flips `AreBrowserAcceleratorKeysEnabled(false)` on every
        // webview (see `disable_webview2_browser_accelerator_keys`),
        // the menu-mode path is disabled at the webview layer and
        // the JS guard is redundant. Keeping it was also suspected
        // of swallowing the altKey modifier on the subsequent G
        // keydown in some WebView2 builds, which made Alt+G feel
        // broken — drop it here.

        // If the settings hotkey capture is active, let the HotkeysPanel handle the event
        if ((window as any).__mindzj_hotkey_capturing) return;

        // Check if the editor (CodeMirror) is focused
        const editorFocused = !!(document.activeElement?.closest(".cm-editor"));

        // Ctrl+F (NOT Ctrl+Shift+F, NOT with Alt) → open the CM6
        // in-editor find panel. We intercept this GLOBALLY rather
        // than letting CM6's own searchKeymap handle it only-when-
        // editor-focused because:
        //
        //   (a) WebView2 has its own built-in "Find in page" UI
        //       that pops over the app whenever Ctrl+F fires and
        //       isn't consumed by a DOM handler. After the user
        //       presses Win+F (which shifts focus away from the
        //       editor), the next Ctrl+F would hit that WebView2
        //       default instead of our search — the exact bug
        //       the user reported.
        //   (b) Blocking it unconditionally and re-dispatching to
        //       CM6 makes the behavior consistent regardless of
        //       where focus currently is.
        //
        // We explicitly check `e.ctrlKey` (not `e.ctrlKey ||
        // e.metaKey`) on Windows so Win+F still flows to the OS
        // as Windows Feedback Hub — see the platform check in
        // `matchesHotkey` above.
        if (
            isCtrlHeld(e) &&
            !e.altKey &&
            !e.shiftKey &&
            (e.key === "f" || e.key === "F")
        ) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // Ctrl+F is a TOGGLE: if a find panel is already open
            // anywhere in the active pane, close it; otherwise open
            // the mode-appropriate one and focus its input.
            const activePath = activePanePath() ?? vaultStore.activeFile()?.path ?? null;
            const activeMode = editorStore.getViewModeForFile(activePath);

            // Reading mode has its own SolidJS panel in
            // ReadingView.tsx; look for its rendered DOM to tell if
            // it's currently open.
            const readingPanelOpen = !!document.querySelector(
                ".mz-reading-find-panel",
            );

            // Ctrl+F is no longer a toggle. If the panel is already
            // open and the user has selected text, REFILL the query
            // with that selection; otherwise just refocus the input.
            // Closing is still handled by the × button and Escape.
            const readingSelection = () => {
                const sel = window.getSelection?.();
                if (!sel || sel.rangeCount === 0) return "";
                // Only accept a selection that lies inside the reading
                // view — ignore selections in the sidebar or title bar,
                // and in the find panel itself (otherwise the user's
                // in-input selection would clobber its own query).
                const node = sel.anchorNode;
                if (!node) return "";
                const el = node.nodeType === Node.ELEMENT_NODE
                    ? (node as Element)
                    : node.parentElement;
                if (!el?.closest(".mz-reading-view")) return "";
                if (el?.closest(".mz-reading-find-panel")) return "";
                return sel.toString();
            };

            if (activeMode === "reading") {
                if (readingPanelOpen) {
                    // Panel already open: only refill the query if
                    // the user has something selected. With no
                    // selection we just refocus — don't clobber the
                    // existing query, since the user might be
                    // re-running the same search after scrolling.
                    const selection = readingSelection();
                    document.dispatchEvent(
                        new CustomEvent("mindzj:reading-find-set-query", {
                            detail: { query: selection },
                        }),
                    );
                } else {
                    // Fresh-open: when there's NO selection, start
                    // from an empty query (user requirement — they
                    // don't want the previous query pre-filled).
                    // With a selection, seed the query with it so
                    // the very first keystroke searches.
                    const selection = readingSelection();
                    setFindQuery(selection ?? "");
                    document.dispatchEvent(
                        new CustomEvent("mindzj:open-reading-find"),
                    );
                }
                return;
            }

            // Source / live-preview modes: drive CM6's built-in
            // search state. The panel UI is styled as a VS Code
            // floating widget via `.cm-panels-top` CSS in editor.css.
            const api = (window as any).__mindzj_plugin_editor_api;
            const cmView = api?.cm as EditorView | undefined;
            if (cmView) {
                try {
                    if (searchPanelOpen(cmView.state)) {
                        // Panel already open: if the editor has a
                        // non-empty selection, push it into the find
                        // input and re-run the search. With no
                        // selection, just refocus the input so the
                        // next keystroke edits the existing query.
                        const selectionRange = cmView.state.selection.main;
                        const selectionText = selectionRange.empty
                            ? ""
                            : cmView.state.sliceDoc(
                                selectionRange.from,
                                selectionRange.to,
                            );
                        const input =
                            cmView.dom.querySelector<HTMLInputElement>(
                                ".mz-search-panel .mz-search-input",
                            );
                        if (selectionText && input) {
                            input.value = selectionText;
                            // Trigger the panel's own `commit()` so
                            // the CM6 search state picks up the new
                            // query and the match counter refreshes.
                            input.dispatchEvent(new Event("input", { bubbles: true }));
                        }
                        queueMicrotask(() => {
                            if (input) {
                                input.focus();
                                input.select();
                            } else {
                                cmView.focus();
                            }
                        });
                    } else {
                        // Fresh-open. Determine initial query from
                        // the editor selection; fall back to an
                        // EMPTY query when nothing is selected (user
                        // requirement — Ctrl+F no longer restores
                        // the previous query on reopen).
                        const sel = cmView.state.selection.main;
                        let initialQuery = "";
                        if (!sel.empty) {
                            const text = cmView.state.sliceDoc(sel.from, sel.to);
                            if (!text.includes("\n")) {
                                initialQuery = text;
                            }
                        }
                        // Push into both the shared find store and
                        // CM6's own SearchQuery so the panel's
                        // `mount()` rehydrates from a consistent
                        // state. Replace value is also cleared
                        // alongside the query so a stale replace
                        // string doesn't ride along into the fresh
                        // session.
                        setFindQuery(initialQuery);
                        cmView.dispatch({
                            effects: setSearchQuery.of(
                                new SearchQuery({
                                    search: initialQuery,
                                    caseSensitive: findCaseSensitive(),
                                    wholeWord: findWholeWord(),
                                    regexp: findRegex(),
                                    replace: findReplaceText(),
                                }),
                            ),
                        });
                        openSearchPanel(cmView);
                        queueMicrotask(() => {
                            const input =
                                cmView.dom.querySelector<HTMLInputElement>(
                                    ".mz-search-panel .mz-search-input",
                                );
                            if (input) {
                                input.focus();
                                input.select();
                            } else {
                                cmView.focus();
                            }
                        });
                    }
                } catch (err) {
                    console.warn("[ctrl-f] toggle search panel failed:", err);
                }
            }
            return;
        }

        // Escape closes any open find panel regardless of where
        // focus currently is. Previously ESC only worked if the
        // find input itself had focus (CM6's default keybinding);
        // if the user clicked into the document and lost input
        // focus, ESC did nothing. This handler checks both the
        // reading-mode panel and CM6's search state and closes
        // whichever is open, then lets other ESC consumers run if
        // neither was.
        if (
            e.key === "Escape" &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.shiftKey &&
            !e.metaKey
        ) {
            const readingPanel = document.querySelector(
                ".mz-reading-find-panel",
            );
            if (readingPanel) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                document.dispatchEvent(
                    new CustomEvent("mindzj:close-reading-find"),
                );
                return;
            }
            const api = (window as any).__mindzj_plugin_editor_api;
            const cmView = api?.cm as EditorView | undefined;
            if (cmView && searchPanelOpen(cmView.state)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                closeSearchPanel(cmView);
                cmView.focus();
                return;
            }
        }

        if (isCtrlHeld(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "r") {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Ctrl+Shift+I / F12 → open the webview devtools.
        //
        // `devtools = true` on Tauri's Cargo features enables the
        // underlying WebView2 devtools in every build. We used to
        // SWALLOW this shortcut so users couldn't accidentally pop
        // devtools, but per user request it's now hooked up as the
        // explicit shortcut to open them. We invoke the dedicated
        // Rust command `open_devtools` instead of relying on the
        // webview's own default binding — some Tauri/WebView2
        // combinations don't expose Ctrl+Shift+I to the webview
        // layer at all, and going through the Rust handle works
        // regardless.
        //
        // Ctrl+Shift+J is ALSO mapped here (Chrome muscle memory).
        if (
            (isCtrlHeld(e) &&
                e.shiftKey &&
                !e.altKey &&
                (e.key === "I" ||
                    e.key === "J" ||
                    e.key === "i" ||
                    e.key === "j")) ||
            e.key === "F12"
        ) {
            e.preventDefault();
            e.stopPropagation();
            void invoke("open_devtools").catch((err) => {
                console.warn("[open_devtools] invoke failed:", err);
            });
            return;
        }

        // Ctrl+M → minimize the current window to the taskbar. We
        // go through the `minimize_window` Tauri command rather
        // than calling `getCurrentWindow().minimize()` in JS so
        // the minimize always happens synchronously with respect
        // to the window handle — the pure-JS path has occasionally
        // been lost when pressed while the editor DOM is busy.
        if (
            isCtrlHeld(e) &&
            !e.shiftKey &&
            !e.altKey &&
            (e.key === "m" || e.key === "M")
        ) {
            e.preventDefault();
            e.stopPropagation();
            void invoke("minimize_window").catch((err) => {
                console.warn("[minimize_window] invoke failed:", err);
            });
            return;
        }

        // Ctrl+J (no shift/alt) → toggle MindZJ window visibility
        // (show/hide from the taskbar). Browsers bind Ctrl+J to the
        // Downloads popup by default — this both intercepts that
        // behaviour AND gives the user a way to quickly hide the
        // window without reaching for the titlebar minimize button.
        // Configurable via `toggle-window-visible` hotkey.
        if (matchesHotkey(e, getHotkey("toggle-window-visible", "Ctrl+J"))) {
            e.preventDefault();
            e.stopPropagation();
            void (async () => {
                try {
                    const w = getCurrentWindow();
                    const visible = await w.isVisible();
                    const minimized = await w.isMinimized();
                    if (visible && !minimized) {
                        await w.hide();
                    } else {
                        await w.unminimize().catch(() => {});
                        await w.show();
                        await w.setFocus().catch(() => {});
                    }
                } catch (err) {
                    console.warn("[toggle-window-visible] failed:", err);
                }
            })();
            return;
        }

        // Screenshot (default Alt+G, configurable).
        // `stopImmediatePropagation` is needed because WebView2's
        // internal Alt-key "menu mode" can otherwise intercept the
        // G press and pop a search/find dialog before our handler
        // fires. The bare-Alt handler above ALSO suppresses the
        // menu-mode activation, but the double-stop here is a
        // belt-and-suspenders defence.
        if (matchesHotkey(e, getHotkey("screenshot", "Alt+G"))) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            startScreenshot();
            return;
        }

        // Plugin: timestamp-header commands (configurable hotkeys).
        //
        // Previously this path dispatched a `mindzj:plugin-command`
        // CustomEvent that the plugin itself listened for and then
        // re-ran via `app.commands.executeCommandById`. That indirection
        // was firing the command multiple times — Alt+F would insert
        // four timestamps in one press — because the plugin's DOM
        // listener stuck around across vault reloads / hot-reloads
        // and each attached copy re-ran the callback. We now call
        // `pluginStore.executeCommandById` directly. One call per
        // press, one insert per command.
        if (matchesHotkey(e, getHotkey("plugin:timestamp-header:insert-timestamp", "Alt+F"))) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            void pluginStore.executeCommandById(
                "timestamp-header:insert-custom-timestamp",
            );
            return;
        }
        if (matchesHotkey(e, getHotkey("plugin:timestamp-header:insert-separator", "Alt+A"))) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            void pluginStore.executeCommandById(
                "timestamp-header:insert-triple-asterisk",
            );
            return;
        }

        // Ctrl+G → goto-line popup (VS Code parity). Works in all
        // three view modes: source/live-preview dispatch into the
        // CM6 `goto-line` editor command, reading mode into the
        // ReadingView goto-line handler. Both already paint a ~1s
        // line flash on landing.
        if (
            isCtrlHeld(e) &&
            !e.shiftKey &&
            !e.altKey &&
            (e.key === "g" || e.key === "G")
        ) {
            e.preventDefault();
            e.stopPropagation();
            setShowGotoLine(v => !v);
            return;
        }
        // Ctrl+P → commands-only palette ("Select a command…").
        if (matchesHotkey(e, getHotkey("command-palette", "Ctrl+P"))) {
            e.preventDefault();
            e.stopPropagation();
            // If the palette is already open in the other mode, flip
            // the mode instead of toggling visibility — matches the
            // VS Code behaviour where pressing the OTHER shortcut
            // while the palette is open swaps context without a
            // close/reopen blink.
            if (showCommandPalette() && commandPaletteMode() !== "commands") {
                setCommandPaletteMode("commands");
            } else {
                setCommandPaletteMode("commands");
                setShowCommandPalette(v => !v);
            }
            return;
        }
        // Ctrl+O → "Find or create note" palette. Same widget, but
        // restricted to files and augmented with a "Create" entry
        // for queries that don't match any existing note.
        if (matchesHotkey(e, getHotkey("command-palette-alt", "Ctrl+O"))) {
            e.preventDefault();
            e.stopPropagation();
            if (showCommandPalette() && commandPaletteMode() !== "files") {
                setCommandPaletteMode("files");
            } else {
                setCommandPaletteMode("files");
                setShowCommandPalette(v => !v);
            }
            return;
        }
        // Ctrl+N → create a new markdown note. Uses the existing
        // handleNewTab() flow (same prompt, same default location).
        if (matchesHotkey(e, getHotkey("new-note", "Ctrl+N"))) {
            e.preventDefault();
            e.stopPropagation();
            void handleNewTab();
            return;
        }
        // Ctrl+Alt+Left / Ctrl+Alt+Right are intercepted at the
        // very top of this handler (see the "tab switch" block
        // above the bare-Alt guard). Not repeated here.

        // Ctrl+Shift+C → insert a fenced code block in markdown.
        // Browsers bind this to "Inspect element" in devtools — we
        // intercept + preventDefault earlier above, but we ALSO
        // dispatch the editor command so the key is useful instead
        // of dead. Reuses the existing `codeblock` editor command
        // which wraps the selection in ``` fences.
        if (matchesHotkey(e, getHotkey("code-block", "Ctrl+Shift+C"))) {
            e.preventDefault();
            e.stopPropagation();
            document.dispatchEvent(new CustomEvent("mindzj:editor-command", {
                detail: { command: "codeblock" },
            }));
            return;
        }
        // Ctrl+Alt+C / Ctrl+Alt+V are NOT intercepted here. The
        // `linkHandlerExtension` in the editor installs a CM6
        // bubble-phase keydown handler (`linkAnchorHandler`) that
        // copies the current line/selection as a `filename#anchor`
        // reference and pastes it back as a `[[filename#anchor]]`
        // wiki link. Letting the event fall through from this global
        // capture handler is exactly what allows CM6 to see it.
        if (matchesHotkey(e, getHotkey("save", "Ctrl+S"))) {
            e.preventDefault();
            e.stopPropagation();
            document.dispatchEvent(new CustomEvent("mindzj:force-save"));
            return;
        }
        // Ctrl+W: save and close the currently active tab (the one
        // visible in whichever pane has focus). We dispatch the
        // force-save event first so the editor flushes any pending
        // changes via the same `mindzj:force-save` path that Ctrl+S
        // uses, then call `handleTabClose` which removes the file
        // from `openFiles` and rebalances the panes.
        if (matchesHotkey(e, getHotkey("close-tab", "Ctrl+W"))) {
            e.preventDefault();
            e.stopPropagation();
            const path = activePanePath() ?? vaultStore.activeFile()?.path ?? null;
            if (path) {
                document.dispatchEvent(new CustomEvent("mindzj:force-save"));
                handleTabClose(path);
            }
            return;
        }
        // Ctrl+Shift+T: reopen the most recently closed tab. Mirrors
        // the Chrome/Firefox "reopen closed tab" shortcut. Moved
        // from plain Ctrl+T because Ctrl+T on its own tends to clash
        // with other editor bindings (e.g. "transpose chars") and
        // the Shift variant is what most users already have in
        // muscle memory from their browser. The closed-tabs history
        // is a bounded LIFO stack pushed by `handleTabClose`.
        // Pressing the shortcut multiple times in a row reopens tabs
        // in reverse-close order (most recent first).
        if (matchesHotkey(e, getHotkey("reopen-tab", "Ctrl+Shift+T"))) {
            e.preventDefault();
            e.stopPropagation();
            reopenLastClosedTab();
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

        // Ctrl+Shift+F: switch to sidebar search panel. If the user
        // has text selected in the active editor (or reading view),
        // pre-populate the global search with that selection and kick
        // off a search immediately — the "select text, Ctrl+Shift+F"
        // flow users expect from VS Code / Obsidian.
        if (isCtrlHeld(e) && e.shiftKey && !e.altKey && e.key === "F") {
            e.preventDefault();
            e.stopPropagation();

            // Pull the current selection. Source / live-preview route
            // through the exposed CM6 view on `__mindzj_plugin_editor_api`;
            // reading mode uses the DOM selection scoped to
            // `.mz-reading-view` (the same gate used by Ctrl+F's
            // selection grab above).
            let selectionText = "";
            try {
                const api = (window as any).__mindzj_plugin_editor_api;
                const cmView = api?.cm as EditorView | undefined;
                if (cmView && !cmView.state.selection.main.empty) {
                    const sel = cmView.state.selection.main;
                    selectionText = cmView.state.sliceDoc(sel.from, sel.to);
                }
                if (!selectionText) {
                    const domSel = window.getSelection?.();
                    if (domSel && domSel.rangeCount > 0) {
                        const anchor = domSel.anchorNode;
                        const container = anchor?.nodeType === Node.ELEMENT_NODE
                            ? (anchor as Element)
                            : anchor?.parentElement;
                        // Only accept a DOM selection inside the
                        // reading view. Selections in the sidebar or
                        // title bar aren't meaningful search queries.
                        if (
                            container?.closest(".mz-reading-view") &&
                            !container.closest(".mz-reading-find-panel")
                        ) {
                            selectionText = domSel.toString();
                        }
                    }
                }
            } catch (err) {
                console.warn("[ctrl-shift-f] selection read failed:", err);
            }

            // Collapse multi-line selections to the first non-empty
            // line — global search queries are single-line, and
            // dumping a paragraph into the input is almost never what
            // the user meant.
            if (selectionText.includes("\n")) {
                const firstLine = selectionText
                    .split("\n")
                    .map((l) => l.trim())
                    .find((l) => l.length > 0);
                selectionText = firstLine ?? "";
            }

            setSidebarTab("search");
            if (sidebarCollapsed()) setSidebarCollapsed(false);

            if (selectionText) {
                setGlobalSearchQuery(selectionText);
                // Run immediately so the user sees results without a
                // debounce delay. The panel will focus its input
                // (onMount or when SearchPanel re-mounts) and select
                // the text so "just type" replaces the selection.
                runGlobalSearchNow();
            }

            setTimeout(() => {
                const searchInput = document.querySelector(
                    ".mz-sidebar-search-input",
                ) as HTMLInputElement | null;
                if (searchInput) {
                    searchInput.focus();
                    searchInput.select();
                }
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
            background: "var(--mz-bg-primary)",
        }}>
            {/*
                Bootstrapping gate (OUTER level).

                When the app starts up with a saved vault to restore,
                we render NOTHING but a flat dark canvas covering the
                whole window until:
                  1. the vault has been opened
                  2. workspace.json has been read
                  3. all saved tabs have been loaded into openFiles
                  4. the active tab has been selected
                  5. plugin views have mounted into their hosts
                  6. CodeMirror has had a paint cycle to restore the
                     scroll position of the active editor

                Without this gate the user sees an obvious flicker:
                empty editor → tabs appear one by one → final tab +
                scroll position settle. With this gate they only see
                the dark canvas → fully-loaded UI in one transition.
            */}
            <Show
                when={!isBootstrapping()}
                fallback={
                    <div style={{
                        flex: "1",
                        background: "var(--mz-bg-primary)",
                    }} />
                }
            >
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
                                        onFileClick={(p: string) => { void openFileRouted(p); }}
                                        onOpenSplit={handleOpenSplitInPane}
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
                            padding: "4px 12px",
                            "border-top": "1px solid var(--mz-border)",
                            position: "relative",
                        }}>
                            <button
                                onClick={() => setShowVaultMenu(v => !v)}
                                // Hovering the vault name reveals the
                                // full filesystem path via the native
                                // browser tooltip. Native `title` is
                                // used over a custom hover widget so
                                // the tooltip doesn't interfere with
                                // the vault-switcher popup that opens
                                // on click.
                                title={vaultStore.vaultInfo()?.path ?? ""}
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
                        // Bootstrapping is gated at the OUTER level (right
                        // after the root <div> opens), so by the time we
                        // hit this fallback we already know we want to
                        // show the welcome screen — no inner gate needed.
                        <>
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
                        </>
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
                                    onRevealInTree={(path: string) => {
                                        // Ensure the Files panel is showing and the
                                        // sidebar is expanded before revealFileInTree
                                        // scrolls — the tree DOM only exists when
                                        // `sidebarTab === "files"` and the sidebar
                                        // isn't collapsed.
                                        setSidebarTab("files");
                                        if (sidebarCollapsed()) setSidebarCollapsed(false);
                                        revealFileInTree(path);
                                    }}
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
            </Show>
            <Show when={showCommandPalette()}>
                <CommandPalette
                    mode={commandPaletteMode()}
                    onClose={() => setShowCommandPalette(false)}
                />
            </Show>
            <Show when={showGotoLine()}>
                <GotoLinePanel onClose={() => setShowGotoLine(false)} />
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
            {/* Ephemeral shortcut toast — auto-fades after ~1.2s. Used
                primarily by the Ctrl+Alt+Left/Right tab switch handler
                so the user can verify the keyboard event actually
                reached our code even if the tab switching itself looks
                like a no-op (e.g. only one tab open). Rendered OUTSIDE
                the normal layout tree so it can sit top-center over
                everything. */}
            <Show when={shortcutToast()}>
                <div
                    style={{
                        position: "fixed",
                        top: "48px",
                        left: "50%",
                        transform: "translateX(-50%)",
                        padding: "6px 14px",
                        background: "var(--mz-bg-secondary, rgba(30, 30, 30, 0.92))",
                        color: "var(--mz-text-primary, #ffffff)",
                        border: "1px solid var(--mz-border, rgba(255, 255, 255, 0.15))",
                        "border-radius": "6px",
                        "font-family": "var(--mz-font-mono, monospace)",
                        "font-size": "12px",
                        "pointer-events": "none",
                        "z-index": "100000",
                        "box-shadow": "0 4px 12px rgba(0, 0, 0, 0.35)",
                        "white-space": "nowrap",
                    }}
                >
                    {shortcutToast()}
                </div>
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
    const previewKind = createMemo<"image" | "document" | null>(() => {
        if (file()?.kind === "image") return "image";
        if (file()?.kind === "document") return "document";
        return null;
    });

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
                    when={previewKind()}
                    fallback={
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
                    }
                >
                    <FilePreview
                        filePath={props.filePath}
                        kind={previewKind()!}
                        active={props.active}
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
