import { Component, For, Show, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog, promptDialog } from "../common/ConfirmDialog";
import type { VaultEntry } from "../../stores/vault";
import { vaultStore } from "../../stores/vault";
import { editorStore } from "../../stores/editor";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { displayName } from "../../utils/displayName";
import { fetchBacklinks, updateBacklinksOnFileRename } from "../../utils/linkUpdater";
import { openFileRouted } from "../../utils/openFileRouted";
import { t } from "../../i18n";

type FolderVisibilityAction = "default" | "collapse" | "expand";

const [folderVisibilityMode, setFolderVisibilityMode] =
    createSignal<FolderVisibilityAction>("default");
const [folderOpenState, setFolderOpenState] = createSignal<Record<string, boolean>>({});
const [registeredFolders, setRegisteredFolders] =
    createSignal<Record<string, number>>({});
const [allFoldersCollapsed, setAllFoldersCollapsed] = createSignal(false);

export { allFoldersCollapsed };

function defaultFolderOpen(depth: number, mode = folderVisibilityMode()) {
    if (mode === "collapse") return false;
    if (mode === "expand") return true;
    return depth < 1;
}

function syncAllFoldersCollapsed(
    nextOpenState = folderOpenState(),
    nextRegisteredFolders = registeredFolders(),
) {
    const paths = Object.keys(nextRegisteredFolders);
    setAllFoldersCollapsed(
        paths.length > 0 && paths.every((path) => nextOpenState[path] === false),
    );
}

function syncRegisteredFolders(entries: VaultEntry[], rootDepth = 0) {
    const nextRegisteredFolders: Record<string, number> = {};

    const walk = (nodes: VaultEntry[], depth: number) => {
        for (const node of nodes) {
            if (!node.is_dir) continue;
            nextRegisteredFolders[node.relative_path] = depth;
            if (node.children?.length) {
                walk(node.children, depth + 1);
            }
        }
    };

    walk(entries, rootDepth);
    setRegisteredFolders(nextRegisteredFolders);
    setFolderOpenState((prev) => {
        const next: Record<string, boolean> = {};
        for (const [path, depth] of Object.entries(nextRegisteredFolders)) {
            next[path] = path in prev ? prev[path]! : defaultFolderOpen(depth);
        }
        syncAllFoldersCollapsed(next, nextRegisteredFolders);
        return next;
    });
}

function getFolderOpen(path: string, depth: number) {
    const current = folderOpenState();
    return path in current ? current[path]! : defaultFolderOpen(depth);
}

function setFolderOpen(path: string, depth: number, open: boolean) {
    const currentRegistered = registeredFolders();
    const nextRegistered =
        path in currentRegistered
            ? currentRegistered
            : { ...currentRegistered, [path]: depth };
    if (nextRegistered !== currentRegistered) {
        setRegisteredFolders(nextRegistered);
    }
    setFolderOpenState((prev) => {
        const next = { ...prev, [path]: open };
        syncAllFoldersCollapsed(next, nextRegistered);
        return next;
    });
}

export function setAllFoldersVisibility(action: "collapse" | "expand") {
    const currentRegistered = registeredFolders();
    const isOpen = action === "expand";
    setFolderVisibilityMode(action);
    setFolderOpenState(() => {
        const next = Object.fromEntries(
            Object.keys(currentRegistered).map((path) => [path, isOpen]),
        ) as Record<string, boolean>;
        syncAllFoldersCollapsed(next, currentRegistered);
        return next;
    });
}

export function resetFolderVisibilityState() {
    setFolderVisibilityMode("default");
    setFolderOpenState({});
    setRegisteredFolders({});
    setAllFoldersCollapsed(false);
}

// ---------------------------------------------------------------------------
// Inline rename state (module-level so FileItem / FolderItem can access it)
// ---------------------------------------------------------------------------

const [renamingPath, setRenamingPath] = createSignal<string | null>(null);
const [renamingName, setRenamingName] = createSignal("");
let _renameHiddenSuffix: string | null = null;
let _renameOriginalDisplay = "";

/** Start inline rename for a file/folder entry */
function startInlineRename(path: string, isDir: boolean) {
    const name = path.split("/").pop() || path;
    const hiddenSuffixes = [".markdown", ".md", ".mindzj"];
    const lower = name.toLowerCase();
    _renameHiddenSuffix = isDir
        ? null
        : hiddenSuffixes.find((s) => lower.endsWith(s)) ?? null;
    _renameOriginalDisplay = _renameHiddenSuffix
        ? name.slice(0, -_renameHiddenSuffix.length)
        : name;
    setRenamingName(_renameOriginalDisplay);
    setRenamingPath(path);
}

/** Confirm rename — called on Enter or blur */
async function confirmRename() {
    const path = renamingPath();
    if (!path) return;

    const entered = renamingName().trim();
    setRenamingPath(null); // close the input immediately

    if (!entered || entered === _renameOriginalDisplay) return;

    const name = path.split("/").pop() || path;
    const newName =
        _renameHiddenSuffix && !entered.toLowerCase().endsWith(_renameHiddenSuffix)
            ? `${entered}${_renameHiddenSuffix}`
            : entered;
    if (newName === name) return;

    const dir = path.split("/").slice(0, -1).join("/");
    const newPath = dir ? `${dir}/${newName}` : newName;

    try {
        // Cancel any pending auto-save for the old path so it doesn't
        // re-create the old file after rename.
        editorStore.cancelAutoSave(path);

        // Snapshot backlinks BEFORE the rename — the backend clears
        // the old path's backlink entries during rename_file.
        const backlinks = await fetchBacklinks(path);

        await invoke("rename_file", { from: path, to: newPath });

        // Keep open tabs & active file in sync with the new path
        vaultStore.renameFilePath(path, newPath);
        editorStore.renameFileState(path, newPath);

        // Rewrite [[oldName…]] → [[newName…]] in all referencing files
        await updateBacklinksOnFileRename(path, newPath, backlinks);

        await vaultStore.refreshFileTree();
    } catch (e) {
        console.error("Rename failed:", e);
    }
}

/** Cancel rename — called on Escape */
function cancelRename() {
    setRenamingPath(null);
}

// ---------------------------------------------------------------------------
// Sort types
// ---------------------------------------------------------------------------

export type SortMode = "custom" | "name" | "created" | "modified";
export type SortOrder = "asc" | "desc";

interface FileTreeProps {
    entries: VaultEntry[];
    onFileClick: (path: string) => void;
    activePath: string | null;
    depth?: number;
    sortMode?: SortMode;
    sortOrder?: SortOrder;
}

// ---------------------------------------------------------------------------
// Custom file order persistence
// ---------------------------------------------------------------------------

/** dirRelativePath -> ordered list of item names */
type FileOrderMap = Record<string, string[]>;

const [fileOrderMap, setFileOrderMap] = createSignal<FileOrderMap>({});
let fileOrderLoaded = false;

async function loadFileOrder(): Promise<void> {
    if (fileOrderLoaded) return;
    try {
        const r = await invoke<{ content: string }>("read_file", {
            relativePath: ".mindzj/file-order.json",
        });
        const parsed = JSON.parse(r.content);
        if (typeof parsed === "object" && parsed !== null) {
            setFileOrderMap(parsed);
        }
    } catch {
        // File doesn't exist yet — that's fine
    }
    fileOrderLoaded = true;
}

async function saveFileOrder(order: FileOrderMap): Promise<void> {
    setFileOrderMap(order);
    try {
        await invoke("write_file", {
            relativePath: ".mindzj/file-order.json",
            content: JSON.stringify(order, null, 2),
        });
    } catch (e) {
        console.error("Failed to save file order:", e);
    }
}

/** Reset loaded flag when vault changes */
export function resetFileOrder() {
    fileOrderLoaded = false;
    setFileOrderMap({});
}

// ---------------------------------------------------------------------------
// Sort helper
// ---------------------------------------------------------------------------

function sortEntries(entries: VaultEntry[], mode: SortMode, order: SortOrder, dirPath: string = ""): VaultEntry[] {
    const diaryComparator = createDiaryComparator(dirPath);
    if (diaryComparator) {
        const sorted = [...entries];
        sorted.sort(diaryComparator);
        return sorted;
    }

    if (mode === "custom") {
        const orderList = fileOrderMap()[dirPath];
        if (orderList && orderList.length > 0) {
            const sorted = [...entries];
            sorted.sort((a, b) => {
                // Directories always first
                if (a.is_dir && !b.is_dir) return -1;
                if (!a.is_dir && b.is_dir) return 1;

                const idxA = orderList.indexOf(a.name);
                const idxB = orderList.indexOf(b.name);
                // Items not in the order list go to the end
                const posA = idxA === -1 ? Infinity : idxA;
                const posB = idxB === -1 ? Infinity : idxB;
                if (posA !== posB) return posA - posB;
                // Fallback to name sort for items not in the list
                return a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" });
            });
            return sorted;
        }
        return entries;
    }
    const sorted = [...entries];
    sorted.sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        let cmp = 0;
        switch (mode) {
            case "name":
                cmp = a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" });
                break;
            case "created":
            case "modified":
                cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
                break;
        }
        return order === "desc" ? -cmp : cmp;
    });
    return sorted;
}

function createDiaryComparator(dirPath: string) {
    const normalized = dirPath.replace(/\\/g, "/").replace(/\/+$/g, "");
    const isDiaryRoot = normalized === "diary";
    const isDiaryYear = /^diary\/\d{4}$/.test(normalized);
    const isDiaryMonth = /^diary\/\d{4}\/\d{2}$/.test(normalized);
    if (!isDiaryRoot && !isDiaryYear && !isDiaryMonth) return null;

    const readYear = (name: string) => (/^\d{4}$/.test(name) ? Number.parseInt(name, 10) : null);
    const readMonth = (name: string) => (/^\d{2}$/.test(name) ? Number.parseInt(name, 10) : null);
    const readDay = (name: string) =>
        /^(\d{4})-(\d{2})-(\d{2})\.md$/i.test(name)
            ? name.slice(0, 10)
            : null;

    return (a: VaultEntry, b: VaultEntry) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;

        if (isDiaryRoot) {
            const ay = readYear(a.name);
            const by = readYear(b.name);
            if (ay != null && by != null) return by - ay;
            if (ay != null) return -1;
            if (by != null) return 1;
        }

        if (isDiaryYear) {
            const am = readMonth(a.name);
            const bm = readMonth(b.name);
            if (am != null && bm != null) return bm - am;
            if (am != null) return -1;
            if (bm != null) return 1;
        }

        if (isDiaryMonth) {
            const ad = readDay(a.name);
            const bd = readDay(b.name);
            if (ad && bd) return bd.localeCompare(ad);
            if (ad) return -1;
            if (bd) return 1;
        }

        return a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" });
    };
}

// ---------------------------------------------------------------------------
// Global drag state — singleton shared by all FileTree instances
// ---------------------------------------------------------------------------

const [dragSource, setDragSource] = createSignal<{
    path: string;
    isDir: boolean;
    name: string;
    parentDir: string;
} | null>(null);

const [, setDragGhost] = createSignal<HTMLElement | null>(null);
const [dropTargetPath, setDropTargetPath] = createSignal<string | null>(null);

/** "before" | "after" = reorder; "inside" = move into folder */
const [dropPosition, setDropPosition] = createSignal<"before" | "after" | "inside" | null>(null);

function getParentDir(path: string): string {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/");
}

function startDrag(
    e: MouseEvent,
    path: string,
    isDir: boolean,
    name: string,
    el: HTMLElement,
) {
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let ghost: HTMLElement | null = null;

    const onMove = (me: MouseEvent) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (!dragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
            dragging = true;
            setDragSource({ path, isDir, name, parentDir: getParentDir(path) });
            el.style.opacity = "0.4";

            ghost = document.createElement("div");
            ghost.textContent = (isDir ? "\uD83D\uDCC1 " : "\uD83D\uDCC4 ") + name;
            Object.assign(ghost.style, {
                position: "fixed",
                pointerEvents: "none",
                zIndex: "10000",
                background: "var(--mz-bg-secondary, #2b2b2b)",
                color: "var(--mz-text-primary, #ddd)",
                padding: "4px 12px",
                borderRadius: "4px",
                fontSize: "12px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                border: "1px solid var(--mz-border-strong, #555)",
                whiteSpace: "nowrap",
                left: me.clientX + 12 + "px",
                top: me.clientY - 10 + "px",
            });
            document.body.appendChild(ghost);
            setDragGhost(ghost);
        }
        if (dragging && ghost) {
            ghost.style.left = me.clientX + 12 + "px";
            ghost.style.top = me.clientY - 10 + "px";
        }
    };

    const onUp = async (_ue: MouseEvent) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        el.style.opacity = "1";

        if (ghost) {
            ghost.remove();
            setDragGhost(null);
        }

        if (!dragging) return;

        const ds = dragSource();
        const targetPath = dropTargetPath();
        const pos = dropPosition();

        // Clean up all visual indicators
        clearDropIndicators();
        setDragSource(null);
        setDropTargetPath(null);
        setDropPosition(null);

        if (!ds || targetPath === null || !pos) return;

        if (pos === "inside") {
            // Move into folder (original behavior)
            const sourceName = ds.path.split("/").pop() ?? ds.path;
            const destPath = targetPath === "" ? sourceName : `${targetPath}/${sourceName}`;
            if (ds.path !== destPath) {
                if (ds.isDir && destPath.startsWith(ds.path + "/")) return;
                try {
                    await invoke("rename_file", { from: ds.path, to: destPath });
                    await vaultStore.refreshFileTree();
                } catch (err) {
                    console.error("Move failed:", err);
                }
            }
        } else {
            // Reorder: "before" or "after"
            const targetName = targetPath.split("/").pop() ?? targetPath;
            const targetDir = getParentDir(targetPath);

            // Same directory reorder
            if (ds.parentDir === targetDir) {
                await reorderInDir(targetDir, ds.name, targetName, pos);
            } else {
                // Cross-directory: move file first, then reorder
                const destPath = targetDir === "" ? ds.name : `${targetDir}/${ds.name}`;
                if (ds.path !== destPath) {
                    if (ds.isDir && destPath.startsWith(ds.path + "/")) return;
                    try {
                        await invoke("rename_file", { from: ds.path, to: destPath });
                        await reorderInDir(targetDir, ds.name, targetName, pos);
                        await vaultStore.refreshFileTree();
                    } catch (err) {
                        console.error("Move + reorder failed:", err);
                    }
                }
            }
        }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}

/** Reorder item within a directory's custom order */
async function reorderInDir(dirPath: string, sourceName: string, targetName: string, pos: "before" | "after") {
    const currentOrder = { ...fileOrderMap() };
    let orderList = currentOrder[dirPath] ? [...currentOrder[dirPath]] : [];

    // If no existing order, build from current file tree
    if (orderList.length === 0) {
        const entries = findEntriesForDir(dirPath, vaultStore.fileTree());
        if (entries) {
            // Dirs first, then files, alphabetical within each group
            const dirs = entries.filter(e => e.is_dir).map(e => e.name).sort();
            const files = entries.filter(e => !e.is_dir).map(e => e.name).sort();
            orderList = [...dirs, ...files];
        }
    }

    // Remove source from its current position
    orderList = orderList.filter(n => n !== sourceName);

    // Find target position
    const targetIdx = orderList.indexOf(targetName);
    if (targetIdx === -1) {
        orderList.push(sourceName);
    } else if (pos === "before") {
        orderList.splice(targetIdx, 0, sourceName);
    } else {
        orderList.splice(targetIdx + 1, 0, sourceName);
    }

    currentOrder[dirPath] = orderList;
    await saveFileOrder(currentOrder);
}

/** Find VaultEntry[] children for a given directory path */
function findEntriesForDir(dirPath: string, tree: VaultEntry[]): VaultEntry[] | null {
    if (dirPath === "") return tree;
    const parts = dirPath.split("/");
    let current = tree;
    for (const part of parts) {
        const dir = current.find(e => e.is_dir && e.name === part);
        if (!dir || !dir.children) return null;
        current = dir.children;
    }
    return current;
}

function clearDropIndicators() {
    document.querySelectorAll("[data-drop-indicator]").forEach(el => {
        (el as HTMLElement).removeAttribute("data-drop-indicator");
        (el as HTMLElement).style.outline = "";
        (el as HTMLElement).style.outlineOffset = "";
        (el as HTMLElement).style.background = "";
    });
    document.querySelectorAll(".mz-drop-line").forEach(el => el.remove());
}

// Global mousemove for drop target highlighting
let globalMoveHandler: ((e: MouseEvent) => void) | null = null;

function installGlobalDragTracking() {
    if (globalMoveHandler) return;
    globalMoveHandler = (e: MouseEvent) => {
        if (!dragSource()) return;
        const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const dropEl = target?.closest("[data-entry-path]") as HTMLElement | null;

        if (!dropEl) {
            // Over empty area (root) — allow move to root
            const rootEl = target?.closest("[data-drop-path]") as HTMLElement | null;
            if (rootEl && rootEl.getAttribute("data-drop-path") === "") {
                const newPath = "";
                if (dropTargetPath() !== newPath || dropPosition() !== "inside") {
                    clearDropIndicators();
                    rootEl.setAttribute("data-drop-indicator", "true");
                    setDropTargetPath(newPath);
                    setDropPosition("inside");
                }
            } else {
                clearDropIndicators();
                setDropTargetPath(null);
                setDropPosition(null);
            }
            return;
        }

        const entryPath = dropEl.getAttribute("data-entry-path") ?? "";
        const isDir = dropEl.getAttribute("data-entry-is-dir") === "true";
        const ds = dragSource()!;

        // Don't drop on self
        if (ds.path === entryPath) {
            clearDropIndicators();
            setDropTargetPath(null);
            setDropPosition(null);
            return;
        }

        // Compute position: top 30%, middle 40%, bottom 30% for folders
        // top 50%, bottom 50% for files
        const rect = dropEl.getBoundingClientRect();
        const relY = (e.clientY - rect.top) / rect.height;
        let pos: "before" | "inside" | "after";

        if (isDir) {
            if (relY < 0.25) pos = "before";
            else if (relY > 0.75) pos = "after";
            else pos = "inside";
        } else {
            pos = relY < 0.5 ? "before" : "after";
        }

        // Validate: can't drop folder into its own child
        if (pos === "inside" && ds.isDir && entryPath.startsWith(ds.path + "/")) {
            pos = "after"; // Fallback to after
        }

        if (dropTargetPath() !== entryPath || dropPosition() !== pos) {
            clearDropIndicators();

            if (pos === "inside") {
                dropEl.setAttribute("data-drop-indicator", "true");
                dropEl.style.outline = "1px dashed var(--mz-text-muted, #888)";
                dropEl.style.outlineOffset = "-1px";
                dropEl.style.background = "rgba(128,128,128,0.06)";
            } else {
                // Show insertion line — subtle gray, no bright accent
                const line = document.createElement("div");
                line.className = "mz-drop-line";
                Object.assign(line.style, {
                    position: "absolute",
                    left: "8px",
                    right: "8px",
                    height: "1px",
                    background: "var(--mz-text-muted, #888)",
                    opacity: "0.5",
                    borderRadius: "0",
                    pointerEvents: "none",
                    zIndex: "100",
                });

                // Position the line relative to the item
                const parentEl = dropEl.parentElement ?? dropEl;
                if (parentEl.style.position !== "relative" && parentEl.style.position !== "absolute") {
                    parentEl.style.position = "relative";
                }

                const parentRect = parentEl.getBoundingClientRect();
                if (pos === "before") {
                    line.style.top = (rect.top - parentRect.top) + "px";
                } else {
                    line.style.top = (rect.bottom - parentRect.top) + "px";
                }
                parentEl.appendChild(line);
            }

            setDropTargetPath(entryPath);
            setDropPosition(pos);
        }
    };
    document.addEventListener("mousemove", globalMoveHandler);
}

// ---------------------------------------------------------------------------
// Sort bar component
// ---------------------------------------------------------------------------

const SORT_OPTIONS: { value: SortMode; key: string }[] = [
    { value: "custom", key: "sort.default" },
    { value: "name", key: "sort.name" },
    { value: "created", key: "sort.created" },
    { value: "modified", key: "sort.modified" },
];

export const SortBar: Component<{
    mode: SortMode;
    order: SortOrder;
    onModeChange: (m: SortMode) => void;
    onOrderChange: (o: SortOrder) => void;
}> = (props) => {
    const [showDropdown, setShowDropdown] = createSignal(false);
    const currentLabel = () => { const option = SORT_OPTIONS.find(o => o.value === props.mode); return option ? t(option.key) : t("sort.label"); };

    return (
        <div style={{ position: "relative", display: "flex", "align-items": "center", gap: "2px" }}>
            <button
                onClick={() => setShowDropdown(v => !v)}
                title={t("sort.label")}
                style={{
                    display: "flex", "align-items": "center", gap: "4px",
                    height: "28px", padding: "0 8px",
                    border: "none", "border-radius": "var(--mz-radius-sm)",
                    background: "transparent", color: "var(--mz-text-muted)",
                    cursor: "pointer", "font-size": "var(--mz-font-size-xs)",
                    "font-family": "var(--mz-font-sans)", "white-space": "nowrap",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; e.currentTarget.style.color = "var(--mz-text-primary)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--mz-text-muted)"; }}
            >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18M3 12h12M3 18h6" />
                </svg>
                {currentLabel()}
            </button>
            <button
                onClick={() => props.onOrderChange(props.order === "asc" ? "desc" : "asc")}
                title={props.order === "asc" ? t("sort.orderAsc") : t("sort.orderDesc")}
                style={{
                    width: "28px", height: "28px",
                    display: "flex", "align-items": "center", "justify-content": "center",
                    border: "none", "border-radius": "var(--mz-radius-sm)",
                    background: "transparent", color: "var(--mz-text-muted)",
                    cursor: "pointer", "flex-shrink": "0",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; e.currentTarget.style.color = "var(--mz-text-primary)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--mz-text-muted)"; }}
            >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round"
                    style={{ transform: props.order === "desc" ? "rotate(180deg)" : "none", transition: "transform 200ms" }}>
                    <path d="M12 5v14M19 12l-7 7-7-7" />
                </svg>
            </button>
            <Show when={showDropdown()}>
                <div
                    style={{
                        position: "absolute", top: "100%", left: "0",
                        "min-width": "140px", "margin-top": "2px",
                        background: "var(--mz-bg-secondary)",
                        border: "1px solid var(--mz-border-strong)",
                        "border-radius": "var(--mz-radius-md)",
                        "box-shadow": "0 4px 16px rgba(0,0,0,0.2)",
                        padding: "4px 0", "z-index": "100",
                    }}
                    onMouseLeave={() => setShowDropdown(false)}
                >
                    <For each={SORT_OPTIONS}>
                        {(opt) => (
                            <button
                                onClick={() => { props.onModeChange(opt.value); setShowDropdown(false); }}
                                style={{
                                    display: "flex", "align-items": "center", "justify-content": "space-between",
                                    width: "100%", padding: "6px 12px", border: "none",
                                    background: props.mode === opt.value ? "var(--mz-bg-active)" : "transparent",
                                    color: props.mode === opt.value ? "var(--mz-accent)" : "var(--mz-text-primary)",
                                    cursor: "pointer", "font-size": "var(--mz-font-size-xs)",
                                    "font-family": "var(--mz-font-sans)", "text-align": "left",
                                }}
                                onMouseEnter={e => { if (props.mode !== opt.value) e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
                                onMouseLeave={e => { if (props.mode !== opt.value) e.currentTarget.style.background = "transparent"; }}
                            >
                                {t(opt.key)}
                                <Show when={props.mode === opt.value}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--mz-accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M20 6L9 17l-5-5" />
                                    </svg>
                                </Show>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
};

// ---------------------------------------------------------------------------
// FileTree root
// ---------------------------------------------------------------------------

export const FileTree: Component<FileTreeProps> = (props) => {
    const [menu, setMenu] = createSignal<{ show: boolean; x: number; y: number; items: MenuItem[] }>({
        show: false, x: 0, y: 0, items: [],
    });

    const sortMode = () => props.sortMode ?? "custom";
    const sortOrder = () => props.sortOrder ?? "asc";
    const dirPath = () => {
        // Root level
        if (!props.depth || props.depth === 0) return "";
        // For nested levels, we need the parent dir path - derived from first entry
        const first = props.entries[0];
        if (!first) return "";
        return getParentDir(first.relative_path);
    };
    const sortedEntries = () => sortEntries(props.entries, sortMode(), sortOrder(), dirPath());

    // Install global drag tracking once & load file order
    installGlobalDragTracking();
    onMount(() => { loadFileOrder(); });

    createEffect(() => {
        if ((props.depth ?? 0) !== 0) return;
        syncRegisteredFolders(props.entries, props.depth ?? 0);
    });

    async function showInExplorer(path: string) {
        try {
            const { Command } = await import("@tauri-apps/plugin-shell");
            const fullPath = `${vaultStore.vaultInfo()?.path ?? ""}/${path}`.replace(/\//g, "\\");
            await Command.create("explorer", ["/select,", fullPath]).execute();
        } catch (e) {
            console.error("Open in explorer failed:", e);
            navigator.clipboard.writeText(path).catch(() => {});
        }
    }

    /** Reusable rename trigger — activates inline rename input */
    function renameEntry(path: string, isDir: boolean) {
        startInlineRename(path, isDir);
    }

    // Listen for global F2 rename event from App.tsx
    onMount(() => {
        const handleRenameEvent = () => {
            const active = props.activePath;
            if (!active) return;
            const entry = props.entries.find((en) => en.relative_path === active);
            renameEntry(active, entry?.is_dir ?? false);
        };
        document.addEventListener("mindzj:rename-active-file", handleRenameEvent);
        onCleanup(() => document.removeEventListener("mindzj:rename-active-file", handleRenameEvent));
    });

    function showContextForFile(e: MouseEvent, path: string, isDir: boolean) {
        e.preventDefault();
        e.stopPropagation();
        const dirPath = isDir ? path : path.split("/").slice(0, -1).join("/") || "";
        const name = path.split("/").pop() ?? path;
        const items: MenuItem[] = [];
        if (!isDir) {
            items.push({ label: t("context.open"), icon: "\uD83D\uDCC4", action: () => { void openFileRouted(path); } });
        }
        items.push({
            label: t("context.newNote"), icon: "\u270F\uFE0F",
            action: async () => {
                const n = await promptDialog(t("fileTree.noteNamePrompt"), t("fileTree.newNoteDefault"));
                if (!n) return;
                const fileName = n.endsWith(".md") ? n : `${n}.md`;
                const p = dirPath ? `${dirPath}/${fileName}` : fileName;
                await vaultStore.createFile(p, "");
                await vaultStore.openFile(p);
            },
        });
        items.push({
            label: t("context.newFolder"), icon: "\uD83D\uDCC1",
            action: async () => { const n = await promptDialog(t("fileTree.folderNamePrompt")); if (n) await vaultStore.createDir(dirPath ? `${dirPath}/${n}` : n); },
        });
        items.push({
            label: t("context.newMindMap"), icon: "\uD83D\uDDFA\uFE0F", separator: true,
            action: async () => {
                const n = await promptDialog(t("fileTree.mindzjFileNamePrompt"), t("fileTree.newMindzjDefault"));
                if (!n) return;
                const fileName = n.endsWith(".mindzj") ? n : `${n}.mindzj`;
                const p = dirPath ? `${dirPath}/${fileName}` : fileName;
                await vaultStore.createFile(p, `{"type":"mindzj","version":"0.1.0","nodes":[],"edges":[]}`);
                await vaultStore.openFile(p);
            },
        });
        items.push({
            label: t("context.rename"), icon: "\u270E", separator: true,
            action: () => renameEntry(path, isDir),
        });
        items.push({ label: t("context.showInExplorer"), icon: "\uD83D\uDCC2", action: () => showInExplorer(path) });
        items.push({
            label: t("context.delete"), icon: "\uD83D\uDDD1", danger: true, separator: true,
            action: async () => {
                const yes = await confirmDialog(t("fileTree.deleteConfirm", { name }));
                if (!yes) return;
                if (isDir) {
                    await vaultStore.deleteDir(path);
                    editorStore.removeFileState(path, true);
                    return;
                }
                await vaultStore.deleteFile(path);
                editorStore.removeFileState(path, false);
            },
        });
        setMenu({ show: true, x: e.clientX, y: e.clientY, items });
    }

    function showContextForEmpty(e: MouseEvent) {
        e.preventDefault();
        setMenu({
            show: true, x: e.clientX, y: e.clientY,
            items: [
                { label: t("context.newNote"), icon: "\u270F\uFE0F", action: async () => {
                    const n = await promptDialog(t("fileTree.noteNamePrompt"), t("fileTree.newNoteDefault"));
                if (!n) return;
                const fileName = n.endsWith(".md") ? n : `${n}.md`;
                    await vaultStore.createFile(fileName, "");
                    await vaultStore.openFile(fileName);
                }},
                { label: t("context.newFolder"), icon: "\uD83D\uDCC1", action: async () => { const n = await promptDialog(t("fileTree.folderNamePrompt")); if (n) await vaultStore.createDir(n); }},
                { label: t("context.newMindMap"), icon: "\uD83D\uDDFA\uFE0F", action: async () => {
                    const n = await promptDialog(t("fileTree.mindzjFileNamePrompt"), t("fileTree.newMindzjDefault"));
                    if (!n) return;
                    const fileName = n.endsWith(".mindzj") ? n : `${n}.mindzj`;
                    await vaultStore.createFile(fileName, `{"type":"mindzj","version":"0.1.0","nodes":[],"edges":[]}`);
                    // Open the newly-created file so it is both the
                    // active file (highlighted in the tree) and shown
                    // in the editor area. The new-note (.md) branch
                    // above does the same thing.
                    await vaultStore.openFile(fileName);
                }},
            ],
        });
    }

    return (
        <div
            data-drop-path=""
            style={{ "user-select": "none", "min-height": "100%", position: "relative" }}
            onContextMenu={showContextForEmpty}
        >
            <For each={sortedEntries()}>
                {(entry) => (
                    <Show
                        when={entry.is_dir}
                        fallback={
                            <FileItem
                                entry={entry}
                                onClick={() => props.onFileClick(entry.relative_path)}
                                onContextMenu={(e) => showContextForFile(e, entry.relative_path, false)}
                                isActive={props.activePath === entry.relative_path}
                                depth={props.depth ?? 0}
                            />
                        }>
                        <FolderItem
                            entry={entry}
                            onFileClick={props.onFileClick}
                            onContextMenu={(e) => showContextForFile(e, entry.relative_path, true)}
                            activePath={props.activePath}
                            depth={props.depth ?? 0}
                            sortMode={sortMode()}
                            sortOrder={sortOrder()}
                        />
                    </Show>
                )}
            </For>
            <Show when={menu().show}>
                <ContextMenu
                    x={menu().x} y={menu().y} items={menu().items}
                    onClose={() => setMenu((p) => ({ ...p, show: false }))}
                />
            </Show>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Folder item with mouse-based drag
// ---------------------------------------------------------------------------

const FolderItem: Component<{
    entry: VaultEntry;
    onFileClick: (p: string) => void;
    onContextMenu: (e: MouseEvent) => void;
    activePath: string | null;
    depth: number;
    sortMode: SortMode;
    sortOrder: SortOrder;
}> = (props) => {
    const isOpen = () => getFolderOpen(props.entry.relative_path, props.depth);
    const pad = () => `${12 + props.depth * 16}px`;

    return (
        <div style={{ position: "relative" }}>
            <div
                data-entry-path={props.entry.relative_path}
                data-entry-is-dir="true"
                data-drop-path={props.entry.relative_path}
                onMouseDown={(e) => {
                    if (e.button === 0) startDrag(e, props.entry.relative_path, true, props.entry.name, e.currentTarget);
                }}
                onClick={() =>
                    setFolderOpen(props.entry.relative_path, props.depth, !isOpen())
                }
                onContextMenu={props.onContextMenu}
                style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "4px",
                    padding: `3px 8px 3px ${pad()}`,
                    cursor: "pointer",
                    "font-size": "var(--mz-font-size-sm)",
                    color: "var(--mz-text-secondary)",
                    "border-radius": "var(--mz-radius-sm)",
                    transition: "background 80ms",
                }}
                onMouseEnter={(e) => { if (!dragSource()) e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
                onMouseLeave={(e) => { if (!dragSource()) e.currentTarget.style.background = ""; }}
            >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                    style={{ transform: isOpen() ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms", "flex-shrink": "0", "pointer-events": "none" }}>
                    <path d="M4 2.5L7.5 6L4 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ "flex-shrink": "0", "pointer-events": "none" }}>
                    <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.17a1.5 1.5 0 011.06.44L8.5 4.7a.5.5 0 00.35.15H12.5c.83 0 1.5.67 1.5 1.5v5.15c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 012 11.5V4.5z"
                        fill={isOpen() ? "var(--mz-accent)" : "var(--mz-text-muted)"} opacity={isOpen() ? "0.7" : "0.5"} />
                </svg>
                <Show when={renamingPath() === props.entry.relative_path}
                    fallback={
                        <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "pointer-events": "none" }}>
                            {props.entry.name}
                        </span>
                    }>
                    <input
                        ref={(el) => { setTimeout(() => { el.focus(); el.select(); }, 0); }}
                        value={renamingName()}
                        onInput={(e) => setRenamingName(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") { e.preventDefault(); confirmRename(); }
                            if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                        }}
                        onBlur={() => confirmRename()}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                            flex: "1",
                            "min-width": "0",
                            background: "var(--mz-bg-primary)",
                            color: "var(--mz-text-primary)",
                            border: "1px solid var(--mz-accent)",
                            "border-radius": "var(--mz-radius-sm)",
                            padding: "0 4px",
                            "font-size": "inherit",
                            "font-family": "inherit",
                            outline: "none",
                        }}
                    />
                </Show>
            </div>
            <Show when={isOpen() && props.entry.children}>
                <FileTree
                    entries={props.entry.children!}
                    onFileClick={props.onFileClick}
                    activePath={props.activePath}
                    depth={props.depth + 1}
                    sortMode={props.sortMode}
                    sortOrder={props.sortOrder}
                />
            </Show>
        </div>
    );
};

// ---------------------------------------------------------------------------
// File item with mouse-based drag
// ---------------------------------------------------------------------------

const FileItem: Component<{
    entry: VaultEntry;
    onClick: () => void;
    onContextMenu: (e: MouseEvent) => void;
    isActive: boolean;
    depth: number;
}> = (props) => {
    const pad = () => `${28 + props.depth * 16}px`;
    const isMindZJ = () => props.entry.extension === "mindzj";

    return (
        <div
            data-entry-path={props.entry.relative_path}
            data-entry-is-dir="false"
            onMouseDown={(e) => {
                if (e.button === 0) startDrag(e, props.entry.relative_path, false, props.entry.name, e.currentTarget);
            }}
            onClick={props.onClick}
            onContextMenu={props.onContextMenu}
            style={{
                display: "flex",
                "align-items": "center",
                gap: "6px",
                padding: `3px 8px 3px ${pad()}`,
                cursor: "pointer",
                "font-size": "var(--mz-font-size-sm)",
                color: props.isActive ? "var(--mz-text-primary)" : "var(--mz-text-secondary)",
                background: props.isActive ? "var(--mz-bg-active)" : "transparent",
                "border-radius": "var(--mz-radius-sm)",
                transition: "background 80ms",
            }}
            onMouseEnter={(e) => { if (!props.isActive && !dragSource()) e.currentTarget.style.background = "var(--mz-bg-hover)"; }}
            onMouseLeave={(e) => { if (!props.isActive && !dragSource()) e.currentTarget.style.background = ""; }}
        >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ "flex-shrink": "0", "pointer-events": "none" }}>
                <path d="M4 1.5h5.586a1 1 0 01.707.293l2.914 2.914a1 1 0 01.293.707V13.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-11a1 1 0 011-1z"
                    stroke={isMindZJ() ? "var(--mz-success)" : "var(--mz-accent)"} stroke-width="1" fill="none" />
                <path d="M9.5 1.5V5h3.5" stroke={isMindZJ() ? "var(--mz-success)" : "var(--mz-accent)"} stroke-width="1" fill="none" />
            </svg>
            <Show when={renamingPath() === props.entry.relative_path}
                fallback={
                    <>
                        <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", flex: "1", "pointer-events": "none" }}>
                            {displayName(props.entry.name)}
                        </span>
                        <Show when={isMindZJ()}>
                            <span style={{ "font-size": "9px", color: "var(--mz-text-muted)", "flex-shrink": "0", "text-transform": "uppercase", "font-weight": "600", "letter-spacing": "0.5px", "pointer-events": "none" }}>
                                MINDZJ
                            </span>
                        </Show>
                    </>
                }>
                <input
                    ref={(el) => { setTimeout(() => { el.focus(); el.select(); }, 0); }}
                    value={renamingName()}
                    onInput={(e) => setRenamingName(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") { e.preventDefault(); confirmRename(); }
                        if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                    }}
                    onBlur={() => confirmRename()}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{
                        flex: "1",
                        "min-width": "0",
                        background: "var(--mz-bg-primary)",
                        color: "var(--mz-text-primary)",
                        border: "1px solid var(--mz-accent)",
                        "border-radius": "var(--mz-radius-sm)",
                        padding: "0 4px",
                        "font-size": "inherit",
                        "font-family": "inherit",
                        outline: "none",
                    }}
                />
            </Show>
        </div>
    );
};
