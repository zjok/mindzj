import { Component, Show, For, createSignal, createEffect, createMemo, on, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { vaultStore, type FileContent } from "./stores/vault";
import { editorStore, type ViewMode } from "./stores/editor";
import { settingsStore, type AiProviderConfig } from "./stores/settings";
import { BUILT_IN_ONLINE_PROVIDER_TYPES, aiProviderModelLabel, aiStore, defaultAiProviderConfig } from "./stores/ai";
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
    cancelInFlightSearch as cancelGlobalSearch,
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
import { Copy, History, Mic, MicOff, Trash2, Volume2, X } from "lucide-solid";
import { ScreenshotOverlay } from "./components/screenshot/ScreenshotOverlay";
import { promptDialog } from "./components/common/ConfirmDialog";
import { openFileRouted } from "./utils/openFileRouted";
import {
    openSearchPanel,
    closeSearchPanel,
    getSearchQuery,
    searchPanelOpen,
    setSearchQuery,
    SearchQuery,
} from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { t } from "./i18n";
import {
    setFindQuery,
} from "./stores/findState";

type SidebarTab = "files" | "outline" | "search" | "calendar";
type SplitDirection = "left" | "right" | "up" | "down";
type PaneSlot = "primary" | "secondary";
type AiPanelModelOption = {
    value: string;
    label: string;
    config: AiProviderConfig;
};
type AiQuestionHistoryEntry = {
    id: string;
    text: string;
    createdAt: string;
};
type AiHistoryDirection = "prev" | "next";
type Point = {
    x: number;
    y: number;
};

const AI_QUESTION_HISTORY_LIMIT = 500;
const AI_PANEL_MIN_HEIGHT = 220;
const AI_PANEL_DEFAULT_HEIGHT = 300;

function normalizeVaultPath(path: string | null | undefined): string {
    if (!path) return "";
    return path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
}

function aiQuestionHistoryStorageKey(vaultPath: string | null | undefined): string {
    return `mindzj-ai-question-history:${normalizeVaultPath(vaultPath) || "no-vault"}`;
}

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

function aiHistoryDateKey(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value.slice(0, 10);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatAiHistoryDate(value: string): string {
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
}

function formatAiHistoryTimestamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function mergeAudioSamples(chunks: Float32Array[]): Float32Array {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

function resampleAudio(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate || samples.length === 0) return samples;
    const nextLength = Math.max(1, Math.round(samples.length * toRate / fromRate));
    const result = new Float32Array(nextLength);
    const ratio = (samples.length - 1) / Math.max(1, nextLength - 1);
    for (let i = 0; i < nextLength; i += 1) {
        const position = i * ratio;
        const left = Math.floor(position);
        const right = Math.min(samples.length - 1, left + 1);
        const weight = position - left;
        result[i] = samples[left] * (1 - weight) + samples[right] * weight;
    }
    return result;
}

function writeAscii(view: DataView, offset: number, value: string) {
    for (let i = 0; i < value.length; i += 1) {
        view.setUint8(offset + i, value.charCodeAt(i));
    }
}

function encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
    const supportedRates = new Set([8000, 16000, 22050, 24000, 44100, 48000]);
    const targetRate = supportedRates.has(Math.round(sampleRate)) ? Math.round(sampleRate) : 48000;
    const samples = resampleAudio(mergeAudioSamples(chunks), Math.round(sampleRate), targetRate);
    const bytesPerSample = 2;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + samples.length * bytesPerSample, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, samples.length * bytesPerSample, true);

    let offset = 44;
    for (const sample of samples) {
        const clamped = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += bytesPerSample;
    }
    return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function aiAudioFileTimestamp(): string {
    const now = new Date();
    return [
        now.getFullYear(),
        pad2(now.getMonth() + 1),
        pad2(now.getDate()),
        "_",
        pad2(now.getHours()),
        pad2(now.getMinutes()),
        pad2(now.getSeconds()),
    ].join("");
}

function parseAiQuestionHistory(raw: string | null): AiQuestionHistoryEntry[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((entry, index): AiQuestionHistoryEntry | null => {
                const text = String(entry?.text ?? "").trim();
                const createdAt = String(entry?.createdAt ?? "");
                if (!text || !createdAt) return null;
                return {
                    id: String(entry?.id ?? `${createdAt}-${index}`),
                    text,
                    createdAt,
                };
            })
            .filter((entry): entry is AiQuestionHistoryEntry => !!entry)
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            .slice(-AI_QUESTION_HISTORY_LIMIT);
    } catch {
        return [];
    }
}

function aiPanelModelOptionValue(config: AiProviderConfig): string {
    if (config.id) return `custom:${config.id}`;
    return config.provider_type;
}

function aiPanelModelOptionLabel(config: AiProviderConfig): string {
    return aiProviderModelLabel(config);
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
    const [showAiPanel, setShowAiPanel] = createSignal(false);
    const [aiPanelInput, setAiPanelInput] = createSignal("");
    const [aiPanelOutput, setAiPanelOutput] = createSignal("");
    const [aiPanelBusy, setAiPanelBusy] = createSignal(false);
    const [aiVoiceRecording, setAiVoiceRecording] = createSignal(false);
    const [aiVoiceBusy, setAiVoiceBusy] = createSignal(false);
    const [showAiHistory, setShowAiHistory] = createSignal(false);
    const [aiQuestionHistory, setAiQuestionHistory] = createSignal<AiQuestionHistoryEntry[]>([]);
    const [aiHistoryDate, setAiHistoryDate] = createSignal("");
    const [aiHistoryCursor, setAiHistoryCursor] = createSignal<number | null>(null);
    const [aiPanelHeight, setAiPanelHeight] = createSignal(AI_PANEL_DEFAULT_HEIGHT);
    const [aiHistoryPosition, setAiHistoryPosition] = createSignal<Point>({ x: 0, y: 0 });
    const [aiHistoryPositionReady, setAiHistoryPositionReady] = createSignal(false);
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
    const [splitRatio, setSplitRatio] = createSignal(0.5);
    const startupParams = new URLSearchParams(window.location.search);
    const startupVaultPath = startupParams.get("vault_path");
    const startupVaultName = startupParams.get("vault_name");
    const startupFilePath = startupParams.get("file_path");
    const startupViewMode = startupParams.get("view_mode");
    const startupUiZoomParam = startupParams.get("ui_zoom");
    const startupUiZoom = startupUiZoomParam ? Number(startupUiZoomParam) : null;
    const [startupPayloadApplied, setStartupPayloadApplied] = createSignal(false);
    const isTransientWindow = () => startupParams.get("split") === "1";
    let aiVoiceStream: MediaStream | null = null;
    let aiVoiceAudioContext: AudioContext | null = null;
    let aiVoiceSource: MediaStreamAudioSourceNode | null = null;
    let aiVoiceProcessor: ScriptProcessorNode | null = null;
    let aiVoiceSamples: Float32Array[] = [];
    let aiVoiceSampleRate = 48000;

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
    let workspaceRestoreInProgress = false;

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
    const currentAiModelLabel = createMemo(() => aiStore.currentModelLabel());
    const aiPanelModelOptions = createMemo<AiPanelModelOption[]>(() => {
        const settings = settingsStore.settings();
        const options: AiPanelModelOption[] = [];
        const seen = new Set<string>();
        const addOption = (config: AiProviderConfig | null | undefined) => {
            if (!config?.model?.trim()) return;
            const value = aiPanelModelOptionValue(config);
            if (seen.has(value)) return;
            seen.add(value);
            options.push({
                value,
                label: aiPanelModelOptionLabel(config),
                config,
            });
        };

        addOption(settings.ai_provider);
        addOption(defaultAiProviderConfig("LMStudio"));
        addOption(defaultAiProviderConfig("Ollama"));
        for (const provider of BUILT_IN_ONLINE_PROVIDER_TYPES) {
            addOption(defaultAiProviderConfig(provider));
        }
        for (const config of settings.ai_custom_providers ?? []) {
            addOption(config);
        }

        return options;
    });
    const currentAiModelOptionValue = createMemo(() => {
        const config = settingsStore.settings().ai_provider ?? defaultAiProviderConfig("Ollama");
        return aiPanelModelOptionValue(config);
    });
    const aiQuestionHistoryKey = createMemo(() => aiQuestionHistoryStorageKey(vaultStore.vaultInfo()?.path));
    const aiHistoryDates = createMemo(() => {
        const dates = new Set<string>();
        for (const entry of aiQuestionHistory()) {
            const key = aiHistoryDateKey(entry.createdAt);
            if (key) dates.add(key);
        }
        return Array.from(dates).sort().reverse();
    });
    const selectedAiHistoryEntries = createMemo(() => {
        const date = aiHistoryDate();
        return aiQuestionHistory()
            .filter((entry) => aiHistoryDateKey(entry.createdAt) === date)
            .slice()
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    });
    const splitPaneActive = createMemo(() => secondaryPanePath() !== null);

    createEffect(on(aiQuestionHistoryKey, (key) => {
        let entries: AiQuestionHistoryEntry[] = [];
        try {
            entries = parseAiQuestionHistory(localStorage.getItem(key));
        } catch {
            entries = [];
        }
        setAiQuestionHistory(entries);
        setAiHistoryCursor(null);
        const dates = Array.from(new Set(entries.map((entry) => aiHistoryDateKey(entry.createdAt)).filter(Boolean))).sort().reverse();
        setAiHistoryDate(dates[0] ?? "");
    }));

    createEffect(() => {
        const dates = aiHistoryDates();
        const current = aiHistoryDate();
        if (!dates.length) {
            if (current) setAiHistoryDate("");
            return;
        }
        if (!current || !dates.includes(current)) {
            setAiHistoryDate(dates[0]);
        }
    });

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
            primary_pane_path: primaryPanePath(),
            secondary_pane_path: secondaryPanePath(),
            active_pane_slot: activePaneSlot(),
            split_direction: splitDirection(),
            split_ratio: splitRatio(),
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

    function isSplitDirection(value: unknown): value is SplitDirection {
        return value === "left" || value === "right" || value === "up" || value === "down";
    }

    function isPaneSlot(value: unknown): value is PaneSlot {
        return value === "primary" || value === "secondary";
    }

    function normalizeSplitRatio(value: unknown): number {
        return typeof value === "number" && Number.isFinite(value)
            ? Math.max(0.2, Math.min(0.8, value))
            : 0.5;
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

    async function handleSidebarFileClick(path: string) {
        document.dispatchEvent(new CustomEvent("mindzj:remember-active-viewport"));
        const targetSlot = activePaneSlot();
        await openFileRouted(path);
        const file = findOpenFile(path);
        if (!file) return;
        setPanePath(targetSlot, path);
        setActivePaneSlot(targetSlot);
        vaultStore.setActiveFile(file);
        if (!primaryPanePath()) {
            setPrimaryPanePath(path);
        }
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
        // Cooperatively cancel any in-flight sidebar global search
        // BEFORE we start the split. Spinning up a new Editor
        // (secondary pane) while the search loop is still hammering
        // `invoke("read_file")` in 16-wide batches used to freeze
        // the app — the main thread has to share time between CM6
        // init + decoration building on one side and N more file-
        // read promises on the other, and both contended for IPC.
        // The sidebar search can easily be re-run later once the
        // split has settled; interrupting it here is the cheapest
        // way to guarantee the split open stays snappy.
        cancelGlobalSearch();
        // ═══════════════════════════════════════════════════════════
        //  Unified Split-into-pane routine
        // ═══════════════════════════════════════════════════════════
        //
        // Deterministic end-state placement — the old implementation
        // dispatched state in several phases and then tried to "un-do"
        // the side effects that `openFileRouted` triggered through the
        // `activeFile → active pane path` createEffect. That race
        // re-entered the pane signals rapidly and, when applied to an
        // already-split layout, caused the CM6 editor in one of the
        // panes to destroy/recreate multiple times in the same
        // microtask batch — which looked like a hard freeze on screens
        // the user had already split once.
        //
        // The rewrite computes the FINAL (primary, secondary, slot,
        // direction) tuple up front and then does a single deterministic
        // write of each signal. The behaviour matches the rules the
        // user spelled out:
        //
        //   1. No existing split → open a fresh split per `direction`.
        //   2. Already split on the SAME axis as `direction` → just
        //      replace the slot the direction points at with `path`,
        //      without touching the other pane or flipping the layout.
        //   3. Already split on the OPPOSITE axis → rebuild the split
        //      in the new direction, keeping the focused pane's file
        //      on one side and `path` on the other.
        //
        // Plugin-backed files (`.mindzj` etc.) also take this path:
        // `mountPluginView` generates a unique mount handle per call,
        // so the same file can sit in primary and secondary at once.

        // Snapshot EVERYTHING we need BEFORE any await so the values
        // can't be mutated out from under us by the active-file
        // createEffect while openFileRouted yields.
        //
        // `previousPrimary` / `previousSecondary` are what each pane
        // was showing BEFORE `openFileRouted(path)` ran — we need them
        // because that call does `setActiveFile(path)`, which the
        // `on(vaultStore.activeFile, …)` effect below will react to
        // by writing the new path into whichever slot is currently
        // active. Without these snapshots Case 2's "just replace one
        // pane" would accidentally restore the active pane from the
        // CLOBBERED value, and the other pane would flicker.
        const previousActivePath =
            activePanePath() ?? vaultStore.activeFile()?.path ?? null;
        const previousPrimary = primaryPanePath();
        const previousSecondary = secondaryPanePath();
        const wasSplit = splitPaneActive();
        const currentDirection = splitDirection();

        if (!findOpenFile(path)) {
            await openFileRouted(path);
            if (!findOpenFile(path)) return;
        }

        // With no previous active path this is the very first tab the
        // user is opening — just drop it into primary, no split.
        if (!previousActivePath) {
            setPrimaryPanePath(path);
            setSecondaryPanePath(null);
            activatePane("primary");
            return;
        }

        const isHorizontal = (d: SplitDirection) =>
            d === "left" || d === "right";
        const newAxisHorizontal = isHorizontal(direction);
        const oldAxisHorizontal = isHorizontal(currentDirection);

        // ── Case 1: no existing split yet ────────────────────────────
        if (!wasSplit) {
            setSplitDirection(direction);
            if (direction === "left" || direction === "up") {
                // `path` becomes the primary (left/top); previously
                // active file slides into the secondary slot.
                setSecondaryPanePath(previousActivePath);
                setPrimaryPanePath(path);
                activatePane("primary");
            } else {
                // right/down: `path` becomes secondary.
                setPrimaryPanePath(previousActivePath);
                setSecondaryPanePath(path);
                activatePane("secondary");
            }
            return;
        }

        // ── Case 2: already split on the same axis ───────────────────
        // User just wants to REPLACE one of the two visible panes.
        // "right" / "down" → secondary; "left" / "up" → primary.
        // Direction itself stays unchanged (we keep the current axis).
        //
        // We explicitly write BOTH pane paths (even the one we don't
        // mean to change) so the earlier `activeFile` createEffect's
        // clobber of the active slot gets undone.
        if (newAxisHorizontal === oldAxisHorizontal) {
            if (direction === "right" || direction === "down") {
                setPrimaryPanePath(previousPrimary);
                setSecondaryPanePath(path);
                activatePane("secondary");
            } else {
                setSecondaryPanePath(previousSecondary);
                setPrimaryPanePath(path);
                activatePane("primary");
            }
            return;
        }

        // ── Case 3: already split on the OPPOSITE axis ───────────────
        // Rebuild the split in the new direction. The focused pane's
        // file stays, the OTHER pane's file is dropped from the layout
        // (still open in the tab strip, just no longer assigned to a
        // pane). The new file (`path`) takes the slot dictated by
        // `direction`.
        setSplitDirection(direction);
        if (direction === "left" || direction === "up") {
            setPrimaryPanePath(path);
            setSecondaryPanePath(previousActivePath);
            activatePane("primary");
        } else {
            setPrimaryPanePath(previousActivePath);
            setSecondaryPanePath(path);
            activatePane("secondary");
        }
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
        document.addEventListener("keyup", handleGlobalKeyup, true);
        onCleanup(() => {
            window.removeEventListener("keydown", handleTabSwitchKeydown, true);
            document.removeEventListener("keydown", handleGlobalKeydown, true);
            document.removeEventListener("keyup", handleGlobalKeyup, true);
        });

        // Disable the native browser/webview context menu globally so that
        // items like Refresh, Save as, Print, Insert never appear.
        // Individual components (e.g. editor images, plugin views) install
        // their own contextmenu handlers that call stopPropagation, so
        // those custom menus still work.
        const suppressNativeContextMenu = (e: MouseEvent) => {
            e.preventDefault();
        };
        document.addEventListener("contextmenu", suppressNativeContextMenu, true);
        onCleanup(() => document.removeEventListener("contextmenu", suppressNativeContextMenu, true));
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

        const handleToggleAiPanel = () => {
            setShowAiPanel((value) => !value);
        };
        document.addEventListener("mindzj:toggle-ai-panel", handleToggleAiPanel);
        onCleanup(() => document.removeEventListener("mindzj:toggle-ai-panel", handleToggleAiPanel));

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
            workspaceRestoreInProgress = true;
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
                const openPaths = new Set(vaultStore.openFiles().map((file) => file.path));
                const restoredPrimary =
                    ws.primary_pane_path && openPaths.has(ws.primary_pane_path)
                        ? ws.primary_pane_path
                        : ws.active_file && openPaths.has(ws.active_file)
                            ? ws.active_file
                            : vaultStore.openFiles()[0]?.path ?? null;
                const restoredSecondary =
                    ws.secondary_pane_path && openPaths.has(ws.secondary_pane_path)
                        ? ws.secondary_pane_path
                        : null;

                setPrimaryPanePath(restoredPrimary);
                setSecondaryPanePath(restoredSecondary);
                if (isSplitDirection(ws.split_direction)) {
                    setSplitDirection(ws.split_direction);
                }
                setSplitRatio(normalizeSplitRatio(ws.split_ratio));

                const restoredActiveSlot =
                    isPaneSlot(ws.active_pane_slot) &&
                    (ws.active_pane_slot !== "secondary" || restoredSecondary)
                        ? ws.active_pane_slot
                        : "primary";
                setActivePaneSlot(restoredActiveSlot);

                const activePath = restoredActiveSlot === "secondary"
                    ? restoredSecondary
                    : restoredPrimary;
                if (activePath) {
                    try { vaultStore.switchToFile(activePath); } catch { /* skip */ }
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
                    workspaceRestoreInProgress = false;
                    setIsBootstrapping(false);
                });
            });
        } else {
            workspaceRestoreInProgress = false;
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
        if (!info || isTransientWindow() || workspaceRestoreInProgress) return;
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

    function isArrowKeyEvent(e: KeyboardEvent): boolean {
        const keyCode = e.keyCode || e.which;
        return (
            e.code === "ArrowUp" ||
            e.code === "ArrowDown" ||
            e.code === "ArrowLeft" ||
            e.code === "ArrowRight" ||
            e.key === "ArrowUp" ||
            e.key === "ArrowDown" ||
            e.key === "ArrowLeft" ||
            e.key === "ArrowRight" ||
            e.key === "Up" ||
            e.key === "Down" ||
            e.key === "Left" ||
            e.key === "Right" ||
            keyCode === 38 ||
            keyCode === 40 ||
            keyCode === 37 ||
            keyCode === 39
        );
    }

    function suppressWebViewAltMenu(e: KeyboardEvent): boolean {
        if (e.key === "Alt") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return true;
        }
        const isPlainAltArrow =
            e.altKey &&
            isArrowKeyEvent(e) &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.shiftKey;
        if (isPlainAltArrow) {
            const isHorizontalArrow =
                e.code === "ArrowLeft" ||
                e.code === "ArrowRight" ||
                e.key === "ArrowLeft" ||
                e.key === "ArrowRight" ||
                e.key === "Left" ||
                e.key === "Right" ||
                (e.keyCode || e.which) === 37 ||
                (e.keyCode || e.which) === 39;
            if (isHorizontalArrow && document.activeElement?.closest(".cm-editor")) {
                return false;
            }
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return true;
        }
        return false;
    }

    function handleGlobalKeyup(e: KeyboardEvent) {
        if (e.key !== "Alt") return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    /** Get the effective hotkey combo for a command (override or default) */
    function getHotkey(command: string, defaultKeys: string): string {
        const overrides = settingsStore.settings().hotkey_overrides || {};
        return overrides[command] || defaultKeys;
    }

    // Reentrancy guard for Ctrl+E. OS key-repeat and rapid pressing during
    // async save operations used to stack multiple toggle dispatches,
    // which in split mode combined with the sidebar global-search
    // re-search listener could hang the UI thread in a cascade of file
    // reads + mode-rebuilds. One-in-flight at a time keeps the sequence
    // sane even if the user mashes the key.
    let toggleViewModePending = false;
    function toggleViewModeWithSave(path: string | null | undefined) {
        if (toggleViewModePending) return;
        toggleViewModePending = true;
        const release = () => {
            toggleViewModePending = false;
        };
        try {
            const resolvedPath = path ?? null;
            const currentMode = editorStore.getViewModeForFile(resolvedPath);
            if (currentMode === "reading") {
                editorStore.toggleReadingMode(resolvedPath ?? undefined);
                queueMicrotask(release);
                return;
            }

            const event = new CustomEvent("mindzj:toggle-view-mode-with-save", {
                cancelable: true,
                detail: { path: resolvedPath, release },
            });
            const handled = !document.dispatchEvent(event);
            if (!handled) {
                editorStore.toggleReadingMode(resolvedPath ?? undefined);
                queueMicrotask(release);
            }
            // If handled, the Editor's async save promise will call
            // release() when it settles (success or failure). Fallback
            // timeout guards against a handler that never calls back.
            if (handled) {
                setTimeout(() => {
                    if (toggleViewModePending) toggleViewModePending = false;
                }, 3000);
            }
        } catch (err) {
            toggleViewModePending = false;
            throw err;
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

    // Resolve the CodeMirror EditorView that belongs to whichever pane
    // the user currently considers "focused". In single-pane mode this
    // is just the lone editor; in split mode the choice matters — the
    // Ctrl+F handler needs to open the search widget in the pane the
    // user is actually looking at, not the stale
    // `__mindzj_plugin_editor_api` global which only updates when an
    // editor mounts/unmounts.
    function findActivePaneEditorView(paneWrap?: HTMLElement | null): EditorView | undefined {
        // 1. Whatever has document focus, if it's inside a cm-editor,
        //    is the most reliable signal.
        const focusedInEditor = document.activeElement?.closest<HTMLElement>(".cm-editor");
        if (focusedInEditor) {
            const v = EditorView.findFromDOM(focusedInEditor);
            if (v) return v;
        }
        // 2. The active pane's wrapper → its cm-editor descendant.
        //    Handles e.g. Ctrl+F pressed while focus sits in the
        //    sidebar search input.
        const wrap = paneWrap ?? (() => {
            const slot = activePaneSlot();
            return document.querySelector<HTMLElement>(
                slot === "secondary"
                    ? ".mz-pane-wrap-secondary"
                    : ".mz-pane-wrap-primary",
            );
        })();
        const cmEditor = wrap?.querySelector<HTMLElement>(".cm-editor");
        if (cmEditor) {
            const v = EditorView.findFromDOM(cmEditor);
            if (v) return v;
        }
        // 3. Legacy fallback — only correct in the single-pane case,
        //    but harmless when 1) and 2) failed to resolve anything.
        const api = (window as any).__mindzj_plugin_editor_api;
        return (api?.cm as EditorView | undefined) ?? undefined;
    }

    function clearEditorSearchQuery(view: EditorView) {
        const current = getSearchQuery(view.state);
        view.dispatch({
            effects: setSearchQuery.of(
                new SearchQuery({
                    search: "",
                    caseSensitive: current.caseSensitive,
                    wholeWord: current.wholeWord,
                    regexp: current.regexp,
                    replace: "",
                }),
            ),
        });
    }

    function saveAiQuestionHistory(next: AiQuestionHistoryEntry[]) {
        const trimmed = next.slice(-AI_QUESTION_HISTORY_LIMIT);
        setAiQuestionHistory(trimmed);
        setAiHistoryCursor(null);
        try {
            localStorage.setItem(aiQuestionHistoryKey(), JSON.stringify(trimmed));
        } catch {
            // History is a convenience feature; storage failures should not block AI runs.
        }
    }

    function recordAiQuestion(text: string) {
        const trimmed = text.trim();
        if (!trimmed) return;
        const createdAt = new Date().toISOString();
        const entry: AiQuestionHistoryEntry = {
            id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
            text: trimmed,
            createdAt,
        };
        saveAiQuestionHistory([...aiQuestionHistory(), entry]);
        setAiHistoryDate(aiHistoryDateKey(createdAt));
    }

    function deleteAiHistoryEntry(id: string) {
        saveAiQuestionHistory(aiQuestionHistory().filter((entry) => entry.id !== id));
    }

    function clearAiHistoryForSelectedDate() {
        const date = aiHistoryDate();
        if (!date) return;
        saveAiQuestionHistory(aiQuestionHistory().filter((entry) => aiHistoryDateKey(entry.createdAt) !== date));
    }

    function clearAllAiHistory() {
        saveAiQuestionHistory([]);
    }

    function handleAiPanelInput(value: string) {
        setAiHistoryCursor(null);
        setAiPanelInput(value);
    }

    function navigateAiQuestionHistory(direction: AiHistoryDirection) {
        const history = aiQuestionHistory();
        if (!history.length || aiPanelBusy()) return;
        const current = aiHistoryCursor();
        if (direction === "prev") {
            const nextIndex = current === null ? history.length - 1 : Math.max(0, current - 1);
            setAiHistoryCursor(nextIndex);
            setAiPanelInput(history[nextIndex].text);
            return;
        }

        if (current === null) return;
        if (current >= history.length - 1) {
            setAiHistoryCursor(null);
            setAiPanelInput("");
            return;
        }
        const nextIndex = current + 1;
        setAiHistoryCursor(nextIndex);
        setAiPanelInput(history[nextIndex].text);
    }

    function copyAiHistoryQuestion(text: string) {
        void navigator.clipboard?.writeText(text).catch(() => {});
    }

    function pushAiPanelStatus(message: string) {
        const stamp = new Date().toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        setAiPanelOutput((current) => {
            const line = `[${stamp}] ${message}`;
            return current ? `${current}\n${line}` : line;
        });
    }

    function disposeAiVoiceCapture() {
        aiVoiceProcessor?.disconnect();
        aiVoiceSource?.disconnect();
        aiVoiceStream?.getTracks().forEach((track) => track.stop());
        void aiVoiceAudioContext?.close().catch(() => {});
        aiVoiceProcessor = null;
        aiVoiceSource = null;
        aiVoiceStream = null;
        aiVoiceAudioContext = null;
    }

    async function startAiVoiceRecording() {
        if (aiVoiceBusy() || aiVoiceRecording()) return;
        const mediaDevices = navigator.mediaDevices;
        if (!mediaDevices?.getUserMedia) {
            pushAiPanelStatus(t("aiPanel.voiceUnsupported"));
            return;
        }
        try {
            const stream = await mediaDevices.getUserMedia({ audio: true });
            aiVoiceStream = stream;
            const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioContextCtor) throw new Error(t("aiPanel.voiceUnsupported"));
            const audioContext = new AudioContextCtor({ sampleRate: 48000 });
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            aiVoiceSamples = [];
            aiVoiceSampleRate = audioContext.sampleRate || 48000;
            processor.onaudioprocess = (event) => {
                if (!aiVoiceRecording()) return;
                const input = event.inputBuffer.getChannelData(0);
                aiVoiceSamples.push(new Float32Array(input));
            };
            source.connect(processor);
            processor.connect(audioContext.destination);
            aiVoiceAudioContext = audioContext;
            aiVoiceSource = source;
            aiVoiceProcessor = processor;
            setAiVoiceRecording(true);
            pushAiPanelStatus(t("aiPanel.voiceRecording"));
        } catch (err: any) {
            disposeAiVoiceCapture();
            setAiVoiceRecording(false);
            pushAiPanelStatus(err?.message || String(err));
        }
    }

    async function stopAiVoiceRecording() {
        if (!aiVoiceRecording()) return;
        const chunks = aiVoiceSamples.slice();
        const sampleRate = aiVoiceSampleRate;
        setAiVoiceRecording(false);
        disposeAiVoiceCapture();
        if (!chunks.length) {
            pushAiPanelStatus(t("aiPanel.voiceEmpty"));
            return;
        }
        setAiVoiceBusy(true);
        pushAiPanelStatus(t("aiPanel.voiceTranscribing"));
        try {
            const wavBuffer = encodeWav(chunks, sampleRate);
            const text = await aiStore.transcribeGrokAudio(
                arrayBufferToBase64(wavBuffer),
                `mindzj_recording_${aiAudioFileTimestamp()}.wav`,
                "audio/wav",
            );
            if (!text) {
                pushAiPanelStatus(t("aiPanel.voiceEmpty"));
                return;
            }
            setAiHistoryCursor(null);
            setAiPanelInput((current) => {
                const prefix = current.trim() ? `${current}${current.endsWith("\n") ? "" : "\n"}` : "";
                return `${prefix}${text}`;
            });
            pushAiPanelStatus(t("aiPanel.voiceInserted"));
        } catch (err: any) {
            pushAiPanelStatus(err?.message || String(err));
        } finally {
            setAiVoiceBusy(false);
        }
    }

    function toggleAiVoiceRecording() {
        if (aiVoiceRecording()) {
            void stopAiVoiceRecording();
            return;
        }
        void startAiVoiceRecording();
    }

    async function synthesizeAiPanelInput() {
        const text = aiPanelInput().trim();
        if (!text || aiPanelBusy() || aiVoiceBusy() || aiVoiceRecording()) return;
        setAiVoiceBusy(true);
        pushAiPanelStatus(t("aiPanel.ttsWorking"));
        try {
            const result = await aiStore.synthesizeGrokSpeech(text);
            pushAiPanelStatus(t("aiPanel.ttsExported", { path: result.path }));
        } catch (err: any) {
            pushAiPanelStatus(err?.message || String(err));
        } finally {
            setAiVoiceBusy(false);
        }
    }

    onCleanup(() => disposeAiVoiceCapture());

    function clampAiPanelHeight(value: number): number {
        const max = Math.max(AI_PANEL_MIN_HEIGHT, Math.min(Math.floor(window.innerHeight * 0.72), window.innerHeight - 96));
        return Math.max(AI_PANEL_MIN_HEIGHT, Math.min(max, Math.round(value)));
    }

    function centerAiHistoryDialog(): Point {
        const width = Math.min(520, Math.max(320, window.innerWidth - 32));
        const height = Math.min(420, Math.max(280, window.innerHeight - 48));
        return {
            x: Math.max(12, Math.round((window.innerWidth - width) / 2)),
            y: Math.max(12, Math.round((window.innerHeight - height) / 2)),
        };
    }

    function toggleAiHistoryDialog() {
        const next = !showAiHistory();
        if (next && !aiHistoryPositionReady()) {
            setAiHistoryPosition(centerAiHistoryDialog());
            setAiHistoryPositionReady(true);
        }
        setShowAiHistory(next);
    }

    function closeAiHistoryDialog() {
        setShowAiHistory(false);
    }

    function closeAiPanel() {
        setShowAiPanel(false);
        setShowAiHistory(false);
    }

    async function runAiPanelInstruction() {
        const instruction = aiPanelInput().trim();
        if (!instruction || aiPanelBusy()) return;
        recordAiQuestion(instruction);
        setAiPanelBusy(true);
        const progressLines: string[] = [];
        let lastProgressMessage = "";
        const pushProgress = (phase: string, message: string) => {
            lastProgressMessage = message;
            const stamp = new Date().toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
            const labels: Record<string, string> = {
                request: "请求",
                "tool-call": "工具",
                "tool-result": "结果",
                message: "消息",
                done: "完成",
                error: "错误",
            };
            progressLines.push(`[${stamp}] ${labels[phase] ?? phase}: ${message}`);
            setAiPanelOutput(progressLines.join("\n"));
        };
        pushProgress("message", t("aiPanel.working"));
        try {
            const result = await aiStore.runInstruction(instruction, {
                restrictToActiveFile: true,
                onProgress: (event) => pushProgress(event.phase, event.message),
            });
            const finalText = result || t("aiPanel.done");
            if (finalText && finalText !== lastProgressMessage) {
                setAiPanelOutput([...progressLines, "", finalText].join("\n"));
            }
            setAiPanelInput("");
            setAiHistoryCursor(null);
        } catch (err: any) {
            pushProgress("error", err?.message || String(err));
        } finally {
            setAiPanelBusy(false);
        }
    }

    function selectAiPanelModel(value: string) {
        const option = aiPanelModelOptions().find((item) => item.value === value);
        if (!option) return;
        void settingsStore.updateSetting("ai_provider", { ...option.config });
    }

    function handleGlobalKeydown(e: KeyboardEvent) {
        // If the settings hotkey capture is active, let the HotkeysPanel handle the event.
        if ((window as any).__mindzj_hotkey_capturing) return;

        if (showAiHistory() && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            closeAiHistoryDialog();
            return;
        }

        const moveLineCommand = matchesHotkey(e, getHotkey("move-line-up", "Alt+Up"))
            ? "move-line-up"
            : matchesHotkey(e, getHotkey("move-line-down", "Alt+Down"))
                ? "move-line-down"
                : null;
        const focusedEditorContent = document.activeElement?.closest(".cm-content");
        if (moveLineCommand && focusedEditorContent?.closest(".cm-editor")) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            document.dispatchEvent(new CustomEvent("mindzj:editor-command", {
                detail: { command: moveLineCommand },
            }));
            return;
        }

        const aiInputFocused = (document.activeElement as HTMLElement | null)?.dataset?.mzAiInput === "true";
        if (aiInputFocused && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            navigateAiQuestionHistory(e.key === "ArrowUp" ? "prev" : "next");
            return;
        }

        if (suppressWebViewAltMenu(e)) return;
        if (e.defaultPrevented) return;
        if (handleTabSwitchKeydown(e)) return;

        // Bare Alt and non-editor Alt+Arrow are suppressed above so WebView2
        // never enters its native menu mode after repeated Alt presses.

        if (matchesHotkey(e, getHotkey("ai-control", "Alt+`"))) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            setShowAiPanel((value) => !value);
            return;
        }

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

            // Find the DOM element that wraps ONLY the active pane's
            // content. In split mode this is either
            // `.mz-pane-wrap-secondary` or `.mz-pane-wrap-primary`
            // depending on which pane the user last focused; outside
            // split mode there's only the primary wrap. Scoping all
            // the "is the panel already open?" + "which CM view do we
            // target?" queries to THIS element is what makes Ctrl+F
            // only act on the focused pane.
            const activePaneWrap: HTMLElement | null = (() => {
                const slot = activePaneSlot();
                const selector = slot === "secondary"
                    ? ".mz-pane-wrap-secondary"
                    : ".mz-pane-wrap-primary";
                return document.querySelector<HTMLElement>(selector);
            })();

            // Reading mode has its own SolidJS panel in
            // ReadingView.tsx; look for its rendered DOM inside the
            // ACTIVE pane to tell if it's currently open. Scoping
            // this to the active pane's wrapper keeps split-mode
            // Ctrl+F from latching onto a panel in the other pane.
            const readingPanelOpen = !!(activePaneWrap
                ?? document
            ).querySelector(".mz-reading-find-panel");

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
            //
            // IMPORTANT: in split mode we MUST target the CM view
            // inside the currently-focused pane, not the stale
            // `__mindzj_plugin_editor_api` global (which trails
            // focus changes and can point at the wrong pane). We
            // resolve the view from the DOM in this order:
            //   1. The `.cm-editor` that owns document focus — if
            //      the user just clicked inside an editor this is
            //      the authoritative answer.
            //   2. The `.cm-editor` inside the active pane's wrapper
            //      — covers the case where focus went to a sidebar
            //      (e.g. Ctrl+F from the global-search input).
            //   3. The plugin-API fallback kept for backward compat.
            const cmView = findActivePaneEditorView(activePaneWrap);
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
                        // Closed panels clear their query, so the
                        // first open can use CM6's single-dispatch
                        // opener and avoid an extra split-pane
                        // layout/measure pass.
                        openSearchPanel(cmView);
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
            // Scope both the reading-panel check and the CM view
            // lookup to the focused pane so Escape in split mode
            // closes the panel on THIS pane only — otherwise the
            // global queries below would pick the first panel in
            // document order, which might belong to the other pane.
            const slot = activePaneSlot();
            const activeWrap = document.querySelector<HTMLElement>(
                slot === "secondary"
                    ? ".mz-pane-wrap-secondary"
                    : ".mz-pane-wrap-primary",
            );
            const readingPanel = (activeWrap ?? document).querySelector(
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
            const cmView = findActivePaneEditorView(activeWrap);
            if (cmView && searchPanelOpen(cmView.state)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                clearEditorSearchQuery(cmView);
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
                                        onFileClick={(p: string) => { void handleSidebarFileClick(p); }}
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
                                splitRatio={splitRatio()}
                                onActivatePane={activatePane}
                                onClosePane={closeSplitPane}
                                onSplitRatioChange={setSplitRatio}
                            />
                        </Show>
                        <Show when={showAiPanel()}>
                            <AiBottomPanel
                                input={aiPanelInput()}
                                output={aiPanelOutput()}
                                busy={aiPanelBusy()}
                                voiceRecording={aiVoiceRecording()}
                                voiceBusy={aiVoiceBusy()}
                                height={aiPanelHeight()}
                                activePath={activePanePath() ?? vaultStore.activeFile()?.path ?? null}
                                modelLabel={currentAiModelLabel()}
                                modelOptions={aiPanelModelOptions()}
                                activeModelValue={currentAiModelOptionValue()}
                                historyOpen={showAiHistory()}
                                historyPosition={aiHistoryPosition()}
                                historyDates={aiHistoryDates()}
                                historyDate={aiHistoryDate()}
                                historyEntries={selectedAiHistoryEntries()}
                                onHeightChange={(height) => setAiPanelHeight(clampAiPanelHeight(height))}
                                onSelectModel={selectAiPanelModel}
                                onInput={handleAiPanelInput}
                                onRun={() => void runAiPanelInstruction()}
                                onToggleVoiceInput={toggleAiVoiceRecording}
                                onSpeakInput={() => void synthesizeAiPanelInput()}
                                onToggleHistory={toggleAiHistoryDialog}
                                onCloseHistory={closeAiHistoryDialog}
                                onMoveHistory={setAiHistoryPosition}
                                onSelectHistoryDate={setAiHistoryDate}
                                onDeleteHistoryEntry={deleteAiHistoryEntry}
                                onClearHistoryDate={clearAiHistoryForSelectedDate}
                                onClearAllHistory={clearAllAiHistory}
                                onCopyHistoryEntry={copyAiHistoryQuestion}
                                onNavigateHistory={navigateAiQuestionHistory}
                                onClose={closeAiPanel}
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

const AiBottomPanel: Component<{
    input: string;
    output: string;
    busy: boolean;
    voiceRecording: boolean;
    voiceBusy: boolean;
    height: number;
    activePath: string | null;
    modelLabel: string;
    modelOptions: AiPanelModelOption[];
    activeModelValue: string;
    historyOpen: boolean;
    historyPosition: Point;
    historyDates: string[];
    historyDate: string;
    historyEntries: AiQuestionHistoryEntry[];
    onHeightChange: (height: number) => void;
    onSelectModel: (value: string) => void;
    onInput: (value: string) => void;
    onRun: () => void;
    onToggleVoiceInput: () => void;
    onSpeakInput: () => void;
    onToggleHistory: () => void;
    onCloseHistory: () => void;
    onMoveHistory: (position: Point) => void;
    onSelectHistoryDate: (value: string) => void;
    onDeleteHistoryEntry: (id: string) => void;
    onClearHistoryDate: () => void;
    onClearAllHistory: () => void;
    onCopyHistoryEntry: (text: string) => void;
    onNavigateHistory: (direction: AiHistoryDirection) => void;
    onClose: () => void;
}> = (props) => {
    let textareaRef: HTMLTextAreaElement | undefined;
    let outputRef: HTMLPreElement | undefined;

    onMount(() => {
        queueMicrotask(() => textareaRef?.focus());
    });

    createEffect(() => {
        props.output;
        if (!props.busy) return;
        queueMicrotask(() => {
            if (outputRef) outputRef.scrollTop = outputRef.scrollHeight;
        });
    });

    function startPanelResize(event: MouseEvent) {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = props.height;
        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;
        document.body.style.cursor = "ns-resize";
        document.body.style.userSelect = "none";

        const onMove = (moveEvent: MouseEvent) => {
            props.onHeightChange(startHeight + startY - moveEvent.clientY);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }

    return (
        <>
        <div
            style={{
                height: `${props.height}px`,
                "min-height": "220px",
                width: "100%",
                "flex-shrink": "0",
                display: "flex",
                "flex-direction": "column",
                position: "relative",
                background: "var(--mz-bg-secondary)",
                border: "1px solid var(--mz-border)",
                "border-left": "none",
                "border-right": "none",
                "box-shadow": "0 -6px 18px rgba(0,0,0,0.18)",
                color: "var(--mz-text-primary)",
            }}
        >
            <div
                onMouseDown={startPanelResize}
                style={{
                    position: "absolute",
                    top: "-4px",
                    left: "0",
                    right: "0",
                    height: "8px",
                    cursor: "ns-resize",
                    "z-index": "3",
                }}
            />
            <div
                style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                    height: "36px",
                    padding: "0 12px",
                    "border-bottom": "1px solid var(--mz-border)",
                    "font-size": "var(--mz-font-size-sm)",
                    "font-family": "var(--mz-font-sans)",
                }}
            >
                <div style={{ display: "flex", "align-items": "center", gap: "10px", "min-width": "0" }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "6px", position: "relative", "flex-shrink": "0" }}>
                        <strong>{t("aiPanel.title")}</strong>
                        <button
                            type="button"
                            onClick={props.onToggleHistory}
                            title={t("aiPanel.history")}
                            aria-label={t("aiPanel.history")}
                            style={{
                                width: "26px",
                                height: "26px",
                                display: "inline-flex",
                                "align-items": "center",
                                "justify-content": "center",
                                border: props.historyOpen ? "1px solid var(--mz-accent)" : "1px solid var(--mz-border)",
                                "border-radius": "var(--mz-radius-sm)",
                                background: props.historyOpen ? "var(--mz-accent-subtle)" : "transparent",
                                color: props.historyOpen ? "var(--mz-accent)" : "var(--mz-text-muted)",
                                cursor: "pointer",
                                padding: "0",
                            }}
                            onMouseEnter={hoverAiActionButton}
                            onMouseDown={pressAiActionButton}
                            onMouseUp={hoverAiActionButton}
                            onMouseLeave={(event) => resetAiActionButton(event, props.historyOpen)}
                        >
                            <History size={15} strokeWidth={1.8} />
                        </button>
                        <Show when={false}>
                            <button
                                type="button"
                                onClick={props.onToggleVoiceInput}
                                disabled={props.busy || props.voiceBusy}
                                title={props.voiceRecording ? t("aiPanel.voiceStop") : t("aiPanel.voiceStart")}
                                aria-label={props.voiceRecording ? t("aiPanel.voiceStop") : t("aiPanel.voiceStart")}
                                style={{
                                    width: "26px",
                                    height: "26px",
                                    display: "inline-flex",
                                    "align-items": "center",
                                    "justify-content": "center",
                                    border: "1px solid var(--mz-border)",
                                    "border-radius": "var(--mz-radius-sm)",
                                    background: props.voiceRecording ? "var(--mz-bg-hover)" : "transparent",
                                    color: props.voiceRecording ? "var(--mz-accent)" : "var(--mz-text-muted)",
                                    cursor: props.busy || props.voiceBusy ? "default" : "pointer",
                                    opacity: props.busy || props.voiceBusy ? "0.55" : "1",
                                    padding: "0",
                                }}
                            >
                                <Show when={props.voiceRecording} fallback={<Mic size={15} strokeWidth={1.8} />}>
                                    <MicOff size={15} strokeWidth={1.8} />
                                </Show>
                            </button>
                            <button
                                type="button"
                                onClick={props.onSpeakInput}
                                disabled={props.busy || props.voiceBusy || props.voiceRecording || !props.input.trim()}
                                title={t("aiPanel.ttsInput")}
                                aria-label={t("aiPanel.ttsInput")}
                                style={{
                                    width: "26px",
                                    height: "26px",
                                    display: "inline-flex",
                                    "align-items": "center",
                                    "justify-content": "center",
                                    border: "1px solid var(--mz-border)",
                                    "border-radius": "var(--mz-radius-sm)",
                                    background: "transparent",
                                    color: "var(--mz-text-muted)",
                                    cursor: props.busy || props.voiceBusy || props.voiceRecording || !props.input.trim() ? "default" : "pointer",
                                    opacity: props.busy || props.voiceBusy || props.voiceRecording || !props.input.trim() ? "0.55" : "1",
                                    padding: "0",
                                }}
                            >
                                <Volume2 size={15} strokeWidth={1.8} />
                            </button>
                        </Show>
                        <Show when={false}>
                            <div
                                style={{
                                    position: "absolute",
                                    top: "30px",
                                    left: "0",
                                    width: "min(430px, calc(100vw - 32px))",
                                    "max-height": "250px",
                                    display: "flex",
                                    "flex-direction": "column",
                                    gap: "8px",
                                    padding: "10px",
                                    background: "var(--mz-bg-secondary)",
                                    border: "1px solid var(--mz-border)",
                                    "border-radius": "var(--mz-radius-sm)",
                                    "box-shadow": "0 10px 28px rgba(0,0,0,0.32)",
                                    "z-index": "1000",
                                    color: "var(--mz-text-primary)",
                                }}
                            >
                                <div style={{ display: "flex", "align-items": "center", gap: "6px", "min-width": "0" }}>
                                    <select
                                        aria-label={t("aiPanel.historyDate")}
                                        value={props.historyDate}
                                        disabled={props.historyDates.length === 0}
                                        onChange={(event) => props.onSelectHistoryDate(event.currentTarget.value)}
                                        style={{
                                            flex: "1",
                                            "min-width": "0",
                                            height: "26px",
                                            border: "1px solid var(--mz-border)",
                                            "border-radius": "var(--mz-radius-sm)",
                                            background: "var(--mz-bg-primary)",
                                            color: "var(--mz-text-primary)",
                                            "font-size": "var(--mz-font-size-xs)",
                                            "font-family": "var(--mz-font-sans)",
                                        }}
                                    >
                                        <Show
                                            when={props.historyDates.length > 0}
                                            fallback={<option value="">{t("aiPanel.historyNoDate")}</option>}
                                        >
                                            <For each={props.historyDates}>
                                                {(date) => <option value={date}>{formatAiHistoryDate(date)}</option>}
                                            </For>
                                        </Show>
                                    </select>
                                    <button
                                        type="button"
                                        onClick={props.onClearHistoryDate}
                                        disabled={!props.historyDate}
                                        title={t("aiPanel.historyClearDate")}
                                        style={{
                                            border: "1px solid var(--mz-border)",
                                            "border-radius": "var(--mz-radius-sm)",
                                            background: "transparent",
                                            color: "var(--mz-text-muted)",
                                            cursor: props.historyDate ? "pointer" : "default",
                                            opacity: props.historyDate ? "1" : "0.5",
                                            padding: "4px 8px",
                                            "font-size": "var(--mz-font-size-xs)",
                                            "white-space": "nowrap",
                                        }}
                                    >
                                        {t("aiPanel.historyClearDate")}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={props.onClearAllHistory}
                                        disabled={props.historyDates.length === 0}
                                        title={t("aiPanel.historyClearAll")}
                                        style={{
                                            border: "1px solid var(--mz-border)",
                                            "border-radius": "var(--mz-radius-sm)",
                                            background: "transparent",
                                            color: "var(--mz-text-muted)",
                                            cursor: props.historyDates.length ? "pointer" : "default",
                                            opacity: props.historyDates.length ? "1" : "0.5",
                                            padding: "4px 8px",
                                            "font-size": "var(--mz-font-size-xs)",
                                            "white-space": "nowrap",
                                        }}
                                    >
                                        {t("aiPanel.historyClearAll")}
                                    </button>
                                </div>
                                <Show
                                    when={props.historyEntries.length > 0}
                                    fallback={
                                        <div style={{ color: "var(--mz-text-muted)", "font-size": "var(--mz-font-size-xs)", padding: "14px 2px" }}>
                                            {t("aiPanel.historyEmpty")}
                                        </div>
                                    }
                                >
                                    <div
                                        style={{
                                            display: "flex",
                                            "flex-direction": "column",
                                            gap: "6px",
                                            overflow: "auto",
                                            "min-height": "0",
                                            "max-height": "188px",
                                        }}
                                    >
                                        <For each={props.historyEntries}>
                                            {(entry) => (
                                                <div
                                                    style={{
                                                        display: "grid",
                                                        "grid-template-columns": "1fr auto auto",
                                                        gap: "6px",
                                                        "align-items": "center",
                                                        padding: "7px",
                                                        border: "1px solid var(--mz-border)",
                                                        "border-radius": "var(--mz-radius-sm)",
                                                        background: "var(--mz-bg-primary)",
                                                    }}
                                                >
                                                    <div style={{ "min-width": "0" }}>
                                                        <div style={{ color: "var(--mz-text-muted)", "font-size": "11px", "margin-bottom": "4px" }}>
                                                            {formatAiHistoryTimestamp(entry.createdAt)}
                                                        </div>
                                                        <div
                                                            style={{
                                                                color: "var(--mz-text-secondary)",
                                                                "font-size": "var(--mz-font-size-xs)",
                                                                "line-height": "1.45",
                                                                "white-space": "pre-wrap",
                                                                "word-break": "break-word",
                                                                "user-select": "text",
                                                                "-webkit-user-select": "text",
                                                            }}
                                                        >
                                                            {entry.text}
                                                        </div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => props.onCopyHistoryEntry(entry.text)}
                                                        title={t("common.copy")}
                                                        aria-label={t("common.copy")}
                                                        style={{
                                                            width: "26px",
                                                            height: "26px",
                                                            display: "inline-flex",
                                                            "align-items": "center",
                                                            "justify-content": "center",
                                                            border: "1px solid var(--mz-border)",
                                                            "border-radius": "var(--mz-radius-sm)",
                                                            background: "transparent",
                                                            color: "var(--mz-text-muted)",
                                                            cursor: "pointer",
                                                            padding: "0",
                                                        }}
                                                    >
                                                        <Copy size={14} strokeWidth={1.8} />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => props.onDeleteHistoryEntry(entry.id)}
                                                        title={t("common.delete")}
                                                        aria-label={t("common.delete")}
                                                        style={{
                                                            width: "26px",
                                                            height: "26px",
                                                            display: "inline-flex",
                                                            "align-items": "center",
                                                            "justify-content": "center",
                                                            border: "1px solid var(--mz-border)",
                                                            "border-radius": "var(--mz-radius-sm)",
                                                            background: "transparent",
                                                            color: "var(--mz-text-muted)",
                                                            cursor: "pointer",
                                                            padding: "0",
                                                        }}
                                                    >
                                                        <Trash2 size={14} strokeWidth={1.8} />
                                                    </button>
                                                </div>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </div>
                        </Show>
                    </div>
                    <Show
                        when={props.modelOptions.length > 0}
                        fallback={
                            <span style={{ color: "var(--mz-accent)", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "min-width": "0" }}>
                                {props.modelLabel}
                            </span>
                        }
                    >
                        <select
                            aria-label={t("settings.aiProviderSection")}
                            value={props.activeModelValue}
                            disabled={props.busy}
                            onChange={(event) => props.onSelectModel(event.currentTarget.value)}
                            style={{
                                "max-width": "220px",
                                "min-width": "60px",
                                height: "26px",
                                padding: "2px 16px 2px 8px",
                                border: "1px solid var(--mz-border)",
                                "border-radius": "var(--mz-radius-sm)",
                                background: "var(--mz-bg-primary)",
                                color: "var(--mz-accent)",
                                cursor: props.busy ? "default" : "pointer",
                                opacity: props.busy ? "0.7" : "1",
                                overflow: "hidden",
                                "text-overflow": "ellipsis",
                                "white-space": "nowrap",
                                "font-size": "var(--mz-font-size-xs)",
                                "font-family": "var(--mz-font-sans)",
                                "flex-shrink": "1",
                            }}
                        >
                            <For each={props.modelOptions}>
                                {(option) => (
                                    <option value={option.value}>
                                        {option.label}
                                    </option>
                                )}
                            </For>
                        </select>
                    </Show>
                    <span
                        style={{
                            color: "var(--mz-text-muted)",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                            "user-select": "text",
                            "-webkit-user-select": "text",
                            cursor: "text",
                        }}
                    >
                        {props.activePath || t("aiPanel.noActiveFile")}
                    </span>
                </div>
                <button
                    onClick={props.onClose}
                    title={t("common.close")}
                    style={{
                        width: "28px",
                        height: "28px",
                        border: "none",
                        "border-radius": "var(--mz-radius-sm)",
                        background: "transparent",
                        color: "var(--mz-text-muted)",
                        cursor: "pointer",
                        "font-size": "18px",
                        "line-height": "1",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                    <X size={16} strokeWidth={1.8} />
                </button>
            </div>
            <div
                style={{
                    flex: "1",
                    display: "grid",
                    "grid-template-columns": "repeat(auto-fit, minmax(260px, 1fr))",
                    gap: "12px",
                    padding: "12px",
                    "min-height": "0",
                }}
            >
                <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "min-width": "0", "min-height": "0" }}>
                    <textarea
                        ref={textareaRef}
                        data-mz-ai-input="true"
                        value={props.input}
                        placeholder={t("aiPanel.placeholder")}
                        disabled={props.busy}
                        onInput={(e) => props.onInput(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                                e.preventDefault();
                                e.stopPropagation();
                                props.onNavigateHistory(e.key === "ArrowUp" ? "prev" : "next");
                                return;
                            }
                            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                                e.preventDefault();
                                props.onRun();
                            }
                        }}
                        style={{
                            flex: "1",
                            resize: "none",
                            border: "1px solid var(--mz-border)",
                            "border-radius": "var(--mz-radius-sm)",
                            background: "var(--mz-bg-primary)",
                            color: "var(--mz-text-primary)",
                            padding: "10px",
                            "font-family": "var(--mz-font-sans)",
                            "font-size": "var(--mz-font-size-sm)",
                            outline: "none",
                            "min-height": "0",
                        }}
                    />
                    <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
                        <button
                            onClick={props.onRun}
                            disabled={props.busy || props.voiceBusy || props.voiceRecording || !props.input.trim()}
                            style={{
                                border: "1px solid var(--mz-accent)",
                                background: "transparent",
                                color: "var(--mz-accent)",
                                "border-radius": "var(--mz-radius-sm)",
                                padding: "6px 16px",
                                cursor: props.busy || props.voiceBusy || props.voiceRecording || !props.input.trim() ? "default" : "pointer",
                                opacity: props.busy || props.voiceBusy || props.voiceRecording || !props.input.trim() ? "0.55" : "1",
                                "font-size": "var(--mz-font-size-sm)",
                                "font-family": "var(--mz-font-sans)",
                            }}
                        >
                            {props.busy || props.voiceBusy ? t("aiPanel.working") : t("aiPanel.run")}
                        </button>
                    </div>
                </div>
                <pre
                    ref={outputRef}
                    style={{
                        margin: "0",
                        overflow: "auto",
                        "white-space": "pre-wrap",
                        "word-break": "break-word",
                        border: "1px solid var(--mz-border)",
                        "border-radius": "var(--mz-radius-sm)",
                        background: "var(--mz-bg-primary)",
                        color: props.output ? "var(--mz-text-secondary)" : "var(--mz-text-muted)",
                        padding: "10px",
                        "font-family": "var(--mz-font-mono, monospace)",
                        "font-size": "var(--mz-font-size-xs)",
                        "min-height": "0",
                        "user-select": "text",
                        "-webkit-user-select": "text",
                        cursor: "text",
                    }}
                >
                    {props.output || t("aiPanel.empty")}
                </pre>
            </div>
        </div>
        <Show when={props.historyOpen}>
            <AiHistoryDialog
                position={props.historyPosition}
                dates={props.historyDates}
                selectedDate={props.historyDate}
                entries={props.historyEntries}
                onMove={props.onMoveHistory}
                onClose={props.onCloseHistory}
                onSelectDate={props.onSelectHistoryDate}
                onDeleteEntry={props.onDeleteHistoryEntry}
                onClearDate={props.onClearHistoryDate}
                onClearAll={props.onClearAllHistory}
                onCopyEntry={props.onCopyHistoryEntry}
            />
        </Show>
        </>
    );
};

function hoverAiActionButton(event: MouseEvent) {
    const target = event.currentTarget as HTMLElement;
    target.style.background = "var(--mz-bg-hover)";
    target.style.borderColor = "var(--mz-accent)";
    target.style.color = "var(--mz-accent)";
}

function pressAiActionButton(event: MouseEvent) {
    const target = event.currentTarget as HTMLElement;
    target.style.background = "var(--mz-accent-subtle)";
    target.style.borderColor = "var(--mz-accent)";
    target.style.color = "var(--mz-accent)";
}

function resetAiActionButton(event: MouseEvent, active = false) {
    const target = event.currentTarget as HTMLElement;
    target.style.background = active ? "var(--mz-accent-subtle)" : "transparent";
    target.style.borderColor = active ? "var(--mz-accent)" : "var(--mz-border)";
    target.style.color = active ? "var(--mz-accent)" : "var(--mz-text-muted)";
}

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

const AiHistoryDialog: Component<{
    position: Point;
    dates: string[];
    selectedDate: string;
    entries: AiQuestionHistoryEntry[];
    onMove: (position: Point) => void;
    onClose: () => void;
    onSelectDate: (value: string) => void;
    onDeleteEntry: (id: string) => void;
    onClearDate: () => void;
    onClearAll: () => void;
    onCopyEntry: (text: string) => void;
}> = (props) => {
    let dialogRef: HTMLDivElement | undefined;

    const clampPosition = (position: Point): Point => {
        const width = dialogRef?.offsetWidth ?? 520;
        const height = dialogRef?.offsetHeight ?? 420;
        return {
            x: Math.max(8, Math.min(window.innerWidth - width - 8, position.x)),
            y: Math.max(8, Math.min(window.innerHeight - height - 8, position.y)),
        };
    };

    onMount(() => {
        queueMicrotask(() => props.onMove(clampPosition(props.position)));
    });

    function startDrag(event: MouseEvent) {
        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        const startPosition = props.position;
        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;
        document.body.style.cursor = "move";
        document.body.style.userSelect = "none";

        const onMove = (moveEvent: MouseEvent) => {
            props.onMove(clampPosition({
                x: startPosition.x + moveEvent.clientX - startX,
                y: startPosition.y + moveEvent.clientY - startY,
            }));
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }

    return (
        <div
            ref={dialogRef}
            style={{
                position: "fixed",
                left: `${props.position.x}px`,
                top: `${props.position.y}px`,
                width: "min(520px, calc(100vw - 32px))",
                height: "min(420px, calc(100vh - 48px))",
                display: "flex",
                "flex-direction": "column",
                background: "var(--mz-bg-secondary)",
                border: "1px solid var(--mz-border)",
                "border-radius": "var(--mz-radius-sm)",
                "box-shadow": "0 14px 40px rgba(0,0,0,0.42)",
                "z-index": "100000",
                color: "var(--mz-text-primary)",
                overflow: "hidden",
                "font-family": "var(--mz-font-sans)",
            }}
        >
            <div
                onMouseDown={startDrag}
                style={{
                    height: "38px",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                    gap: "8px",
                    padding: "0 10px",
                    border: "0 solid var(--mz-border)",
                    "border-bottom-width": "1px",
                    cursor: "move",
                    "user-select": "none",
                }}
            >
                <strong style={{ "font-size": "var(--mz-font-size-sm)" }}>{t("aiPanel.history")}</strong>
                <button
                    type="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={props.onClose}
                    title={t("common.close")}
                    aria-label={t("common.close")}
                    style={{
                        width: "28px",
                        height: "28px",
                        display: "inline-flex",
                        "align-items": "center",
                        "justify-content": "center",
                        border: "none",
                        "border-radius": "var(--mz-radius-sm)",
                        background: "transparent",
                        color: "var(--mz-text-muted)",
                        cursor: "pointer",
                        padding: "0",
                    }}
                >
                    <X size={16} strokeWidth={1.8} />
                </button>
            </div>
            <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "10px", border: "0 solid var(--mz-border)", "border-bottom-width": "1px" }}>
                <select
                    aria-label={t("aiPanel.historyDate")}
                    value={props.selectedDate}
                    disabled={props.dates.length === 0}
                    onChange={(event) => props.onSelectDate(event.currentTarget.value)}
                    style={{
                        flex: "1",
                        "min-width": "0",
                        height: "28px",
                        border: "1px solid var(--mz-border)",
                        "border-radius": "var(--mz-radius-sm)",
                        background: "var(--mz-bg-primary)",
                        color: "var(--mz-text-primary)",
                        "font-size": "var(--mz-font-size-xs)",
                    }}
                >
                    <Show
                        when={props.dates.length > 0}
                        fallback={<option value="">{t("aiPanel.historyNoDate")}</option>}
                    >
                        <For each={props.dates}>
                            {(date) => <option value={date}>{formatAiHistoryDate(date)}</option>}
                        </For>
                    </Show>
                </select>
                <button
                    type="button"
                    onClick={props.onClearDate}
                    disabled={!props.selectedDate}
                    title={t("aiPanel.historyClearDate")}
                    onMouseEnter={hoverAiActionButton}
                    onMouseDown={pressAiActionButton}
                    onMouseUp={hoverAiActionButton}
                    onMouseLeave={resetAiActionButton}
                    style={{
                        border: "1px solid var(--mz-border)",
                        "border-radius": "var(--mz-radius-sm)",
                        background: "transparent",
                        color: "var(--mz-text-muted)",
                        cursor: props.selectedDate ? "pointer" : "default",
                        opacity: props.selectedDate ? "1" : "0.5",
                        padding: "5px 10px",
                        "font-size": "var(--mz-font-size-xs)",
                        "white-space": "nowrap",
                    }}
                >
                    {t("aiPanel.historyClearDate")}
                </button>
                <button
                    type="button"
                    onClick={props.onClearAll}
                    disabled={props.dates.length === 0}
                    title={t("aiPanel.historyClearAll")}
                    onMouseEnter={hoverAiActionButton}
                    onMouseDown={pressAiActionButton}
                    onMouseUp={hoverAiActionButton}
                    onMouseLeave={resetAiActionButton}
                    style={{
                        border: "1px solid var(--mz-border)",
                        "border-radius": "var(--mz-radius-sm)",
                        background: "transparent",
                        color: "var(--mz-text-muted)",
                        cursor: props.dates.length ? "pointer" : "default",
                        opacity: props.dates.length ? "1" : "0.5",
                        padding: "5px 10px",
                        "font-size": "var(--mz-font-size-xs)",
                        "white-space": "nowrap",
                    }}
                >
                    {t("aiPanel.historyClearAll")}
                </button>
            </div>
            <Show
                when={props.entries.length > 0}
                fallback={
                    <div style={{ color: "var(--mz-text-muted)", "font-size": "var(--mz-font-size-sm)", padding: "18px" }}>
                        {t("aiPanel.historyEmpty")}
                    </div>
                }
            >
                <div style={{ flex: "1", overflow: "auto", padding: "10px", display: "flex", "flex-direction": "column", gap: "8px", "min-height": "0" }}>
                    <For each={props.entries}>
                        {(entry) => (
                            <div
                                style={{
                                    display: "grid",
                                    "grid-template-columns": "1fr auto auto",
                                    gap: "8px",
                                    "align-items": "center",
                                    padding: "9px",
                                    border: "1px solid var(--mz-border)",
                                    "border-radius": "var(--mz-radius-sm)",
                                    background: "var(--mz-bg-primary)",
                                }}
                            >
                                <div style={{ "min-width": "0" }}>
                                    <div style={{ color: "var(--mz-text-muted)", "font-size": "11px", "margin-bottom": "5px" }}>
                                        {formatAiHistoryTimestamp(entry.createdAt)}
                                    </div>
                                    <div
                                        style={{
                                            color: "var(--mz-text-secondary)",
                                            "font-size": "var(--mz-font-size-xs)",
                                            "line-height": "1.5",
                                            "white-space": "pre-wrap",
                                            "word-break": "break-word",
                                            "user-select": "text",
                                            "-webkit-user-select": "text",
                                            cursor: "text",
                                        }}
                                    >
                                        {entry.text}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => props.onCopyEntry(entry.text)}
                                    title={t("common.copy")}
                                    aria-label={t("common.copy")}
                                    onMouseEnter={hoverAiActionButton}
                                    onMouseDown={pressAiActionButton}
                                    onMouseUp={hoverAiActionButton}
                                    onMouseLeave={resetAiActionButton}
                                    style={{
                                        width: "28px",
                                        height: "28px",
                                        display: "inline-flex",
                                        "align-items": "center",
                                        "justify-content": "center",
                                        border: "1px solid var(--mz-border)",
                                        "border-radius": "var(--mz-radius-sm)",
                                        background: "transparent",
                                        color: "var(--mz-text-muted)",
                                        cursor: "pointer",
                                        padding: "0",
                                    }}
                                >
                                    <Copy size={14} strokeWidth={1.8} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => props.onDeleteEntry(entry.id)}
                                    title={t("common.delete")}
                                    aria-label={t("common.delete")}
                                    onMouseEnter={hoverAiActionButton}
                                    onMouseDown={pressAiActionButton}
                                    onMouseUp={hoverAiActionButton}
                                    onMouseLeave={resetAiActionButton}
                                    style={{
                                        width: "28px",
                                        height: "28px",
                                        display: "inline-flex",
                                        "align-items": "center",
                                        "justify-content": "center",
                                        border: "1px solid var(--mz-border)",
                                        "border-radius": "var(--mz-radius-sm)",
                                        background: "transparent",
                                        color: "var(--mz-text-muted)",
                                        cursor: "pointer",
                                        padding: "0",
                                    }}
                                >
                                    <Trash2 size={14} strokeWidth={1.8} />
                                </button>
                            </div>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
};

const SplitWorkspaceView: Component<{
    primaryPath: string | null;
    secondaryPath: string | null;
    activeSlot: PaneSlot;
    direction: SplitDirection;
    splitRatio: number;
    onActivatePane: (slot: PaneSlot) => void;
    onClosePane: (slot: PaneSlot) => void;
    onSplitRatioChange: (ratio: number) => void;
}> = (props) => {
    let containerRef: HTMLDivElement | undefined;
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
    // When non-split, the primary pane absorbs the whole container so
    // the fallback layout (single pane at 100%) looks identical to the
    // previous `<Show fallback=…>` structure — except we keep the split
    // container mounted so flipping `isSplit()` never unmounts the
    // primary `<PaneFileView>`. Remounting was the source of the first-
    // time "Split right" lag: it tore down the already-warm CM6 editor
    // and rebuilt it from cold, on top of spinning up the secondary
    // editor.
    const paneStyle = (slot: PaneSlot) => {
        if (!isSplit()) {
            if (slot === "primary") {
                return {
                    flex: "1 1 0",
                    "min-width": "0",
                    "min-height": "0",
                    display: "flex",
                } as const;
            }
            return {
                flex: "0 0 0",
                "min-width": "0",
                "min-height": "0",
                display: "none",
            } as const;
        }
        return {
            flex: `${slot === "primary" ? props.splitRatio : 1 - props.splitRatio} 1 0`,
            "min-width": "0",
            "min-height": "0",
            display: "flex",
        } as const;
    };

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
            props.onSplitRatioChange(nextRatio);
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
            {/* Always-mounted split container. The primary PaneFileView
                lives inside it regardless of whether the user is in
                split mode — toggling `isSplit()` only adds/removes the
                divider + secondary pane. This prevents the primary
                Editor from being remounted on first "Split right",
                which used to rebuild CodeMirror from cold (the source
                of the several-hundred-millisecond freeze). */}
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
                <div
                    class={isSplit() ? "mz-pane-wrap mz-pane-wrap-primary" : "mz-pane-wrap mz-pane-wrap-primary mz-pane-wrap-solo"}
                    style={paneStyle("primary")}
                >
                    <PaneFileView
                        filePath={props.primaryPath!}
                        active={!isSplit() || props.activeSlot === "primary"}
                        split={isSplit()}
                        onActivate={() => props.onActivatePane("primary")}
                    />
                </div>
                <Show when={isSplit()}>
                    <div
                        onMouseDown={startDividerDrag}
                        style={{
                            ...dividerStyle(),
                            background: "var(--mz-border)",
                            "flex-shrink": "0",
                            position: "relative",
                        }}
                    />
                    <div class="mz-pane-wrap mz-pane-wrap-secondary" style={paneStyle("secondary")}>
                        <PaneFileView
                            filePath={props.secondaryPath!}
                            active={props.activeSlot === "secondary"}
                            split={true}
                            onActivate={() => props.onActivatePane("secondary")}
                            onClose={() => props.onClosePane("secondary")}
                        />
                    </div>
                </Show>
            </div>
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
            class="mz-split-pane"
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
