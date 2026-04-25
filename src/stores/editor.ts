import { createSignal, createRoot } from "solid-js";
import { vaultStore } from "./vault";
import {
  extractHeadings,
  findRenamedHeadings,
  findRenamedAnchors,
  collectReferencedAnchors,
  updateBacklinksOnHeadingRename,
} from "../utils/linkUpdater";

export type ViewMode = "source" | "live-preview" | "reading";
type EditableViewMode = Exclude<ViewMode, "reading">;
type FileScrollPositionMap = Record<string, Partial<Record<ViewMode, number>>>;
type FileTopLineMap = Record<string, number>;
type FileViewModeMap = Record<string, ViewMode>;
type FileEditableViewModeMap = Record<string, EditableViewMode>;
type FileCursorSelectionMap = Record<string, { anchor: number; head: number }>;
type PendingExternalEdit = { before: string; after: string };

export interface EditorWorkspaceState {
  file_scroll_positions?: FileScrollPositionMap;
  file_top_lines?: FileTopLineMap;
  file_view_modes?: FileViewModeMap;
  file_last_non_reading_view_modes?: FileEditableViewModeMap;
}

function createEditorStore() {
  const [fallbackViewMode, setFallbackViewMode] = createSignal<ViewMode>("live-preview");
  const [fallbackLastNonReadingViewMode, setFallbackLastNonReadingViewMode] =
    createSignal<EditableViewMode>("live-preview");
  const [wordCount, setWordCount] = createSignal(0);
  const [charCount, setCharCount] = createSignal(0);
  const [cursorLine, setCursorLine] = createSignal(1);
  const [cursorCol, setCursorCol] = createSignal(1);
  // Per-file dirty tracking. Previously this was a single global boolean, so
  // the unsaved-dot rendered on whatever tab happened to be active — even if
  // that tab had no pending changes. Using a Set keyed by file path keeps the
  // indicator attached to the tab that actually has unsaved content.
  const [dirtyPaths, setDirtyPaths] = createSignal<Set<string>>(new Set());
  const [editorZoom, setEditorZoom] = createSignal(100); // percentage
  const [uiZoom, setUiZoomSignal] = createSignal(100); // percentage
  // Last cursor line (1-based) — stashed when switching view modes so the
  // new mode can scroll to the same place the user was editing.
  const [lastScrollLine, setLastScrollLine] = createSignal<number | null>(null);
  const [fileScrollPositions, setFileScrollPositions] =
    createSignal<FileScrollPositionMap>({});
  const [fileTopLines, setFileTopLines] = createSignal<FileTopLineMap>({});
  const [fileCursorSelections, setFileCursorSelections] =
    createSignal<FileCursorSelectionMap>({});
  const [fileViewModes, setFileViewModes] = createSignal<FileViewModeMap>({});
  const [fileLastNonReadingViewModes, setFileLastNonReadingViewModes] =
    createSignal<FileEditableViewModeMap>({});

  function activeFilePath(): string | null {
    return vaultStore.activeFile()?.path ?? null;
  }

  function normalizeEditableViewMode(mode: ViewMode): EditableViewMode {
    return mode === "source" ? "source" : "live-preview";
  }

  function getDefaultEditableViewMode(): EditableViewMode {
    return normalizeEditableViewMode(fallbackViewMode());
  }

  function getViewModeForFile(path: string | null | undefined): ViewMode {
    if (!path) return fallbackViewMode();
    return fileViewModes()[path] ?? fallbackViewMode();
  }

  function getLastNonReadingViewModeForFile(
    path: string | null | undefined,
  ): EditableViewMode {
    if (!path) return fallbackLastNonReadingViewMode();
    return fileLastNonReadingViewModes()[path] ?? getDefaultEditableViewMode();
  }

  function viewMode(): ViewMode {
    return getViewModeForFile(activeFilePath());
  }

  function lastNonReadingViewMode(): EditableViewMode {
    return getLastNonReadingViewModeForFile(activeFilePath());
  }

  function markDirty(path: string) {
    setDirtyPaths((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }
  function clearDirty(path: string) {
    setDirtyPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }
  function isDirtyPath(path: string | null | undefined): boolean {
    if (!path) return false;
    return dirtyPaths().has(path);
  }
  // Backwards-compat: "is anything dirty" — used by some global UI bits.
  function isDirty(): boolean {
    const active = vaultStore.activeFile();
    return active ? dirtyPaths().has(active.path) : false;
  }

  // Auto-save timers, keyed by file path so each tab can debounce
  // independently.
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Latest content each pending auto-save is about to write. Kept in
  // sync with `saveTimers` — every `scheduleAutoSave` call overwrites
  // the entry so the Map always holds the MOST RECENT content the
  // user typed. Needed by `flushAllPendingSaves` below: the setTimeout
  // callback owns the content via closure, which isn't reachable from
  // the outside, so we mirror it here.
  const pendingSaveContent = new Map<string, string>();

  // ── Heading & anchor tracking for backlink updates ──
  // Stores the last-known headings per file and the list of anchors
  // that other files reference.  After every auto-save we compare
  // headings and anchors; if any changed we rewrite wiki-link refs.
  const _fileHeadings = new Map<string, string[]>();
  const _fileContent   = new Map<string, string>();       // raw content at last snapshot
  const _fileAnchors   = new Map<string, string[]>();     // anchors referenced by other files

  // ── Undo/redo history persistence across editor rebuilds ──
  // CodeMirror's history lives in its EditorState. Rebuilding the
  // EditorView (view-mode switch, line-numbers toggle, reading-mode
  // toggle that unmounts Editor entirely) wipes that state, so
  // Ctrl+Z stops working. We snapshot the serialized history before
  // every rebuild/unmount and restore it on the next creation —
  // keyed by file path so split panes / tab switches keep their own
  // histories. Entries are consumed (cleared) on successful restore
  // to prevent stale snapshots from being re-applied to a state that
  // already owns the current history.
  const _fileHistoryStates = new Map<string, any>();
  const _pendingExternalEdits = new Map<string, PendingExternalEdit[]>();

  // Bound on the history-state cache so long sessions that open many
  // unique files (e.g. clicking through hundreds of global-search
  // results) don't accumulate multi-megabyte serialized CM6 history
  // snapshots until the WebView2 tab OOMs. Map iteration order is
  // insertion order in JS, and `setFileHistoryState` re-inserts by
  // delete+set for any path already tracked, so trimming the OLDEST
  // entry when we're over budget gives us effectively LRU-by-write
  // semantics without an extra data structure.
  const MAX_HISTORY_ENTRIES = 50;

  function setFileHistoryState(path: string, state: any): void {
    if (!path || state == null) return;
    // Re-insert so this path becomes the "newest" in iteration order —
    // keeps the most recently persisted file from being trimmed next.
    if (_fileHistoryStates.has(path)) {
      _fileHistoryStates.delete(path);
    }
    _fileHistoryStates.set(path, state);
    while (_fileHistoryStates.size > MAX_HISTORY_ENTRIES) {
      const oldest = _fileHistoryStates.keys().next().value;
      if (oldest === undefined) break;
      _fileHistoryStates.delete(oldest);
    }
  }

  function getFileHistoryState(path: string | null | undefined): any | null {
    if (!path) return null;
    return _fileHistoryStates.get(path) ?? null;
  }

  function clearFileHistoryState(path: string | null | undefined): void {
    if (!path) return;
    _fileHistoryStates.delete(path);
  }

  function recordExternalEdit(path: string, before: string, after: string): void {
    if (!path || before === after) return;
    const current = _pendingExternalEdits.get(path) ?? [];
    const last = current[current.length - 1];
    if (last && last.after !== before) {
      _pendingExternalEdits.set(path, [{ before, after }]);
      return;
    }
    _pendingExternalEdits.set(path, [...current, { before, after }]);
  }

  function discardExternalEdit(path: string, before: string, after: string): void {
    const current = _pendingExternalEdits.get(path);
    if (!current) return;
    const idx = current.findIndex(
      (edit) => edit.before === before && edit.after === after,
    );
    if (idx < 0) return;
    const next = current.slice(0, idx).concat(current.slice(idx + 1));
    if (next.length === 0) {
      _pendingExternalEdits.delete(path);
    } else {
      _pendingExternalEdits.set(path, next);
    }
  }

  function takePendingExternalEdits(
    path: string | null | undefined,
    currentContent: string,
  ): PendingExternalEdit[] {
    if (!path) return [];
    const edits = _pendingExternalEdits.get(path);
    if (!edits || edits.length === 0) return [];

    let expected = edits[0].before;
    for (const edit of edits) {
      if (edit.before !== expected) {
        _pendingExternalEdits.delete(path);
        return [];
      }
      expected = edit.after;
    }

    if (expected !== currentContent) {
      _pendingExternalEdits.delete(path);
      return [];
    }

    _pendingExternalEdits.delete(path);
    return edits;
  }

  /** Snapshot headings + content of a file (call when opening a view). */
  function storeHeadings(path: string, content: string) {
    _fileHeadings.set(path, extractHeadings(content));
    _fileContent.set(path, content);
    // Load referenced anchors in the background (non-blocking)
    collectReferencedAnchors(path)
      .then((a) => _fileAnchors.set(path, a))
      .catch(() => {});
  }

  /** Compare headings & anchors after save and update backlinks. */
  function checkHeadingChanges(path: string, content: string) {
    // ── 1. Heading-level comparison ──
    const newH = extractHeadings(content);
    const oldH = _fileHeadings.get(path);
    if (oldH) {
      const renamed = findRenamedHeadings(oldH, newH);
      for (const [oldText, newText] of renamed) {
        updateBacklinksOnHeadingRename(path, oldText, newText).catch(() => {});
      }
    }
    _fileHeadings.set(path, newH);

    // ── 2. Anchor-level comparison (Ctrl+Alt+C/V marks) ──
    const oldContent = _fileContent.get(path);
    const anchors = _fileAnchors.get(path);
    if (oldContent && anchors && anchors.length > 0) {
      const renamedAnchors = findRenamedAnchors(anchors, oldContent, content);
      for (const [oldA, newA] of renamedAnchors) {
        updateBacklinksOnHeadingRename(path, oldA, newA).catch(() => {});
      }
      // Refresh anchor list after updates
      if (renamedAnchors.length > 0) {
        collectReferencedAnchors(path)
          .then((a) => _fileAnchors.set(path, a))
          .catch(() => {});
      }
    }
    _fileContent.set(path, content);
  }

  // Schedule auto-save after edits (2 second debounce)
  function scheduleAutoSave(relativePath: string, content: string) {
    markDirty(relativePath);
    pendingSaveContent.set(relativePath, content);

    const existing = saveTimers.get(relativePath);
    if (existing) clearTimeout(existing);

    const t = setTimeout(async () => {
      saveTimers.delete(relativePath);
      pendingSaveContent.delete(relativePath);
      try {
        const saved = await vaultStore.saveFile(relativePath, content, {
          updateState: false,
        });
        const newerPending = pendingSaveContent.get(relativePath);
        if (newerPending == null || newerPending === content) {
          vaultStore.applySavedFileContent(saved);
          clearDirty(relativePath);
          // After a successful save, check if any headings were renamed
          // and update wiki-link references across the vault.
          checkHeadingChanges(relativePath, content);
        }
      } catch (e) {
        console.error("Auto-save failed:", e);
      }
    }, 2000);
    saveTimers.set(relativePath, t);
  }

  // Cancel a pending auto-save and clear dirty state (e.g. before rename)
  function cancelAutoSave(path: string) {
    const timer = saveTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      saveTimers.delete(path);
    }
    pendingSaveContent.delete(path);
    clearDirty(path);
  }

  // Force immediate save
  async function forceSave(
    relativePath: string,
    content: string,
    options?: { suppressSavedEvent?: boolean },
  ) {
    const existing = saveTimers.get(relativePath);
    if (existing) {
      clearTimeout(existing);
      saveTimers.delete(relativePath);
    }
    pendingSaveContent.delete(relativePath);
    try {
      await vaultStore.saveFile(relativePath, content, {
        suppressSavedEvent: options?.suppressSavedEvent,
      });
      clearDirty(relativePath);
    } catch (e) {
      console.error("Force save failed:", e);
      throw e;
    }
  }

  /**
   * Immediately flush every pending auto-save to disk, bypassing the
   * 2-second debounce. Called from the window-close handler so the
   * user doesn't lose the last few keystrokes when they close the app
   * within the debounce window.
   *
   * Uses `pendingSaveContent` as the source of truth for each path's
   * latest content — the running setTimeout callback captures the
   * same string via closure but isn't externally invocable, so we
   * mirror it on each `scheduleAutoSave` call and read it back here.
   *
   * All writes are awaited in parallel. Individual failures are
   * logged but don't short-circuit the batch: we'd rather save 9 of
   * 10 tabs than lose all 10 because one write errored.
   */
  async function flushAllPendingSaves(): Promise<void> {
    const entries = Array.from(pendingSaveContent.entries());
    if (entries.length === 0) return;

    const saves = entries.map(([path, content]) => {
      const timer = saveTimers.get(path);
      if (timer) {
        clearTimeout(timer);
        saveTimers.delete(path);
      }
      pendingSaveContent.delete(path);
      return vaultStore
        .saveFile(path, content)
        .then(() => {
          clearDirty(path);
          checkHeadingChanges(path, content);
        })
        .catch((e) => {
          console.error("Flush save failed for", path, e);
        });
    });
    await Promise.all(saves);
  }

  // Update content stats
  function updateStats(content: string) {
    const words = content
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
    setWordCount(words);
    setCharCount(content.length);
  }

  function setDefaultViewMode(mode: ViewMode) {
    setFallbackViewMode(mode);
    if (mode !== "reading") {
      setFallbackLastNonReadingViewMode(normalizeEditableViewMode(mode));
    }
  }

  function setViewMode(mode: ViewMode, path = activeFilePath()) {
    if (!path) {
      setDefaultViewMode(mode);
      return;
    }
    if (mode !== "reading") {
      const editableMode = normalizeEditableViewMode(mode);
      setFileLastNonReadingViewModes((prev) =>
        prev[path] === editableMode ? prev : { ...prev, [path]: editableMode },
      );
    }
    setFileViewModes((prev) =>
      prev[path] === mode ? prev : { ...prev, [path]: mode },
    );
  }

  function toggleReadingMode(path = activeFilePath()) {
    const current = getViewModeForFile(path);
    if (current === "reading") {
      setViewMode(getLastNonReadingViewModeForFile(path), path);
      return;
    }

    const editableMode = normalizeEditableViewMode(current);
    if (path) {
      setFileLastNonReadingViewModes((prev) =>
        prev[path] === editableMode ? prev : { ...prev, [path]: editableMode },
      );
    } else {
      setFallbackLastNonReadingViewMode(editableMode);
    }
    setViewMode("reading", path);
  }

  function setFileScrollPosition(path: string, mode: ViewMode, scrollTop: number) {
    if (!path || !Number.isFinite(scrollTop)) return;
    const normalized = Math.max(0, Math.round(scrollTop));
    setFileScrollPositions((prev) => {
      if (prev[path]?.[mode] === normalized) return prev;
      return {
        ...prev,
        [path]: {
          ...(prev[path] ?? {}),
          [mode]: normalized,
        },
      };
    });
  }

  function getFileScrollPosition(
    path: string | null | undefined,
    mode: ViewMode,
  ): number | null {
    if (!path) return null;
    const value = fileScrollPositions()[path]?.[mode];
    return typeof value === "number" ? value : null;
  }

  function setFileTopLine(path: string, line: number | null) {
    if (!path || line == null || !Number.isFinite(line)) return;
    const normalized = Math.max(1, Math.round(line));
    setLastScrollLine(normalized);
    setFileTopLines((prev) => {
      if (prev[path] === normalized) return prev;
      return {
        ...prev,
        [path]: normalized,
      };
    });
  }

  function getFileTopLine(path: string | null | undefined): number | null {
    if (path) {
      const value = fileTopLines()[path];
      if (typeof value === "number") return value;
    }
    return lastScrollLine();
  }

  function setFileCursorSelection(
    path: string | null | undefined,
    selection: { anchor: number; head: number } | null,
  ) {
    if (!path || !selection) return;
    if (
      !Number.isFinite(selection.anchor) ||
      !Number.isFinite(selection.head)
    ) {
      return;
    }
    const anchor = Math.max(0, Math.round(selection.anchor));
    const head = Math.max(0, Math.round(selection.head));
    setFileCursorSelections((prev) => {
      const current = prev[path];
      if (current?.anchor === anchor && current?.head === head) return prev;
      return { ...prev, [path]: { anchor, head } };
    });
  }

  function getFileCursorSelection(path: string | null | undefined) {
    if (!path) return null;
    return fileCursorSelections()[path] ?? null;
  }

  // Toggle view mode: source → live-preview → reading → source
  function cycleViewMode(path = activeFilePath()) {
    switch (getViewModeForFile(path)) {
      case "source":
        setViewMode("live-preview", path);
        break;
      case "live-preview":
        if (path) {
          setFileLastNonReadingViewModes((prev) =>
            prev[path] === "live-preview"
              ? prev
              : { ...prev, [path]: "live-preview" },
          );
        } else {
          setFallbackLastNonReadingViewMode("live-preview");
        }
        setViewMode("reading", path);
        break;
      case "reading":
        setViewMode("source", path);
        break;
    }
  }

  function restoreWorkspaceState(state?: EditorWorkspaceState | null) {
    setFileScrollPositions({ ...(state?.file_scroll_positions ?? {}) });
    setFileTopLines({ ...(state?.file_top_lines ?? {}) });
    setFileViewModes({ ...(state?.file_view_modes ?? {}) });
    setFileLastNonReadingViewModes({
      ...(state?.file_last_non_reading_view_modes ?? {}),
    });
  }

  function resetWorkspaceState() {
    setFileScrollPositions({});
    setFileTopLines({});
    setFileCursorSelections({});
    setFileViewModes({});
    setFileLastNonReadingViewModes({});
    setLastScrollLine(null);
    setFallbackViewMode("live-preview");
    setFallbackLastNonReadingViewMode("live-preview");
    _fileHistoryStates.clear();
    _pendingExternalEdits.clear();
  }

  function renameFileState(oldPath: string, newPath: string) {
    if (!oldPath || !newPath || oldPath === newPath) return;

    setFileScrollPositions((prev) => {
      if (!(oldPath in prev)) return prev;
      const next = { ...prev };
      next[newPath] = next[oldPath]!;
      delete next[oldPath];
      return next;
    });
    setFileTopLines((prev) => {
      if (!(oldPath in prev)) return prev;
      const next = { ...prev };
      next[newPath] = next[oldPath]!;
      delete next[oldPath];
      return next;
    });
    setFileCursorSelections((prev) => {
      if (!(oldPath in prev)) return prev;
      const next = { ...prev };
      next[newPath] = next[oldPath]!;
      delete next[oldPath];
      return next;
    });
    setFileViewModes((prev) => {
      if (!(oldPath in prev)) return prev;
      const next = { ...prev };
      next[newPath] = next[oldPath]!;
      delete next[oldPath];
      return next;
    });
    setFileLastNonReadingViewModes((prev) => {
      if (!(oldPath in prev)) return prev;
      const next = { ...prev };
      next[newPath] = next[oldPath]!;
      delete next[oldPath];
      return next;
    });
    setDirtyPaths((prev) => {
      if (!prev.has(oldPath)) return prev;
      const next = new Set(prev);
      next.delete(oldPath);
      next.add(newPath);
      return next;
    });
    if (_fileHistoryStates.has(oldPath)) {
      _fileHistoryStates.set(newPath, _fileHistoryStates.get(oldPath));
      _fileHistoryStates.delete(oldPath);
    }
    if (_pendingExternalEdits.has(oldPath)) {
      _pendingExternalEdits.set(newPath, _pendingExternalEdits.get(oldPath)!);
      _pendingExternalEdits.delete(oldPath);
    }
  }

  function removeFileState(path: string, recursive = false) {
    if (!path) return;
    const matches = (candidate: string) =>
      recursive ? candidate === path || candidate.startsWith(`${path}/`) : candidate === path;

    const dropKeys = <T extends Record<string, unknown>>(prev: T): T => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (!matches(key)) continue;
        delete next[key];
        changed = true;
      }
      return changed ? next : prev;
    };

    setFileScrollPositions((prev) => dropKeys(prev));
    setFileTopLines((prev) => dropKeys(prev));
    setFileCursorSelections((prev) => dropKeys(prev));
    setFileViewModes((prev) => dropKeys(prev));
    setFileLastNonReadingViewModes((prev) => dropKeys(prev));
    setDirtyPaths((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const key of prev) {
        if (!matches(key)) continue;
        next.delete(key);
        changed = true;
        const timer = saveTimers.get(key);
        if (timer) {
          clearTimeout(timer);
          saveTimers.delete(key);
        }
      }
      return changed ? next : prev;
    });
    for (const key of Array.from(_fileHistoryStates.keys())) {
      if (matches(key)) _fileHistoryStates.delete(key);
    }
    for (const key of Array.from(_pendingExternalEdits.keys())) {
      if (matches(key)) _pendingExternalEdits.delete(key);
    }
  }

  // Zoom editor text (Ctrl + mousewheel).
  function zoomEditorText(delta: number) {
    setEditorZoom((prev) => Math.max(50, Math.min(200, prev + delta)));
  }

  // Zoom entire UI (Ctrl + =/-)
  function zoomUI(delta: number) {
    setUiZoomSignal((prev) => Math.max(50, Math.min(200, prev + delta)));
  }

  function setUiZoom(value: number) {
    setUiZoomSignal(() => Math.max(50, Math.min(200, Math.round(value))));
  }

  // Cleanup on unmount
  function cleanup() {
    for (const t of saveTimers.values()) clearTimeout(t);
    saveTimers.clear();
  }

  return {
    // State
    viewMode,
    getViewModeForFile,
    wordCount,
    charCount,
    cursorLine,
    cursorCol,
    isDirty,
    isDirtyPath,
    dirtyPaths,
    editorZoom,
    uiZoom,
    lastScrollLine,
    lastNonReadingViewMode,
    fileScrollPositions,
    fileTopLines,
    fileCursorSelections,
    fileViewModes,
    fileLastNonReadingViewModes,
    // Actions
    setViewMode,
    setDefaultViewMode,
    setCursorLine,
    setCursorCol,
    setLastScrollLine,
    toggleReadingMode,
    setFileScrollPosition,
    getFileScrollPosition,
    setFileTopLine,
    getFileTopLine,
    setFileCursorSelection,
    getFileCursorSelection,
    setFileHistoryState,
    getFileHistoryState,
    clearFileHistoryState,
    recordExternalEdit,
    discardExternalEdit,
    takePendingExternalEdits,
    scheduleAutoSave,
    cancelAutoSave,
    storeHeadings,
    forceSave,
    flushAllPendingSaves,
    updateStats,
    cycleViewMode,
    zoomEditorText,
    zoomUI,
    setUiZoom,
    clearDirty,
    restoreWorkspaceState,
    resetWorkspaceState,
    renameFileState,
    removeFileState,
    cleanup,
  };
}

export const editorStore = createRoot(createEditorStore);
