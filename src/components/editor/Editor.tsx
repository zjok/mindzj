import {
    Component,
    Show,
    createEffect,
    createMemo,
    createSignal,
    on,
    onMount,
    onCleanup,
} from "solid-js";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
    EditorView,
    keymap,
    lineNumbers,
    drawSelection,
} from "@codemirror/view";
import {
    defaultKeymap,
    history,
    historyField,
    historyKeymap,
    isolateHistory,
    undo,
    redo,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
    syntaxHighlighting,
    defaultHighlightStyle,
    HighlightStyle,
    bracketMatching,
    foldGutter,
    foldKeymap,
    indentUnit,
} from "@codemirror/language";
import { tags as t_ } from "@lezer/highlight";
import {
    search,
    searchKeymap,
    searchPanelOpen,
    getSearchQuery,
    setSearchQuery,
    openSearchPanel,
    SearchQuery,
} from "@codemirror/search";
import { createVSCodeSearchPanel } from "./extensions/searchPanel";
import {
    findPanelOpen,
    setFindPanelOpen,
    findQuery,
    setFindQuery,
    findReplaceText,
    setFindReplaceText,
    findCaseSensitive,
    setFindCaseSensitive,
    findWholeWord,
    setFindWholeWord,
    findRegex,
    setFindRegex,
} from "../../stores/findState";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { invoke } from "@tauri-apps/api/core";
import { vaultStore } from "../../stores/vault";
import { editorStore, type ViewMode } from "../../stores/editor";
import { settingsStore } from "../../stores/settings";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { livePreviewExtension } from "./extensions/livePreview";
import { listContinuationExtension } from "./extensions/listContinuation";
import { listStyleExtension } from "./extensions/listStyleExtension";

// `searchCounterExtension` used to append a match-count span into
// CM6's default search form. The custom VS Code-style panel (see
// searchPanel.ts) owns its own counter, so the old injector is no
// longer wired into the extension list. The module is kept on disk
// for reference/rollback.

import {
    LIST_INDENT_UNIT,
    LIST_RENDER_TAB_SIZE,
} from "./extensions/listUtils";
import { linkHandlerExtension } from "./extensions/linkHandler";
import { sourceHeadingLineExtension } from "./extensions/sourceHeadingLine";
import {
    addLineFlash,
    addSearchFlash,
    clearSearchFlash,
    searchFlashField,
} from "./extensions/searchFlash";
import {
    DEFAULT_ATTACHMENT_FOLDER,
    getParentPath,
    joinVaultPath,
    normalizeVaultRelativePath,
} from "../../utils/vaultPaths";
import { t } from "../../i18n";

interface EditorProps {
    file?: ReturnType<typeof vaultStore.activeFile>;
    viewMode?: ViewMode;
    isActive?: boolean;
    onActivate?: () => void;
}

// Override the default highlight style for heading tags so they no
// longer carry an underline (the built-in defaultHighlightStyle sets
// `textDecoration: "underline"` on `tags.heading`). Keeping bold +
// colour — just nuking the underline.
const mzHeadingHighlightStyle = HighlightStyle.define([
    { tag: t_.heading, textDecoration: "none", fontWeight: "bold", color: "var(--mz-syntax-heading)" },
    { tag: t_.heading1, textDecoration: "none", fontWeight: "bold", color: "var(--mz-syntax-heading)" },
    { tag: t_.heading2, textDecoration: "none", fontWeight: "bold", color: "var(--mz-syntax-heading)" },
    { tag: t_.heading3, textDecoration: "none", fontWeight: "bold", color: "var(--mz-syntax-heading)" },
    { tag: t_.heading4, textDecoration: "none", fontWeight: "bold", color: "var(--mz-syntax-heading)" },
    { tag: t_.heading5, textDecoration: "none", fontWeight: "bold", color: "var(--mz-syntax-heading)" },
    { tag: t_.heading6, textDecoration: "none", fontWeight: "bold", color: "var(--mz-syntax-heading)" },
]);

/**
 * Build the font-size theme used by the zoom compartment.
 *
 * The font-size is applied via a THEME (not an inherited CSS variable)
 * because CodeMirror only invalidates its internal height map when a
 * theme change flows through its own update pipeline. Reconfiguring
 * this theme through a Compartment is what actually tells CM6
 * "everything might have a new height — throw away the cached heightmap
 * and re-measure from scratch". Without that, changing font-size on an
 * ancestor via CSS leaves the heightmap stale and the cursor drifts off
 * the text during Ctrl+wheel zoom.
 */
function buildZoomTheme(pxSize: number) {
    return EditorView.theme({
        "&": {
            fontSize: `${pxSize}px`,
        },
    });
}

export const Editor: Component<EditorProps> = (props) => {
    let containerRef: HTMLDivElement | undefined;
    let editorView: EditorView | null = null;
    let currentFilePath: string | null = null;
    let currentViewMode: ViewMode | null = null;
    let isProgrammaticUpdate = false;
    // Guard that prevents our CM6 updateListener from echoing the
    // same SearchQuery effect back into the shared-state signals we
    // *just* dispatched. Without it, open-panel + setSearchQuery
    // from restoreSharedFindState would fire the updateListener,
    // which would re-write the identical values to the shared
    // signals, which in a split-pane setup could cascade back to
    // the OTHER pane's view — a loop in the worst case.
    let isRestoringSearchState = false;
    // Active search-reveal flash timer. Stored at component scope
    // (not module scope) so each split-pane editor tracks its own
    // flash independently. Re-clicks on any search result cancel
    // this timer and start a new one — without cancelling, the
    // OLD timer from the previous click would fire and wipe the
    // NEW flash prematurely.
    let searchFlashTimer: ReturnType<typeof setTimeout> | null = null;
    // Compartment that holds the zoom font-size theme. Reconfiguring it
    // is the only way to get CodeMirror to invalidate its height map
    // when the editor font-size changes.
    const zoomCompartment = new Compartment();
    const [contextMenu, setContextMenu] = createSignal<{
        x: number;
        y: number;
        items: MenuItem[];
    } | null>(null);
    const resolvedFile = createMemo(() => props.file ?? vaultStore.activeFile());
    const isPaneActive = () => props.isActive ?? true;

    // CRITICAL: In SolidJS, createEffect runs BEFORE the JSX ref is bound.
    // When switching from reading to edit mode with an already-open file,
    // the activeFile signal hasn't changed, so the effect never re-runs
    // after containerRef is set. onMount guarantees containerRef is ready.
    // Return the 1-based line number of the FIRST line visible at the top
    // of the current viewport. This is what the user sees as "the top line"
    // — the user requirement is that switching modes keeps this exact line
    // pinned at the top, regardless of where the cursor is.
    function getTopVisibleLine(view: EditorView): number {
        try {
            const scrollTop = view.scrollDOM.scrollTop;
            const topBlock = view.lineBlockAtHeight(scrollTop + 1);
            return view.state.doc.lineAt(topBlock.from).number;
        } catch {
            return 1;
        }
    }

    // Scroll the view so `lineNum` lands at the top of the viewport.
    // Uses CM6's `EditorView.scrollIntoView` effect inside a dispatch
    // because that path queues into CM6's measure cycle — it works
    // correctly even on a freshly created view (before any manual
    // measurement pass), which direct `scrollDOM.scrollTop` assignment
    // does not. Does NOT touch the selection, so the caller's separate
    // selection-restore dispatch isn't clobbered.
    function scrollLineToTop(view: EditorView, lineNum: number) {
        const maxLine = view.state.doc.lines;
        const clamped = Math.max(1, Math.min(lineNum, maxLine));
        const line = view.state.doc.line(clamped);
        view.dispatch({
            effects: EditorView.scrollIntoView(line.from, {
                y: "start",
                yMargin: 0,
            }),
        });
    }

    function posToOffset(view: EditorView, pos: { line: number; ch: number }) {
        const lineNum = Math.max(1, Math.min(view.state.doc.lines, pos.line + 1));
        const line = view.state.doc.line(lineNum);
        return Math.min(line.to, line.from + Math.max(0, pos.ch));
    }

    function offsetToPos(view: EditorView, offset: number) {
        const line = view.state.doc.lineAt(Math.max(0, Math.min(view.state.doc.length, offset)));
        return { line: line.number - 1, ch: Math.max(0, offset - line.from) };
    }

    function closeContextMenu() {
        setContextMenu(null);
    }

    function getActiveViewMode(): ViewMode {
        const path = currentFilePath ?? resolvedFile()?.path ?? null;
        return props.viewMode ?? editorStore.getViewModeForFile(path);
    }

    function switchTabFromEditor(direction: "prev" | "next"): boolean {
        const switchOpenTab = (window as any).__mindzj_switch_open_tab as
            | ((dir: "prev" | "next") => boolean)
            | undefined;
        if (switchOpenTab) return switchOpenTab(direction);

        const files = vaultStore.openFiles();
        if (files.length === 0) return false;
        const currentPath = vaultStore.activeFile()?.path ?? null;
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

        vaultStore.switchToFile(next.path);
        return true;
    }

    function activatePane() {
        props.onActivate?.();
    }

    function setEditorSurfaceVisibility(visible: boolean) {
        if (!containerRef) return;
        containerRef.style.visibility = visible ? "visible" : "hidden";
    }

    function revealEditorSurface(view: EditorView) {
        requestAnimationFrame(() => {
            if (editorView !== view) return;
            setEditorSurfaceVisibility(true);
        });
    }

    function rememberEditorViewport(view: EditorView | null = editorView) {
        const path = currentFilePath;
        if (!path || !view) return;
        const mode = getActiveViewMode();
        editorStore.setFileScrollPosition(path, mode, view.scrollDOM.scrollTop);
        editorStore.setFileTopLine(path, getTopVisibleLine(view));
        const selection = view.state.selection.main;
        editorStore.setFileCursorSelection(path, {
            anchor: selection.anchor,
            head: selection.head,
        });
    }

    // Snapshot the current editor's undo/redo history to the store under
    // `currentFilePath`. MUST be called before we either destroy the view
    // (mode switch, line-numbers toggle, component unmount) OR update
    // `currentFilePath` (file switch). The restore happens inside
    // `createEditorView` via `editorStore.getFileHistoryState`.
    function persistCurrentHistory() {
        if (!editorView || !currentFilePath) return;
        try {
            const json = editorView.state.toJSON({ history: historyField });
            editorStore.setFileHistoryState(currentFilePath, json);
        } catch {
            // Serialization failures are non-fatal — the worst case is
            // that undo history for this rebuild is lost (i.e. the
            // pre-fix behavior). Never throw and break the rebuild.
        }
    }

    function restoreEditorSelection(view: EditorView, path: string) {
        const stored = editorStore.getFileCursorSelection(path);
        if (!stored) return;
        const len = view.state.doc.length;
        view.dispatch({
            selection: {
                anchor: Math.min(stored.anchor, len),
                head: Math.min(stored.head, len),
            },
        });
    }

    function restoreEditorViewport(
        view: EditorView,
        path: string,
        mode: ViewMode,
        preferExactScroll: boolean,
    ) {
        const exactScrollTop = preferExactScroll
            ? editorStore.getFileScrollPosition(path, mode)
            : null;
        const topLine = editorStore.getFileTopLine(path);

        requestAnimationFrame(() => {
            if (editorView !== view) return;

            if (exactScrollTop !== null) {
                view.requestMeasure({
                    read() {
                        return null;
                    },
                    write() {
                        view.scrollDOM.scrollTop = exactScrollTop;
                        revealEditorSurface(view);
                    },
                });
                return;
            }

            if (topLine !== null) {
                scrollLineToTop(view, topLine);
                revealEditorSurface(view);
                return;
            }

            revealEditorSurface(view);
        });
    }

    function syncPluginEditorBindings(view: EditorView | null) {
        if (!isPaneActive()) return;
        if (!view || !containerRef) {
            (window as any).__mindzj_plugin_editor_api = null;
            (window as any).__mindzj_markdown_view = null;
            return;
        }

        const editorApi = {
            // Expose the raw CodeMirror 6 EditorView so plugins (e.g.
            // editing-toolbar) can access cm.state, cm.dispatch(),
            // cm.dom, register extensions, etc.
            cm: view,
            focus: () => view.focus(),
            getSelection: () => {
                const sel = view.state.selection.main;
                return view.state.sliceDoc(sel.from, sel.to);
            },
            replaceSelection: (text: string) => {
                const sel = view.state.selection.main;
                view.dispatch({
                    changes: { from: sel.from, to: sel.to, insert: text },
                    selection: { anchor: sel.from + text.length },
                });
                view.focus();
            },
            somethingSelected: () => !view.state.selection.main.empty,
            getCursor: (which?: "from" | "to") => {
                const sel = view.state.selection.main;
                return offsetToPos(view, which === "from" ? sel.from : which === "to" ? sel.to : sel.head);
            },
            setCursor: (line: number, ch: number) => {
                const offset = posToOffset(view, { line, ch });
                view.dispatch({ selection: { anchor: offset } });
                view.focus();
            },
            getLine: (line: number) => view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line + 1))).text,
            lineCount: () => view.state.doc.lines,
            lastLine: () => view.state.doc.lines - 1,
            firstLine: () => 0,
            replaceRange: (text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }) => {
                const fromOffset = posToOffset(view, from);
                const toOffset = posToOffset(view, to ?? from);
                view.dispatch({
                    changes: { from: fromOffset, to: toOffset, insert: text },
                    selection: { anchor: fromOffset + text.length },
                });
            },
            listSelections: () => view.state.selection.ranges.map((range) => ({
                anchor: offsetToPos(view, range.anchor),
                head: offsetToPos(view, range.head),
            })),
            setSelections: (ranges: Array<{ anchor: { line: number; ch: number }; head: { line: number; ch: number } }>) => {
                if (!ranges.length) return;
                view.dispatch({
                    selection: EditorSelection.create(ranges.map((range) => EditorSelection.range(
                        posToOffset(view, range.anchor),
                        posToOffset(view, range.head),
                    ))),
                });
            },
            setSelection: (from: { line: number; ch: number }, to?: { line: number; ch: number }) => {
                const anchor = posToOffset(view, from);
                const head = to ? posToOffset(view, to) : anchor;
                view.dispatch({ selection: { anchor, head } });
            },
            getDoc: () => ({
                getValue: () => view.state.doc.toString(),
                lineCount: () => view.state.doc.lines,
            }),
            transaction: () => view.state.update({}),
            undo: () => undo(view),
            redo: () => redo(view),
            exec: (command: string) => {
                if (command === "undo") return undo(view);
                if (command === "redo") return redo(view);
                if (command === "selectAll") {
                    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
                    return true;
                }
                return false;
            },
            getValue: () => view.state.doc.toString(),
            setValue: (value: string) => {
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
                return value;
            },
            getRange: (from: { line: number; ch: number }, to: { line: number; ch: number }) => {
                return view.state.sliceDoc(posToOffset(view, from), posToOffset(view, to));
            },
            getScrollInfo: () => ({
                top: view.scrollDOM.scrollTop,
                left: view.scrollDOM.scrollLeft,
                height: view.scrollDOM.scrollHeight,
                clientHeight: view.scrollDOM.clientHeight,
            }),
            scrollTo: (x: number | null, y: number | null) => {
                if (y !== null) view.scrollDOM.scrollTop = y;
                if (x !== null) view.scrollDOM.scrollLeft = x;
            },
            scrollIntoView: (pos?: { line: number; ch: number }) => {
                if (pos) {
                    const offset = posToOffset(view, pos);
                    view.dispatch({ effects: EditorView.scrollIntoView(offset) });
                }
            },
        };

        (window as any).__mindzj_plugin_editor_api = editorApi;
        const activePath = resolvedFile()?.path ?? "";
        const fileName = activePath.split("/").pop() ?? activePath;
        const markdownView: any = {
            editor: editorApi,
            containerEl: containerRef,
            contentEl: containerRef,
            // Expose the CM6 view element for plugins that need to attach
            // toolbars, context menus, or other UI relative to the editor.
            editMode: { editor: { cm: view } },
            currentMode: { editor: { cm: view } },
            sourceMode: { cmEditor: { cm: view } },
            leaf: { width: containerRef.clientWidth || 0, containerEl: containerRef, view: null },
            file: activePath ? {
                path: activePath,
                name: fileName,
                basename: fileName.replace(/\.[^.]+$/, ""),
                extension: fileName.includes(".") ? fileName.split(".").pop() ?? "" : "",
                stat: { mtime: Date.now(), ctime: Date.now(), size: 0 },
                vault: { getName: () => vaultStore.vaultInfo()?.name ?? "vault" },
                parent: {
                    path: activePath.includes("/") ? activePath.split("/").slice(0, -1).join("/") : "",
                    name: activePath.includes("/") ? activePath.split("/").slice(-2, -1)[0] || "/" : "/",
                },
            } : null,
            getViewType: () => "markdown",
            getMode: () => getActiveViewMode() === "source" ? "source" : "preview",
        };
        markdownView.leaf.view = markdownView;
        (window as any).__mindzj_markdown_view = markdownView;
    }

    // Handle image deletion from the context menu dispatched by livePreview.ts
    function handleDeleteImage(e: Event) {
        const detail = (e as CustomEvent).detail;
        if (!detail || !editorView) return;
        const { imageSrc, imagePath } = detail;

        // Find and remove the markdown image syntax from the document
        const doc = editorView.state.doc.toString();
        // Match ![...](...) or ![[...]] patterns containing the image src
        const escapedSrc = imageSrc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const patterns = [
            new RegExp(`!\\[[^\\]]*\\]\\(${escapedSrc}\\)\\n?`),
            new RegExp(`!\\[\\[${escapedSrc}\\]\\]\\n?`),
        ];

        let matchFrom = -1;
        let matchTo = -1;
        for (const re of patterns) {
            const m = doc.match(re);
            if (m && m.index !== undefined) {
                matchFrom = m.index;
                matchTo = m.index + m[0].length;
                break;
            }
        }

        if (matchFrom >= 0) {
            editorView.dispatch({
                changes: { from: matchFrom, to: matchTo, insert: "" },
            });
        }

        // Delete the image file from the vault
        invoke("delete_file", { relativePath: imagePath }).catch((err) => {
            console.warn("[Editor] Failed to delete image file:", err);
        });
    }

    function handleRememberViewport() {
        rememberEditorViewport();
    }

    onMount(() => {
        document.addEventListener("mindzj:delete-image", handleDeleteImage);
        document.addEventListener(
            "mindzj:remember-active-viewport",
            handleRememberViewport,
        );

        const activeFile = resolvedFile();
        if (activeFile && containerRef && !editorView) {
            currentFilePath = activeFile.path;
            currentViewMode = getActiveViewMode();
            createEditorView(activeFile.content);
            if (editorView) {
                restoreEditorSelection(editorView, activeFile.path);
                restoreEditorViewport(editorView, activeFile.path, currentViewMode!, false);
            }
        }
    });

    // Watch for active file changes (handles file switching AFTER initial mount)
    createEffect(
        on(
            resolvedFile,
            (activeFile) => {
                if (!activeFile || !containerRef) return;
                if (activeFile.path !== currentFilePath) {
                    // Rename detection: if the editor content matches the
                    // signal content, only the path changed (file was renamed).
                    // Update the local path reference without destroying/
                    // recreating the view — avoids a visual flash.
                    if (
                        editorView &&
                        activeFile.content === editorView.state.doc.toString()
                    ) {
                        const mode = getActiveViewMode();
                        editorStore.setFileScrollPosition(
                            activeFile.path,
                            mode,
                            editorView.scrollDOM.scrollTop,
                        );
                        editorStore.setFileTopLine(
                            activeFile.path,
                            getTopVisibleLine(editorView),
                        );
                        currentFilePath = activeFile.path;
                        syncPluginEditorBindings(editorView);
                        return;
                    }

                    rememberEditorViewport();
                    // Persist under the OLD `currentFilePath` before we
                    // reassign it — otherwise the history for the tab we
                    // just left would get keyed under the incoming tab.
                    persistCurrentHistory();
                    currentFilePath = activeFile.path;
                    currentViewMode = getActiveViewMode();
                    createEditorView(activeFile.content);
                    if (editorView) {
                        restoreEditorSelection(editorView, activeFile.path);
                        restoreEditorViewport(editorView, activeFile.path, currentViewMode!, true);
                    }
                    return;
                }

                // Same path, but the signal emitted — check if CONTENT
                // changed externally (e.g. Replace All in SearchPanel
                // wrote this file, or a plugin updated it). If so,
                // apply the change as a CM6 transaction so (a) the
                // editor visually updates in place, and (b) the change
                // lands in the undo history — Ctrl+Z reverts it.
                // Guarded so auto-save echoes (which call
                // `setActiveFile` with identical content) are no-ops.
                if (
                    editorView &&
                    activeFile.content !== editorView.state.doc.toString()
                ) {
                    const beforeContent = editorView.state.doc.toString();
                    isProgrammaticUpdate = true;
                    try {
                        editorView.dispatch({
                            changes: {
                                from: 0,
                                to: editorView.state.doc.length,
                                insert: activeFile.content,
                            },
                            annotations: isolateHistory.of("full"),
                        });
                    } finally {
                        isProgrammaticUpdate = false;
                    }
                    editorStore.discardExternalEdit(
                        activeFile.path,
                        beforeContent,
                        activeFile.content,
                    );
                }
            },
        ),
    );

    // Watch for view mode changes — rebuild the editor with/without the
    // live-preview decorations. Preserve the TOP-VISIBLE line across the
    // rebuild so `source ↔ live-preview` transitions keep the same
    // content pinned to the viewport top, and stash it for ReadingView
    // to pick up on mount.
    createEffect(
        on(
            getActiveViewMode,
            (mode) => {
                if (!containerRef || !currentFilePath) return;
                if (mode !== currentViewMode) {
                    rememberEditorViewport();
                    // Stash undo/redo history so the Ctrl+Z chain
                    // survives the source ↔ live-preview rebuild that
                    // follows. `createEditorView` consumes this on the
                    // next tick.
                    persistCurrentHistory();
                    currentViewMode = mode;
                    const activeFile = resolvedFile();
                    if (activeFile) {
                        const currentContent = editorView
                            ? editorView.state.doc.toString()
                            : activeFile.content;
                        // Snapshot the selection + the top-visible line.
                        const prevSel = editorView?.state.selection.main;

                        createEditorView(currentContent);

                        if (editorView && prevSel) {
                            const len = editorView.state.doc.length;
                            const anchor = Math.min(prevSel.anchor, len);
                            const head = Math.min(prevSel.head, len);
                            editorView.dispatch({
                                selection: { anchor, head },
                            });
                        }
                        if (editorView) {
                            restoreEditorViewport(editorView, currentFilePath, mode, false);
                        }
                    }
                }
            },
        ),
    );

    // When the editor is destroyed (user switched to Reading mode, or
    // component unmounts), stash the current top-visible line so the next
    // mount (Editor or ReadingView) can restore the same scroll position.
    onCleanup(() => {
        document.removeEventListener("mindzj:delete-image", handleDeleteImage);
        document.removeEventListener(
            "mindzj:remember-active-viewport",
            handleRememberViewport,
        );
        rememberEditorViewport();
    });

    // Also continuously track the top-visible line as the user scrolls,
    // so even if they switch modes without making a transaction first,
    // the stashed line is up-to-date.
    const scrollTrackTimers = new WeakMap<EditorView, number>();
    function installScrollTracker(view: EditorView) {
        let timer: number | null = null;
        const handler = () => {
            if (timer != null) return;
            timer = window.setTimeout(() => {
                timer = null;
                if (editorView === view) {
                    rememberEditorViewport(view);
                }
            }, 80);
        };
        view.scrollDOM.addEventListener("scroll", handler, { passive: true });
        scrollTrackTimers.set(view, 1);
        onCleanup(() => {
            view.scrollDOM.removeEventListener("scroll", handler);
            if (timer != null) clearTimeout(timer);
        });
    }

    // Apply editor text zoom.
    //
    // Reconfiguring the font-size THROUGH a Compartment is what makes
    // CodeMirror rebuild its height map. Setting fontSize on the container
    // (even with an offsetHeight reflow + requestMeasure) is not enough:
    // CM6 only re-measures line heights when its own update pipeline sees
    // a configuration change. A Compartment reconfigure IS such a change,
    // so the heightmap is recomputed and the cursor overlay follows the
    // new line positions instead of floating at its pre-zoom coords.
    createEffect(() => {
        const zoom = editorStore.editorZoom();
        const baseFontSize = settingsStore.settings().font_size;
        const pxSize = (zoom / 100) * baseFontSize;
        // Still sync the container's font-size so anything outside the
        // editor (gutters, panels) scales too.
        if (containerRef) {
            containerRef.style.fontSize = `${pxSize}px`;
        }
        const view = editorView;
        if (!view) return;
        view.dispatch({
            effects: zoomCompartment.reconfigure(buildZoomTheme(pxSize)),
        });
    });

    // Live-rebuild the editor when the line-number setting changes so the
    // gutter appears/disappears immediately (no reopen required). Only
    // rebuild while we're in source mode — the gutter isn't shown in live
    // preview or reading mode, so changing the setting there would be a
    // pointless recreate.
    createEffect(
        on(
            () => settingsStore.settings().editor_line_numbers,
            (_showNums, prev) => {
                if (prev === undefined) return; // initial run
                if (getActiveViewMode() !== "source") return;
                if (!containerRef || !currentFilePath) return;
                const activeFile = resolvedFile();
                if (!activeFile) return;
                const currentContent = editorView
                    ? editorView.state.doc.toString()
                    : activeFile.content;
                rememberEditorViewport();
                persistCurrentHistory();
                createEditorView(currentContent);
                if (editorView && currentFilePath) {
                    restoreEditorViewport(
                        editorView,
                        currentFilePath,
                        getActiveViewMode(),
                        true,
                    );
                }
            },
        ),
    );

    function createEditorView(content: string) {
        if (!containerRef) return;
        closeContextMenu();
        setEditorSurfaceVisibility(false);

        // Snapshot headings so we can detect renames on the next save.
        if (currentFilePath) {
            editorStore.storeHeadings(currentFilePath, content);
        }
        const pendingExternalEdits = currentFilePath
            ? editorStore.takePendingExternalEdits(currentFilePath, content)
            : [];
        const contentForState = pendingExternalEdits.length > 0
            ? pendingExternalEdits[0].before
            : content;

        if (editorView) {
            // Snapshot the Ctrl+F panel state into shared signals
            // before destroying the view. The shared signals persist
            // across component unmounts, so switching tabs (rebuild
            // within the same Editor instance) OR view modes (Editor
            // → ReadingView) will find the query + toggles intact
            // when the next panel opens.
            try {
                const wasOpen = searchPanelOpen(editorView.state);
                const q = getSearchQuery(editorView.state);
                if (q) {
                    setFindPanelOpen(wasOpen);
                    setFindQuery(q.search ?? "");
                    setFindCaseSensitive(!!q.caseSensitive);
                    setFindWholeWord(!!q.wholeWord);
                    setFindRegex(!!q.regexp);
                    setFindReplaceText(q.replace ?? "");
                }
            } catch {
                // Non-fatal: if snapshot fails we just lose the
                // query on this particular transition.
            }
            editorView.destroy();
            editorView = null;
            syncPluginEditorBindings(null);
        }

        const mode = getActiveViewMode();
        const isLivePreview = mode === "live-preview";
        const isReading = mode === "reading";

        // Resolve vault root path for image previews
        const vaultRoot = vaultStore.vaultInfo()?.path ?? "";

        // Line numbers + fold gutter: ONLY in source mode AND only if the user
        // has enabled line numbers in Settings. When disabled we skip the fold
        // gutter too so the left rail disappears entirely (previously an
        // empty fold gutter column remained).
        const isSourceMode = mode === "source";
        const showGutter = isSourceMode && settingsStore.settings().editor_line_numbers;

        const extensions = [
            // Force tab-based indentation globally — prevents CM6's
            // insertNewlineAndIndent from converting tabs to spaces.
            indentUnit.of(LIST_INDENT_UNIT),
            EditorState.tabSize.of(LIST_RENDER_TAB_SIZE),
            history(),
            drawSelection(),
            bracketMatching(),
            closeBrackets(),
            // NOTE: `highlightSelectionMatches()` is NOT installed in
            // any mode. We used to enable it in source mode, but the
            // user explicitly asked that selecting text should NOT
            // auto-paint every other occurrence of the same text —
            // that's what the dedicated search panel (Ctrl+F) is for.
            // Selection highlighting is left to the native browser
            // `.cm-selectionBackground` style only.
            ...(showGutter ? [foldGutter(), lineNumbers()] : []),
            markdown({ base: markdownLanguage }),
            // Custom highlight style MUST come first so it overrides the
            // default. `defaultHighlightStyle` from @codemirror/language
            // sets `textDecoration: "underline"` on `tags.heading`, which
            // draws an underline under every H1–H6 in source mode. We
            // strip that here and restore the bold/colour styling.
            syntaxHighlighting(mzHeadingHighlightStyle),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

            // List continuation (auto-continue on Enter, indent/outdent)
            listContinuationExtension(),

            // Install the search state/extension so the Ctrl+F panel
            // mounts at the TOP of the editor instead of the default
            // bottom position. CSS in editor.css then absolute-
            // positions that top panel as a floating VS Code-style
            // find widget in the top-right corner.
            //
            // `createPanel` swaps CM6's default form for a custom
            // VS Code-style panel (see extensions/searchPanel.ts) —
            // chevron toggle for the replace row, Aa/ab/.* toggles
            // as icon buttons, match counter, nav arrows, and
            // find-in-selection / close buttons.
            search({ top: true, createPanel: createVSCodeSearchPanel }),

            // `searchCounterExtension` used to append a match-count
            // span into CM6's default `.cm-search` form. Our custom
            // VS Code panel owns its own counter element and updates
            // it on every viewport/query update, so the old injector
            // would just drop a duplicate span in the DOM. It's kept
            // imported (below) but deliberately NOT installed.
            // searchCounterExtension(),

            // Search-reveal flash highlight — temporary decoration
            // fired from the global search panel when the user
            // clicks a result. Scrolls to the line and paints a
            // yellow-ish flash over the matched text for ~1.5s.
            searchFlashField,

            // Link handler (Ctrl+Click, wiki link autocomplete,
            // Ctrl+Alt+C/V link-anchor copy/paste)
            linkHandlerExtension(),

            // Source mode only: tag heading lines with mz-src-h1…h6
            // line classes so the CSS can apply heading font-size on the
            // line wrapper. Applying it on the inline .cm-header-N span
            // makes the visible line taller than CM6's measured height,
            // which breaks arrow-key movement and click positioning.
            ...(isSourceMode ? [sourceHeadingLineExtension()] : []),

            // Source mode: apply the shared list-styling extension so
            // ordered/unordered lists render with the same bullet,
            // ordered-marker color, hanging-indent wrap and nested
            // guide lines as live-preview. In live-preview mode the
            // same visuals are supplied by `livePreviewExtension`
            // below (which owns a superset of the list logic).
            ...(isSourceMode ? listStyleExtension() : []),

            // Live Preview extension (only in live-preview mode).
            // Block widgets (blockWidgetExtension) are NOT included here —
            // Decoration.replace({block:true}) makes code blocks / tables
            // atomic, so the cursor can't be placed inside, arrow keys
            // skip them, and clicks can't map to source lines. Instead,
            // livePreview.ts styles the raw source via line decorations
            // (Obsidian-style) so every character stays cursor-addressable.
            ...(isLivePreview
                ? livePreviewExtension(vaultRoot, currentFilePath ?? "")
                : []),

            // Reading mode: make editor non-editable
            ...(isReading ? [EditorState.readOnly.of(true)] : []),

            // Plugin-registered CM6 extensions (via registerEditorExtension)
            ...((window as any).__mindzj_plugin_cm_extensions ?? []),

            keymap.of([
                { key: "Mod-Shift-ArrowLeft", run: () => switchTabFromEditor("prev") },
                { key: "Mod-Shift-ArrowRight", run: () => switchTabFromEditor("next") },
                // PageUp / PageDown intentionally NOT overridden here —
                // we fall through to `defaultKeymap` which binds them
                // to `cursorPageUp` / `cursorPageDown`, i.e. scroll
                // the cursor by one viewport page. This matches VS
                // Code / Obsidian / the web default behaviour the
                // user explicitly asked us to preserve.
                ...(isLivePreview
                    ? [
                        { key: "Home", run: (v: EditorView) => moveCursorToLogicalLineBoundary(v, "start", false) },
                        { key: "End", run: (v: EditorView) => moveCursorToLogicalLineBoundary(v, "end", false) },
                        { key: "Shift-Home", run: (v: EditorView) => moveCursorToLogicalLineBoundary(v, "start", true) },
                        { key: "Shift-End", run: (v: EditorView) => moveCursorToLogicalLineBoundary(v, "end", true) },
                        { key: "Mod-Shift-Home", run: (v: EditorView) => moveCursorToLogicalLineBoundary(v, "start", true) },
                        { key: "Mod-Shift-End", run: (v: EditorView) => moveCursorToLogicalLineBoundary(v, "end", true) },
                        { key: "ArrowUp", run: (v: EditorView) => moveCursorByLogicalLine(v, -1, false) },
                        { key: "ArrowDown", run: (v: EditorView) => moveCursorByLogicalLine(v, 1, false) },
                        { key: "Shift-ArrowUp", run: (v: EditorView) => moveCursorByLogicalLine(v, -1, true) },
                        { key: "Shift-ArrowDown", run: (v: EditorView) => moveCursorByLogicalLine(v, 1, true) },
                    ]
                    : []),
                ...defaultKeymap,
                ...historyKeymap,
                // Redo: Ctrl+Shift+Z (Obsidian-style, overrides default Ctrl+Y)
                { key: "Mod-Shift-z", run: (v) => redo(v) },
                ...searchKeymap,
                ...foldKeymap,
                ...closeBracketsKeymap,
                // Formatting shortcuts (Obsidian-compatible)
                { key: "Mod-b", run: (v) => wrapSelection(v, "**") },
                { key: "Mod-i", run: (v) => wrapSelection(v, "*") },
                { key: "Mod-Shift-s", run: (v) => wrapSelection(v, "~~") },
                { key: "Mod-u", run: (v) => wrapSelection(v, "<u>", "</u>") },
                // Ctrl+E is reserved for toggling edit/preview mode (handled by global keydown).
                // Inline code: use Ctrl+Shift+E instead.
                { key: "Mod-Shift-e", run: (v) => wrapSelection(v, "`") },
                { key: "Mod-k", run: (v) => insertLink(v) },
                { key: "Mod-Shift-h", run: (v) => wrapSelection(v, "==") },
                // Heading shortcuts: Ctrl+1 ~ Ctrl+6 for H1-H6
                { key: "Mod-1", run: (v) => setHeading(v, 1) },
                { key: "Mod-2", run: (v) => setHeading(v, 2) },
                { key: "Mod-3", run: (v) => setHeading(v, 3) },
                { key: "Mod-4", run: (v) => setHeading(v, 4) },
                { key: "Mod-5", run: (v) => setHeading(v, 5) },
                { key: "Mod-6", run: (v) => setHeading(v, 6) },
                // Ctrl+0 = remove heading (normal paragraph)
                { key: "Mod-0", run: (v) => setHeading(v, 0) },
                // Ctrl+D: delete current line (Obsidian-like)
                { key: "Mod-d", run: (v) => deleteLine(v) },
                // Ctrl+Shift+K: also delete line (VS Code style)
                { key: "Mod-Shift-k", run: (v) => deleteLine(v) },
                // Ctrl+]: indent entire line from start
                { key: "Mod-]", run: (v) => indentLineFromStart(v, true) },
                // Ctrl+[: outdent entire line from start
                { key: "Mod-[", run: (v) => indentLineFromStart(v, false) },
                // Ctrl+Enter: insert line below
                { key: "Mod-Enter", run: (v) => insertLineBelow(v) },
                // Ctrl+Shift+Enter: insert line above
                { key: "Mod-Shift-Enter", run: (v) => insertLineAbove(v) },
                // Alt+Up/Down: move line up/down
                { key: "Alt-ArrowUp", run: (v) => moveLine(v, -1) },
                { key: "Alt-ArrowDown", run: (v) => moveLine(v, 1) },
                // Ctrl+Shift+D: duplicate line
                { key: "Mod-Shift-d", run: (v) => duplicateLine(v) },
                // Ctrl+/: toggle comment (HTML comment for markdown)
                { key: "Mod-/", run: (v) => toggleComment(v) },
                // Ctrl+Shift+.: toggle callout/blockquote
                { key: "Mod-Shift-.", run: (v) => toggleBlockquote(v) },
                // Ctrl+Alt+Left / Ctrl+Alt+Right → switch tabs. The
                // same shortcut is ALSO handled by the capture-phase
                // keydown in App.tsx, but keeping a CM6 binding here
                // is a safety net for the case where the webview
                // doesn't deliver the event to the document listener
                // (which has bitten us in the past on certain
                // keyboard layouts and on Tauri focus transitions).
                //
                // The two paths are idempotent: whichever one fires
                // first calls preventDefault, which suppresses the
                // other. If somehow both fired, they'd both just set
                // the active file to the same `files[newIdx]`, so
                // there's no double-step bug.
            ]),

            EditorView.updateListener.of((update) => {
                if (update.docChanged && !isProgrammaticUpdate) {
                    const content = update.state.doc.toString();
                    if (currentFilePath) {
                        editorStore.scheduleAutoSave(currentFilePath, content);
                    }
                    if (isPaneActive()) {
                        editorStore.updateStats(content);
                    }
                }
                if (update.selectionSet && isPaneActive()) {
                    const pos = update.state.selection.main.head;
                    const line = update.state.doc.lineAt(pos);
                    editorStore.setCursorLine(line.number);
                    editorStore.setCursorCol(pos - line.from + 1);
                }
                if (update.selectionSet && currentFilePath) {
                    const selection = update.state.selection.main;
                    editorStore.setFileCursorSelection(currentFilePath, {
                        anchor: selection.anchor,
                        head: selection.head,
                    });
                }

                // Mirror the CM6 search state into the shared find
                // signals so tab switches / mode switches pick up the
                // latest query + open-state without depending on the
                // onCleanup snapshot path. Gated on `isRestoringSearchState`
                // so we don't echo the effects we just dispatched from
                // restore back into the same signals. We only write
                // when values actually differ from the signal — Solid's
                // fine-grained reactivity already deduplicates equal
                // values but the comparisons here keep the work off the
                // hot path.
                if (!isRestoringSearchState) {
                    const nextOpen = searchPanelOpen(update.state);
                    if (nextOpen !== findPanelOpen()) {
                        setFindPanelOpen(nextOpen);
                    }
                    const q = getSearchQuery(update.state);
                    if (q) {
                        if ((q.search ?? "") !== findQuery()) {
                            setFindQuery(q.search ?? "");
                        }
                        if ((q.replace ?? "") !== findReplaceText()) {
                            setFindReplaceText(q.replace ?? "");
                        }
                        if (!!q.caseSensitive !== findCaseSensitive()) {
                            setFindCaseSensitive(!!q.caseSensitive);
                        }
                        if (!!q.wholeWord !== findWholeWord()) {
                            setFindWholeWord(!!q.wholeWord);
                        }
                        if (!!q.regexp !== findRegex()) {
                            setFindRegex(!!q.regexp);
                        }
                    }
                }
            }),

            EditorView.domEventHandlers({
                keydown(event) {
                    // Ctrl+Shift+Left / Ctrl+Shift+Right → switch tabs.
                    // Ctrl+Alt+Left / Ctrl+Alt+Right remains an alias.
                    //
                    // Hard-coded match (not `matchesHotkey`) and uses
                    // both `event.code` and `event.key` so non-US
                    // keyboard layouts can't silently break this.
                    // This is only a safety net — the primary path
                    // is the capture-phase document listener in
                    // App.tsx, which calls stopImmediatePropagation
                    // before this handler would ever see the event.
                    const keyCode = event.keyCode || event.which;
                    const isHorizontalArrow =
                        event.code === "ArrowLeft" ||
                        event.code === "ArrowRight" ||
                        event.key === "ArrowLeft" ||
                        event.key === "ArrowRight" ||
                        event.key === "Left" ||
                        event.key === "Right" ||
                        keyCode === 37 ||
                        keyCode === 39;
                    if (
                        (event.ctrlKey || event.metaKey) &&
                        isHorizontalArrow &&
                        ((event.shiftKey && !event.altKey) ||
                            (event.altKey && !event.shiftKey))
                    ) {
                        event.preventDefault();
                        event.stopPropagation();
                        event.stopImmediatePropagation?.();
                        const goLeft =
                            event.code === "ArrowLeft" ||
                            event.key === "ArrowLeft" ||
                            event.key === "Left" ||
                            keyCode === 37;
                        return switchTabFromEditor(goLeft ? "prev" : "next");
                    }
                    return false;
                },
                wheel(event) {
                    if (event.ctrlKey) {
                        event.preventDefault();
                        const raw = -event.deltaY;
                        const step = Math.sign(raw) * Math.min(3, Math.max(1, Math.abs(raw) / 50));
                        editorStore.zoomEditorText(Math.round(step));
                        return true;
                    }
                    return false;
                },
                contextmenu(event, view) {
                    activatePane();
                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenu({
                        x: event.clientX,
                        y: event.clientY,
                        items: buildEditorContextMenu(view),
                    });
                    return true;
                },
                focus() {
                    activatePane();
                    return false;
                },
                mousedown() {
                    activatePane();
                    return false;
                },
                paste(event, view) {
                    const items = event.clipboardData?.items;
                    if (!items) return false;

                    // Look for image data in clipboard
                    for (let i = 0; i < items.length; i++) {
                        const item = items[i];
                        if (item.type.startsWith("image/")) {
                            event.preventDefault();
                            const blob = item.getAsFile();
                            if (!blob) return true;

                            // Determine file extension from MIME type
                            const ext = item.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
                            const now = new Date();
                            const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
                            const fileName = `Pasted image ${ts}.${ext}`;
                            const currentNotePath = currentFilePath ?? "";
                            const configuredFolder = normalizeVaultRelativePath(
                                settingsStore.settings().attachment_folder || DEFAULT_ATTACHMENT_FOLDER,
                            );
                            const isNoteRelativeFolder =
                                configuredFolder.startsWith("./") ||
                                configuredFolder.startsWith("../");
                            const storageDir = isNoteRelativeFolder
                                ? joinVaultPath(getParentPath(currentNotePath), configuredFolder)
                                : configuredFolder;
                            const filePath = joinVaultPath(storageDir, fileName);
                            const markdownImagePath = isNoteRelativeFolder
                                ? joinVaultPath(configuredFolder, fileName)
                                : `/${filePath}`;

                            // Read blob as base64 and save via Rust backend
                            const reader = new FileReader();
                            reader.onload = async () => {
                                try {
                                    const dataUrl = reader.result as string;
                                    // Strip the data:image/...;base64, prefix
                                    const base64Data = dataUrl.split(",")[1];
                                    if (!base64Data) return;

                                    await invoke("write_binary_file", {
                                        relativePath: filePath,
                                        base64Data,
                                    });

                                    // Insert markdown image reference at cursor
                                    const pos = view.state.selection.main.head;
                                    const imageRef = `![](${markdownImagePath})`;
                                    view.dispatch({
                                        changes: { from: pos, insert: imageRef },
                                        selection: { anchor: pos + imageRef.length },
                                    });

                                    // Windows clipboard often carries a CF_HTML
                                    // representation of the same screenshot
                                    // alongside the raw bitmap — typically
                                    // `<img …><br>` with a trailing <br> tag
                                    // added by the Windows shell. Even though
                                    // we preventDefault the paste and take
                                    // the image/png path above, some WebView2
                                    // releases still drop the HTML fragment
                                    // into the contenteditable, leaving a
                                    // stray `<br>` immediately after our
                                    // inserted image reference. Sweep it up
                                    // here — single `<br>`, `<br/>`, or
                                    // `<br />` with optional leading whitespace
                                    // — so the user never sees it in the
                                    // source markdown.
                                    const afterPos = pos + imageRef.length;
                                    const afterState = view.state;
                                    if (afterPos <= afterState.doc.length) {
                                        const tailLen = Math.min(
                                            16,
                                            afterState.doc.length - afterPos,
                                        );
                                        if (tailLen > 0) {
                                            const tail = afterState.doc.sliceString(
                                                afterPos,
                                                afterPos + tailLen,
                                            );
                                            const brMatch = tail.match(
                                                /^\s*<br\s*\/?\s*>/i,
                                            );
                                            if (brMatch) {
                                                view.dispatch({
                                                    changes: {
                                                        from: afterPos,
                                                        to: afterPos + brMatch[0].length,
                                                        insert: "",
                                                    },
                                                });
                                            }
                                        }
                                    }
                                } catch (e) {
                                    console.error("[Editor] Failed to save pasted image:", e);
                                }
                            };
                            reader.readAsDataURL(blob);
                            return true;
                        }
                    }
                    return false;
                },
            }),

            // Zoom compartment — holds the font-size theme. Reconfigured
            // on Ctrl+wheel to trigger a full height-map rebuild. Must
            // come BEFORE the base theme below so later theme rules (if
            // any target font-size) can still override it, and AFTER
            // state initialisation so createEffect can reconfigure it.
            zoomCompartment.of(
                buildZoomTheme(
                    (editorStore.editorZoom() / 100) *
                        settingsStore.settings().font_size,
                ),
            ),

            EditorView.theme({
                "&": {
                    height: "100%",
                },
                ".cm-scroller": {
                    overflow: "auto",
                    fontFamily: "var(--mz-font-sans)",
                },
                ".cm-content": {
                    padding: "10px 24px",
                    caretColor: "var(--mz-accent)",
                    minHeight: "100%",
                },
                ".cm-cursor": {
                    borderLeftColor: "var(--mz-accent)",
                    borderLeftWidth: "2px",
                },
                ".cm-selectionBackground": {
                    background: "var(--mz-bg-selection) !important",
                },
                ".cm-activeLine": { background: "var(--mz-bg-hover)" },
                ".cm-gutters": {
                    background: "var(--mz-bg-secondary)",
                    color: "var(--mz-text-muted)",
                    border: "none",
                    borderRight: "1px solid var(--mz-border)",
                },
                ".cm-activeLineGutter": { background: "var(--mz-bg-hover)" },
                "&.cm-focused .cm-matchingBracket": {
                    background: "var(--mz-accent-subtle)",
                },
            }),

            EditorView.lineWrapping,
        ];

        // Rehydrate the undo/redo history saved by the previous view
        // instance (if any) for this file path. `persistCurrentHistory`
        // stashes a JSON snapshot before every destroy/unmount and
        // before every `currentFilePath` change.
        //
        // Restoration is gated on `historyJson.doc === content`: the
        // history's change objects encode offsets into the exact
        // document they were recorded against. When the snapshot's
        // doc and the incoming content diverge (file reloaded from
        // disk by the watcher, split pane showing another revision,
        // programmatic setValue from a plugin, etc.) we drop the
        // stale entry and take the byte-identical pre-history-
        // persistence path — plain `EditorState.create` — so auto-
        // save and every other extension behave exactly as they did
        // before the history-preservation feature landed.
        const historyJson = currentFilePath
            ? editorStore.getFileHistoryState(currentFilePath)
            : null;
        const canRestoreHistory =
            historyJson != null &&
            typeof historyJson.doc === "string" &&
            historyJson.doc === contentForState &&
            historyJson.history != null;
        let state: EditorState;
        if (canRestoreHistory) {
            try {
                state = EditorState.fromJSON(
                    historyJson,
                    { extensions },
                    { history: historyField },
                );
                editorStore.clearFileHistoryState(currentFilePath!);
            } catch (err) {
                console.warn(
                    "[Editor] Failed to restore history state; starting fresh.",
                    err,
                );
                editorStore.clearFileHistoryState(currentFilePath!);
                state = EditorState.create({ doc: contentForState, extensions });
            }
        } else {
            if (historyJson && currentFilePath) {
                editorStore.clearFileHistoryState(currentFilePath);
            }
            state = EditorState.create({ doc: contentForState, extensions });
        }

        editorView = new EditorView({ state, parent: containerRef });
        if (pendingExternalEdits.length > 0) {
            isProgrammaticUpdate = true;
            try {
                for (const edit of pendingExternalEdits) {
                    if (editorView.state.doc.toString() !== edit.before) break;
                    editorView.dispatch({
                        changes: {
                            from: 0,
                            to: editorView.state.doc.length,
                            insert: edit.after,
                        },
                        annotations: isolateHistory.of("full"),
                    });
                }
            } finally {
                isProgrammaticUpdate = false;
            }
        }
        syncPluginEditorBindings(editorView);
        if (isPaneActive()) {
            editorStore.updateStats(content);
            editorView.focus();
        }

        // Restore the Ctrl+F panel from shared find state. Runs for
        // BOTH tab switches (within this Editor) and mode switches
        // (component just mounted). The shared signals are the source
        // of truth — CM6's own state was just rebuilt from scratch.
        // Deferred to a microtask so the view has its initial
        // viewport measured — `openSearchPanel` dispatches a
        // transaction that otherwise races with CM6's internal
        // startup dispatch and occasionally drops the panel mount.
        //
        // In split mode only the ACTIVE pane auto-opens its panel:
        // without the `isPaneActive()` gate, an inactive pane being
        // rebuilt (e.g. the user renamed its file) would pop a search
        // panel on top of its content just because the OTHER pane
        // happened to have one open. The query itself (if any) still
        // gets seeded into the CM search state so that when the user
        // DOES later press Ctrl+F on this pane, their previous query
        // is pre-filled — matching the cross-mode preservation promise
        // of the shared findState store.
        const shouldRestoreOpen = findPanelOpen() && isPaneActive();
        const restoreSearch = findQuery();
        const restoreReplace = findReplaceText();
        const restoreCase = findCaseSensitive();
        const restoreWord = findWholeWord();
        const restoreRegex = findRegex();
        if (shouldRestoreOpen || restoreSearch || restoreReplace) {
            queueMicrotask(() => {
                const view = editorView;
                if (!view) return;
                try {
                    isRestoringSearchState = true;
                    if (restoreSearch || restoreReplace) {
                        view.dispatch({
                            effects: setSearchQuery.of(
                                new SearchQuery({
                                    search: restoreSearch,
                                    caseSensitive: restoreCase,
                                    wholeWord: restoreWord,
                                    regexp: restoreRegex,
                                    replace: restoreReplace,
                                }),
                            ),
                        });
                    }
                    if (shouldRestoreOpen) {
                        openSearchPanel(view);
                    }
                } catch (err) {
                    console.warn("[Editor] restore search panel failed:", err);
                } finally {
                    queueMicrotask(() => {
                        isRestoringSearchState = false;
                    });
                }
            });
        }

        // Notify plugins that the editor/file changed so toolbars,
        // context menus, and other UI can mount or update.
        requestAnimationFrame(() => {
            document.dispatchEvent(new CustomEvent("mindzj:workspace-trigger", {
                detail: { event: "active-leaf-change" },
            }));
            document.dispatchEvent(new CustomEvent("mindzj:workspace-trigger", {
                detail: { event: "layout-change" },
            }));
            document.dispatchEvent(new CustomEvent("mindzj:workspace-trigger", {
                detail: { event: "file-open" },
            }));
        });

        // Continuously track the top-visible line as the user scrolls
        // so mode-switches can always restore the correct position.
        installScrollTracker(editorView);

        // Force a full measure + decoration flush on the next animation
        // frame. Without this, switching INTO live-preview mode from
        // another mode left the editor visually blank until the user
        // clicked or scrolled — CM6 had the decorations computed but
        // hadn't painted them yet because the container's layout wasn't
        // ready when `new EditorView` ran. `requestMeasure` + a no-op
        // dispatch triggers the viewport pass that actually draws the
        // decorations.
        requestAnimationFrame(() => {
            if (!editorView) return;
            editorView.requestMeasure();
            editorView.dispatch({});
        });
    }

    function moveCursorByLogicalLine(view: EditorView, direction: -1 | 1, extend: boolean): boolean {
        const selection = view.state.selection.main;
        const currentLine = view.state.doc.lineAt(selection.head);
        const targetLineNumber = currentLine.number + direction;
        if (targetLineNumber < 1 || targetLineNumber > view.state.doc.lines) {
            return false;
        }

        const targetLine = view.state.doc.line(targetLineNumber);
        const column = selection.head - currentLine.from;
        const targetPos = Math.min(targetLine.from + column, targetLine.to);
        view.dispatch({
            selection: extend
                ? EditorSelection.range(selection.anchor, targetPos)
                : EditorSelection.cursor(targetPos),
            effects: EditorView.scrollIntoView(targetPos),
        });
        return true;
    }

    function moveCursorToLogicalLineBoundary(
        view: EditorView,
        boundary: "start" | "end",
        extend: boolean,
    ): boolean {
        const selection = view.state.selection.main;
        const line = view.state.doc.lineAt(selection.head);
        const targetPos = boundary === "start" ? line.from : line.to;
        view.dispatch({
            selection: extend
                ? EditorSelection.range(selection.anchor, targetPos)
                : EditorSelection.cursor(targetPos),
            scrollIntoView: true,
        });
        return true;
    }

    async function copySelection(view: EditorView) {
        const selection = view.state.selection.main;
        if (selection.empty) return;
        const text = view.state.sliceDoc(selection.from, selection.to);
        await navigator.clipboard.writeText(text).catch(() => {});
        view.focus();
    }

    async function cutSelection(view: EditorView) {
        const selection = view.state.selection.main;
        if (selection.empty) return;
        const text = view.state.sliceDoc(selection.from, selection.to);
        await navigator.clipboard.writeText(text).catch(() => {});
        view.dispatch({
            changes: { from: selection.from, to: selection.to, insert: "" },
            selection: { anchor: selection.from },
        });
        view.focus();
    }

    async function pasteFromClipboard(view: EditorView) {
        const text = await navigator.clipboard.readText().catch(() => "");
        if (!text) return;
        const selection = view.state.selection.main;
        view.dispatch({
            changes: { from: selection.from, to: selection.to, insert: text },
            selection: { anchor: selection.from + text.length },
        });
        view.focus();
    }

    function selectAllContent(view: EditorView) {
        view.dispatch({
            selection: {
                anchor: 0,
                head: view.state.doc.length,
            },
        });
        view.focus();
    }

    function buildEditorContextMenu(view: EditorView): MenuItem[] {
        return [
            {
                label: t("toolbar.undo"),
                action: () => { undo(view); },
            },
            {
                label: t("toolbar.redo"),
                action: () => { redo(view); },
            },
            {
                label: t("context.cut"),
                action: () => { void cutSelection(view); },
                separator: true,
            },
            {
                label: t("common.copy"),
                action: () => { void copySelection(view); },
            },
            {
                label: t("context.paste"),
                action: () => { void pasteFromClipboard(view); },
            },
            {
                label: t("context.selectAll"),
                action: () => { selectAllContent(view); },
                separator: true,
            },
            {
                label: t("toolbar.bold"),
                action: () => { wrapSelection(view, "**"); },
            },
            {
                label: t("toolbar.italic"),
                action: () => { wrapSelection(view, "*"); },
            },
            {
                label: t("toolbar.code"),
                action: () => { wrapSelection(view, "`"); },
            },
            {
                label: t("toolbar.link"),
                action: () => { insertLink(view); },
                separator: true,
            },
            {
                label: t("toolbar.bulletList"),
                action: () => { dispatchEditorCommand({ command: "bullet-list" }); },
            },
            {
                label: t("toolbar.numberedList"),
                action: () => { dispatchEditorCommand({ command: "numbered-list" }); },
            },
            {
                label: t("toolbar.quote"),
                action: () => { dispatchEditorCommand({ command: "quote" }); },
                separator: true,
            },
            {
                label: t("context.editMode"),
                action: () => {
                    activatePane();
                    editorStore.setViewMode("live-preview", currentFilePath ?? undefined);
                },
                separator: true,
            },
            {
                label: t("context.sourceMode"),
                action: () => {
                    activatePane();
                    editorStore.setViewMode("source", currentFilePath ?? undefined);
                },
            },
            {
                label: t("context.readingView"),
                action: () => {
                    activatePane();
                    editorStore.setViewMode("reading", currentFilePath ?? undefined);
                },
            },
        ];
    }

    function wrapSelection(
        view: EditorView,
        before: string,
        after?: string,
    ): boolean {
        const sel = view.state.selection.main;
        const text = view.state.sliceDoc(sel.from, sel.to);
        const wrappedAfter = after ?? before;
        const replacement = `${before}${text || "text"}${wrappedAfter}`;
        view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: replacement },
            selection: {
                anchor: sel.from + before.length,
                head: sel.from + before.length + (text.length || 4),
            },
        });
        return true;
    }

    function insertLink(view: EditorView): boolean {
        const sel = view.state.selection.main;
        const text = view.state.sliceDoc(sel.from, sel.to);
        const replacement = `[${text || "text"}](url)`;
        view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: replacement },
            selection: {
                anchor: sel.from + text.length + 3,
                head: sel.from + text.length + 6,
            },
        });
        return true;
    }

    function wrapSelectionWithHtmlTag(
        view: EditorView,
        openTag: string,
        closeTag: string,
    ): boolean {
        return wrapSelection(view, openTag, closeTag);
    }

    // Set heading level (0 = remove heading, 1-6 = H1-H6)
    function setHeading(view: EditorView, level: number): boolean {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        const existingMatch = line.text.match(/^#{1,6}\s*/);
        const removeLen = existingMatch ? existingMatch[0].length : 0;
        const prefix = level > 0 ? "#".repeat(level) + " " : "";
        const contentOffset = line.text.trim().length === 0
            ? 0
            : Math.max(0, pos - line.from - removeLen);
        const nextCursor = line.from + prefix.length + contentOffset;
        view.dispatch({
            changes: { from: line.from, to: line.from + removeLen, insert: prefix },
            selection: { anchor: nextCursor },
        });
        return true;
    }

    // Delete the current line
    function deleteLine(view: EditorView): boolean {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        const from = line.from;
        const to = line.number < view.state.doc.lines ? line.to + 1 : (line.from > 0 ? line.from - 1 : line.to);
        view.dispatch({ changes: { from: Math.max(0, from > 0 && line.number === view.state.doc.lines ? from - 1 : from), to } });
        return true;
    }

    // Indent entire line from the start (for Ctrl+] / Ctrl+[)
    function indentLineFromStart(view: EditorView, indent: boolean): boolean {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        if (indent) {
            view.dispatch({ changes: { from: line.from, insert: "\t" } });
        } else {
            const match = line.text.match(/^(\t| {1,4})/);
            if (match) {
                view.dispatch({ changes: { from: line.from, to: line.from + match[0].length } });
            }
        }
        return true;
    }

    // Insert line below current line
    function insertLineBelow(view: EditorView): boolean {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        view.dispatch({
            changes: { from: line.to, insert: "\n" },
            selection: { anchor: line.to + 1 },
        });
        return true;
    }

    // Insert line above current line
    function insertLineAbove(view: EditorView): boolean {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        view.dispatch({
            changes: { from: line.from, insert: "\n" },
            selection: { anchor: line.from },
        });
        return true;
    }

    // Move line up or down
    function moveLine(view: EditorView, direction: number): boolean {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        if (direction === -1 && line.number === 1) return true;
        if (direction === 1 && line.number === view.state.doc.lines) return true;

        const targetLine = view.state.doc.line(line.number + direction);
        if (direction === -1) {
            // Swap with line above
            view.dispatch({
                changes: [
                    { from: targetLine.from, to: line.to, insert: line.text + "\n" + targetLine.text },
                ],
                selection: { anchor: targetLine.from + (pos - line.from) },
            });
        } else {
            // Swap with line below
            view.dispatch({
                changes: [
                    { from: line.from, to: targetLine.to, insert: targetLine.text + "\n" + line.text },
                ],
                selection: { anchor: line.from + targetLine.text.length + 1 + (pos - line.from) },
            });
        }
        return true;
    }

    // Duplicate current line
    function duplicateLine(view: EditorView): boolean {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        view.dispatch({
            changes: { from: line.to, insert: "\n" + line.text },
            selection: { anchor: line.to + 1 + (pos - line.from) },
        });
        return true;
    }

    // Toggle HTML comment on current line
    function toggleComment(view: EditorView): boolean {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        const trimmed = line.text.trim();
        if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) {
            // Unwrap comment
            const inner = trimmed.slice(4, -3).trim();
            view.dispatch({ changes: { from: line.from, to: line.to, insert: inner } });
        } else {
            // Wrap in comment
            view.dispatch({ changes: { from: line.from, to: line.to, insert: `<!-- ${line.text} -->` } });
        }
        return true;
    }

    // Toggle blockquote on current line
    function toggleBlockquote(view: EditorView): boolean {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        if (line.text.startsWith("> ")) {
            view.dispatch({ changes: { from: line.from, to: line.from + 2 } });
        } else {
            view.dispatch({ changes: { from: line.from, insert: "> " } });
        }
        return true;
    }

    // Handle force save event
    onMount(() => {
        const handleForceSave = () => {
            if (!isPaneActive()) return;
            if (editorView) {
                const content = editorView.state.doc.toString();
                if (currentFilePath) {
                    editorStore.forceSave(currentFilePath, content);
                }
            }
        };

        const handleToggleViewModeWithSave = async (event: Event) => {
            if (!isPaneActive()) return;
            if (!editorView || !currentFilePath) return;
            const detail = (event as CustomEvent<{
                path?: string | null;
                release?: () => void;
            }>).detail;
            if (detail?.path && detail.path !== currentFilePath) return;

            event.preventDefault();
            const release = detail?.release;
            const content = editorView.state.doc.toString();
            try {
                const savedContent = resolvedFile()?.content ?? "";
                if (
                    editorStore.isDirtyPath(currentFilePath) ||
                    content !== savedContent
                ) {
                    await editorStore.forceSave(currentFilePath, content, {
                        suppressSavedEvent: true,
                    });
                }
                editorStore.toggleReadingMode(currentFilePath);
            } catch (error) {
                console.error("Toggle view mode save failed:", error);
            } finally {
                // Release the App-level reentrancy guard so the NEXT Ctrl+E
                // press (e.g. toggling back to editor) isn't swallowed.
                release?.();
            }
        };

        const handleEditorCommand = (e: Event) => {
            if (!isPaneActive()) return;
            if (!editorView) return;
            const detail = (e as CustomEvent).detail;
            dispatchEditorCommand(detail);
        };

        // Insert text at cursor (used by screenshot tool, paste handlers, etc.)
        const handleInsertText = (e: Event) => {
            if (!isPaneActive()) return;
            if (!editorView) return;
            const text = (e as CustomEvent).detail?.text;
            if (!text) return;
            const { state } = editorView;
            const cursor = state.selection.main.head;
            // Insert on a new line after the current line
            const line = state.doc.lineAt(cursor);
            const insertPos = line.to;
            const insert = "\n" + text + "\n";
            editorView.dispatch({
                changes: { from: insertPos, insert },
                selection: { anchor: insertPos + insert.length },
            });
        };

        document.addEventListener("mindzj:force-save", handleForceSave);
        document.addEventListener(
            "mindzj:toggle-view-mode-with-save",
            handleToggleViewModeWithSave,
        );
        document.addEventListener("mindzj:editor-command", handleEditorCommand);
        document.addEventListener("mindzj:insert-text", handleInsertText);

        onCleanup(() => {
            document.removeEventListener("mindzj:force-save", handleForceSave);
            document.removeEventListener(
                "mindzj:toggle-view-mode-with-save",
                handleToggleViewModeWithSave,
            );
            document.removeEventListener(
                "mindzj:editor-command",
                handleEditorCommand,
            );
            document.removeEventListener("mindzj:insert-text", handleInsertText);
            // Persist undo/redo history BEFORE destroying the view so
            // the next Editor remount (e.g. after exiting reading mode)
            // can restore the chain. This is the Ctrl+E toggle path —
            // SolidJS unmounts the whole component when switching to
            // reading mode, so the createEffect-based persist sites
            // above don't cover it.
            persistCurrentHistory();
            if (editorView) {
                editorView.destroy();
                editorView = null;
            }
            syncPluginEditorBindings(null);
            editorStore.cleanup();
        });
    });

    function dispatchEditorCommand(detail: any) {
        if (!editorView) return;
        const view = editorView;

        switch (detail.command) {
            case "bold":
                wrapSelection(view, "**");
                break;
            case "italic":
                wrapSelection(view, "*");
                break;
            case "strikethrough":
                wrapSelection(view, "~~");
                break;
            case "underline":
                wrapSelection(view, "<u>", "</u>");
                break;
            case "highlight":
                wrapSelection(view, "==");
                break;
            case "code":
                wrapSelection(view, "`");
                break;
            case "link":
                insertLink(view);
                break;
            case "heading": {
                const level = detail.level ?? 2;
                setHeading(view, level);
                break;
            }
            case "codeblock": {
                const sel = view.state.selection.main;
                const text = view.state.sliceDoc(sel.from, sel.to);
                const insert = `\`\`\`\n${text}\n\`\`\``;
                view.dispatch({
                    changes: {
                        from: sel.from,
                        to: sel.to,
                        insert,
                    },
                    selection: {
                        anchor: sel.from + 3,
                    },
                });
                break;
            }
            case "table": {
                const pos = view.state.selection.main.head;
                view.dispatch({
                    changes: {
                        from: pos,
                        insert:
                            `\n| ${t("editor.tableHeader")}1 | ${t("editor.tableHeader")}2 | ${t("editor.tableHeader")}3 |\n` +
                            `| --- | --- | --- |\n` +
                            `| ${t("editor.tableCell")} | ${t("editor.tableCell")} | ${t("editor.tableCell")} |\n`,
                    },
                });
                break;
            }
            case "horizontal-rule": {
                const pos = view.state.selection.main.head;
                view.dispatch({ changes: { from: pos, insert: "\n---\n" } });
                break;
            }
            case "task-list": {
                const pos = view.state.selection.main.head;
                const line = view.state.doc.lineAt(pos);
                const prefix = "- [ ] ";
                view.dispatch({
                    changes: { from: line.from, insert: prefix },
                    selection: { anchor: line.to + prefix.length },
                });
                break;
            }
            case "bullet-list": {
                const pos = view.state.selection.main.head;
                const line = view.state.doc.lineAt(pos);
                view.dispatch({ changes: { from: line.from, insert: "- " } });
                break;
            }
            case "numbered-list": {
                const pos = view.state.selection.main.head;
                const line = view.state.doc.lineAt(pos);
                view.dispatch({ changes: { from: line.from, insert: "1. " } });
                break;
            }
            case "toggle-checklist-status": {
                const pos = view.state.selection.main.head;
                const line = view.state.doc.lineAt(pos);
                const text = line.text;
                let replacement = text;
                if (text.startsWith("- [ ] ")) replacement = `- [x] ${text.slice(6)}`;
                else if (text.startsWith("- [x] ")) replacement = `- ${text.slice(6)}`;
                else if (text.startsWith("- ")) replacement = `- [ ] ${text.slice(2)}`;
                else replacement = `- [ ] ${text}`;
                view.dispatch({ changes: { from: line.from, to: line.to, insert: replacement } });
                break;
            }
            case "toggle-comment":
                toggleComment(view);
                break;
            case "tag":
                wrapSelection(view, "#");
                break;
            case "wikilink":
                wrapSelection(view, "[[", "]]");
                break;
            case "embed":
                wrapSelection(view, "![[", "]]");
                break;
            case "callout": {
                const sel = view.state.selection.main;
                const text = view.state.sliceDoc(sel.from, sel.to) || "Callout";
                view.dispatch({
                    changes: { from: sel.from, to: sel.to, insert: `> [!note]\n> ${text}` },
                    selection: { anchor: sel.from + 11 + text.length },
                });
                break;
            }
            case "mathblock": {
                const sel = view.state.selection.main;
                const text = view.state.sliceDoc(sel.from, sel.to) || "x = y";
                view.dispatch({
                    changes: { from: sel.from, to: sel.to, insert: `$$\n${text}\n$$` },
                    selection: { anchor: sel.from + 3, head: sel.from + 3 + text.length },
                });
                break;
            }
            case "move-line-up":
                moveLine(view, -1);
                break;
            case "move-line-down":
                moveLine(view, 1);
                break;
            case "clear-formatting": {
                const sel = view.state.selection.main;
                const text = view.state.sliceDoc(sel.from, sel.to);
                const cleared = text
                    .replace(/\*\*(.*?)\*\*/g, "$1")
                    .replace(/\*(.*?)\*/g, "$1")
                    .replace(/~~(.*?)~~/g, "$1")
                    .replace(/==(.*?)==/g, "$1")
                    .replace(/`(.*?)`/g, "$1")
                    .replace(/<u>(.*?)<\/u>/g, "$1");
                view.dispatch({
                    changes: { from: sel.from, to: sel.to, insert: cleared },
                    selection: { anchor: sel.from, head: sel.from + cleared.length },
                });
                break;
            }
            case "quote": {
                const pos = view.state.selection.main.head;
                const line = view.state.doc.lineAt(pos);
                view.dispatch({ changes: { from: line.from, insert: "> " } });
                break;
            }
            case "superscript":
                wrapSelectionWithHtmlTag(view, "<sup>", "</sup>");
                break;
            case "subscript":
                wrapSelectionWithHtmlTag(view, "<sub>", "</sub>");
                break;
            case "center":
                wrapSelectionWithHtmlTag(view, "<center>", "</center>");
                break;
            case "left":
                wrapSelectionWithHtmlTag(view, '<p align="left">', "</p>");
                break;
            case "right":
                wrapSelectionWithHtmlTag(view, '<p align="right">', "</p>");
                break;
            case "justify":
                wrapSelectionWithHtmlTag(view, '<p align="justify">', "</p>");
                break;
            case "goto-line": {
                // Scroll to a specific line number (0-based from Outline)
                // Position the heading at the TOP of the viewport (not center)
                // and paint a full-line flash on the heading row for
                // ~1s using the same colour as the search-reveal flash.
                // Flash is line-level (not mark-level) so the whole row
                // highlights, matching the "heading row background
                // block" UX requested by the user.
                const lineNum = Math.min(detail.line + 1, view.state.doc.lines);
                const lineInfo = view.state.doc.line(lineNum);
                view.dispatch({
                    selection: { anchor: lineInfo.from },
                    effects: [
                        EditorView.scrollIntoView(lineInfo.from, { y: "start", yMargin: 0 }),
                        addLineFlash.of(lineInfo.from),
                    ],
                });

                // Reuse the same flash timer that search-reveal uses —
                // re-clicks on the Outline while a flash is still
                // fading cancel the previous timer so the new one
                // survives its full lifetime.
                if (searchFlashTimer) {
                    clearTimeout(searchFlashTimer);
                    searchFlashTimer = null;
                }
                const targetView = view;
                searchFlashTimer = setTimeout(() => {
                    searchFlashTimer = null;
                    try {
                        targetView.dispatch({
                            effects: clearSearchFlash.of(null),
                        });
                    } catch {
                        // View destroyed between dispatch and timeout —
                        // safe to ignore, the StateField is gone too.
                    }
                }, 1000);
                break;
            }
            case "search-reveal": {
                // Open the file at `detail.line` (0-based), find the
                // first occurrence of `detail.query` on that line,
                // select it, scroll it into the MIDDLE of the
                // viewport, and paint a flash highlight on top that
                // fades out after ~1.5s.
                //
                // We don't trust `highlight_start/highlight_end` from
                // the search backend because those are UTF-8 BYTE
                // offsets but CodeMirror positions are UTF-16 code
                // units — mapping between them on every result would
                // require round-tripping through TextEncoder and is
                // easy to get wrong for multi-byte content. Doing a
                // fresh case-insensitive `indexOf` on the line in JS
                // space gives us a correct match for any encoding.
                const line0 = typeof detail.line === "number" ? detail.line : 0;
                const query: string = typeof detail.query === "string"
                    ? detail.query
                    : "";
                const lineNum = Math.max(
                    1,
                    Math.min(line0 + 1, view.state.doc.lines),
                );
                const lineInfo = view.state.doc.line(lineNum);
                const lineText = lineInfo.text;

                let from = lineInfo.from;
                let to = lineInfo.from;
                if (query) {
                    const idx = lineText
                        .toLowerCase()
                        .indexOf(query.toLowerCase());
                    if (idx >= 0) {
                        from = lineInfo.from + idx;
                        to = from + query.length;
                    }
                }

                // Scroll so the match lands roughly in the middle
                // of the viewport — feels more like "jump to" than
                // landing on the last visible row. `yMargin: 60`
                // keeps the flash away from the very top/bottom.
                view.dispatch({
                    selection: { anchor: from, head: to },
                    effects: [
                        EditorView.scrollIntoView(from, {
                            y: "center",
                            yMargin: 60,
                        }),
                        // Only fire the flash if we actually found
                        // the match (from !== to). Otherwise we'd
                        // paint a 0-width decoration that renders
                        // nothing but still goes through the
                        // clear-timer dance.
                        ...(to > from ? [addSearchFlash.of({ from, to })] : []),
                    ],
                });

                if (to > from) {
                    // Cancel any previous flash timer so re-clicks
                    // on a different search result don't let the
                    // OLD timer fire mid-flash and clear the NEW
                    // decoration 0.3s after it appears.
                    if (searchFlashTimer) {
                        clearTimeout(searchFlashTimer);
                        searchFlashTimer = null;
                    }
                    // Clear the flash after 1.5s. Capture the view
                    // reference in a closure so a later file switch
                    // doesn't accidentally clear decorations on the
                    // wrong document.
                    const targetView = view;
                    searchFlashTimer = setTimeout(() => {
                        searchFlashTimer = null;
                        try {
                            targetView.dispatch({
                                effects: clearSearchFlash.of(null),
                            });
                        } catch {
                            // View may have been destroyed — safe
                            // to ignore, StateField is gone too.
                        }
                    }, 1500);
                }
                break;
            }
        }
        view.focus();
    }

    return (
        <div
            style={{
                flex: "1",
                "min-height": "0",
                overflow: "hidden",
                background: "var(--mz-bg-primary)",
                position: "relative",
            }}
        >
            <div
                ref={containerRef}
                style={{
                    width: "100%",
                    height: "100%",
                    visibility: "hidden",
                }}
            />
            <Show when={contextMenu()}>
                {(menu) => (
                    <ContextMenu
                        x={menu().x}
                        y={menu().y}
                        items={menu().items}
                        onClose={closeContextMenu}
                    />
                )}
            </Show>
        </div>
    );
};
