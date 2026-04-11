/**
 * Link handler extension for CodeMirror 6
 *
 * Features:
 * 1. Ctrl+Click on links to navigate:
 *    - Wiki links [[page]] → open file in vault
 *    - Markdown links [text](url) → open file or external URL
 *    - Footnote refs [^id] → jump to footnote definition
 * 2. [[ autocomplete for wiki links (file name suggestions)
 * 3. Visual feedback: underline links on Ctrl hover
 */

import { EditorView, ViewPlugin } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import {
    autocompletion,
    startCompletion,
    CompletionContext,
    CompletionResult,
    Completion,
} from "@codemirror/autocomplete";
import { t } from "../../../i18n";
import { vaultStore, type VaultEntry } from "../../../stores/vault";
import { openFileRouted } from "../../../utils/openFileRouted";

// ---------------------------------------------------------------------------
// Helper: get the current EditorView from the global plugin API
// ---------------------------------------------------------------------------

function getEditorView(): EditorView | undefined {
    return (window as any).__mindzj_plugin_editor_api?.cm as EditorView | undefined;
}

// ---------------------------------------------------------------------------
// Link click handler
// ---------------------------------------------------------------------------

function handleLinkClick(view: EditorView, pos: number, _event: MouseEvent): boolean {
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    const col = pos - line.from;

    // Check for wiki link at cursor position: [[target]] or [[target|display]]
    const wikiRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = wikiRegex.exec(text)) !== null) {
        if (col >= match.index && col <= match.index + match[0].length) {
            const target = match[1].trim();
            navigateToFile(target);
            return true;
        }
    }

    // Check for markdown link at cursor: [text](url)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    while ((match = linkRegex.exec(text)) !== null) {
        if (col >= match.index && col <= match.index + match[0].length) {
            const url = match[2].trim();
            if (url.startsWith("http://") || url.startsWith("https://")) {
                // External link - open in browser
                window.open(url, "_blank");
            } else {
                // Internal link - open file
                navigateToFile(url);
            }
            return true;
        }
    }

    // Check for footnote reference: [^id]
    const fnRegex = /\[\^([^\]]+)\]/g;
    while ((match = fnRegex.exec(text)) !== null) {
        if (col >= match.index && col <= match.index + match[0].length) {
            const fnId = match[1];
            // Jump to footnote definition
            jumpToFootnote(view, fnId);
            return true;
        }
    }

    return false;
}

/**
 * Navigate to a file, optionally jumping to a specific heading.
 * Supports [[page#heading]] syntax: the part after # is the heading text.
 */
async function navigateToFile(target: string): Promise<void> {
    let filePath = target;
    let heading: string | null = null;

    // Split on first # for heading anchors: "page#heading"
    const hashIdx = filePath.indexOf("#");
    if (hashIdx >= 0) {
        heading = filePath.slice(hashIdx + 1).trim();
        filePath = filePath.slice(0, hashIdx).trim();
    }

    // Add .md extension if not present (and there's a file part)
    if (filePath && !filePath.includes(".")) {
        filePath += ".md";
    }

    try {
        if (filePath) {
            // Route via openFileRouted so an editor wikilink to an
            // image / .doc / .pdf opens in the right viewer rather
            // than feeding raw bytes to the markdown editor.
            await openFileRouted(filePath);
        }

        // After opening (or if same file), jump to anchor
        if (heading) {
            // Delay to let editor rebuild after file open, then poll
            // until the new EditorView is available.
            const initialDelay = filePath ? 150 : 0;
            const tryJump = (retries: number) => {
                const view = getEditorView();
                if (view) {
                    jumpToAnchor(view, heading!);
                } else if (retries > 0) {
                    setTimeout(() => tryJump(retries - 1), 50);
                }
            };
            setTimeout(() => tryJump(20), initialDelay);
        }
    } catch {
        console.warn(`Could not open file: ${filePath}`);
    }
}

/**
 * Jump to a heading OR exact line text in the current editor view.
 * First tries to match a heading (# title). If no heading matches,
 * falls back to finding any line whose trimmed text matches the anchor.
 * This supports both [[page#Heading]] and Ctrl+Alt+C/V arbitrary anchors.
 */
function jumpToAnchor(view: EditorView, anchor: string): void {
    const doc = view.state.doc;
    const lowerAnchor = anchor.toLowerCase();

    /** Place cursor and scroll the matched line to the TOP of the viewport. */
    function scrollToLine(pos: number) {
        view.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 10 }),
        });
        view.focus();
    }

    // Pass 1: match headings
    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const match = line.text.match(/^#{1,6}\s+(.+)$/);
        if (match) {
            const text = match[1].trim().toLowerCase();
            if (text === lowerAnchor || text.replace(/\s+/g, "-") === lowerAnchor) {
                scrollToLine(line.from);
                return;
            }
        }
    }

    // Pass 2: match any line whose trimmed text equals the anchor
    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (line.text.trim().toLowerCase() === lowerAnchor) {
            scrollToLine(line.from);
            return;
        }
    }

    // Pass 3: match any line that contains the anchor text
    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (line.text.toLowerCase().includes(lowerAnchor)) {
            scrollToLine(line.from);
            return;
        }
    }
}

function jumpToFootnote(view: EditorView, fnId: string): void {
    const doc = view.state.doc;
    const searchPattern = `[^${fnId}]:`;

    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (line.text.startsWith(searchPattern)) {
            view.dispatch({
                selection: { anchor: line.from + searchPattern.length },
                scrollIntoView: true,
            });
            view.focus();
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Ctrl hover visual feedback
// ---------------------------------------------------------------------------

/**
 * Link click handler — uses MOUSEDOWN so we intercept BEFORE CodeMirror
 * moves the cursor (which would make the line the "cursor line" and
 * strip the `.mz-lp-link` decoration, making it impossible to detect).
 *
 * Logic:
 * - Ctrl/Meta + click: always navigate (any line).
 * - Plain click on a `.mz-lp-link` element (rendered link on a
 *   non-cursor line): navigate directly.
 * - Everything else: fall through → CM6 places cursor for editing.
 */
const linkClickHandler = EditorView.domEventHandlers({
    mousedown(event: MouseEvent, view: EditorView) {
        // --- Ctrl+Click always navigates ---
        if (event.ctrlKey || event.metaKey) {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            // Delay slightly so CM6 doesn't also move cursor
            event.preventDefault();
            handleLinkClick(view, pos, event);
            return true;
        }

        // --- Plain click on a rendered link (non-cursor line) ---
        const target = event.target as HTMLElement;
        if (target.closest(".mz-lp-link")) {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;

            // Verify this is NOT the cursor line (double-check: on cursor
            // line the decoration should be stripped, but just to be safe)
            const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
            const clickLine = view.state.doc.lineAt(pos).number;
            if (clickLine === cursorLine) return false; // editing mode on this line

            event.preventDefault();
            handleLinkClick(view, pos, event);
            return true;
        }

        return false;
    },
});

const ctrlHoverStyle = EditorView.baseTheme({
    "&.mz-ctrl-held .mz-lp-link": {
        textDecoration: "underline",
        cursor: "pointer",
    },
    "&.mz-ctrl-held .mz-lp-footnote": {
        textDecoration: "underline",
        cursor: "pointer",
    },
});

const ctrlHoverPlugin = ViewPlugin.fromClass(
    class {
        private handleKeyDown: (e: KeyboardEvent) => void;
        private handleKeyUp: (e: KeyboardEvent) => void;

        constructor(private view: EditorView) {
            this.handleKeyDown = (e) => {
                if (e.key === "Control" || e.key === "Meta") {
                    view.dom.classList.add("mz-ctrl-held");
                }
            };
            this.handleKeyUp = (e) => {
                if (e.key === "Control" || e.key === "Meta") {
                    view.dom.classList.remove("mz-ctrl-held");
                }
            };
            document.addEventListener("keydown", this.handleKeyDown);
            document.addEventListener("keyup", this.handleKeyUp);
        }

        destroy() {
            document.removeEventListener("keydown", this.handleKeyDown);
            document.removeEventListener("keyup", this.handleKeyUp);
            this.view.dom.classList.remove("mz-ctrl-held");
        }
    },
);

// ---------------------------------------------------------------------------
// Wiki link autocomplete: [[filename
// ---------------------------------------------------------------------------

/** Flatten vault entries to a list of relative paths */
function flattenEntries(entries: VaultEntry[], prefix = ""): string[] {
    const result: string[] = [];
    for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.is_dir) {
            if (entry.children) {
                result.push(...flattenEntries(entry.children, path));
            }
        } else {
            result.push(path);
        }
    }
    return result;
}

/** Cache for file headings (avoids re-reading on every keystroke) */
const _headingCache = new Map<string, { headings: string[]; ts: number }>();

/** Extract headings from a file's content */
function extractHeadings(content: string): string[] {
    const headings: string[] = [];
    for (const line of content.split("\n")) {
        const m = line.match(/^(#{1,6})\s+(.+)$/);
        if (m) headings.push(m[2].trim());
    }
    return headings;
}

/** Get headings for a file path (with caching) */
async function getFileHeadings(filePath: string): Promise<string[]> {
    const cached = _headingCache.get(filePath);
    if (cached && Date.now() - cached.ts < 5000) return cached.headings;
    try {
        const result = await invoke<{ content: string }>("read_file", { relativePath: filePath });
        const headings = extractHeadings(result.content);
        _headingCache.set(filePath, { headings, ts: Date.now() });
        return headings;
    } catch {
        return [];
    }
}

/**
 * Two-level wiki link autocomplete:
 *
 *  [[query     → file name completions (all .md files matching query)
 *  [[file#     → heading completions from that specific file
 *  [[file#que  → heading completions filtered by query
 */
function wikiLinkCompletions(context: CompletionContext): CompletionResult | null {
    const before = context.matchBefore(/\[\[([^\]]*)/);
    if (!before) return null;

    const inner = before.text.slice(2); // text after [[
    const from = before.from + 2;

    // Check if we're in the "#heading" part
    const hashIdx = inner.indexOf("#");

    if (hashIdx >= 0) {
        // ─── Phase 2: heading completions ───
        const fileQuery = inner.slice(0, hashIdx);
        const headingQuery = inner.slice(hashIdx + 1).toLowerCase();
        const headingFrom = from + hashIdx + 1; // position after #

        // Find the file
        const entries = vaultStore.fileTree();
        const allPaths = flattenEntries(entries);
        let filePath = allPaths.find(
            (p) => p.endsWith(".md") && p.replace(/\.md$/, "").toLowerCase() === fileQuery.toLowerCase(),
        );
        if (!filePath) {
            filePath = allPaths.find(
                (p) => p.endsWith(".md") && p.replace(/\.md$/, "").toLowerCase().includes(fileQuery.toLowerCase()),
            );
        }
        if (!filePath) return null;

        // Use async completion: return a promise-based result
        // Since CodeMirror autocomplete supports async via completionSource,
        // but our override function must return synchronously, we use the
        // currently cached headings or trigger a background fetch.
        const cached = _headingCache.get(filePath);
        if (!cached) {
            // Trigger background fetch and return empty for now
            getFileHeadings(filePath).then(() => {
                // Explicitly open the autocomplete panel after headings load
                const view = getEditorView();
                if (view) {
                    setTimeout(() => startCompletion(view), 50);
                }
            });
            return { from: headingFrom, options: [{ label: t("common.loading"), type: "text", apply: "" }], validFor: /^[^\]#]*$/ };
        }

        const options: Completion[] = cached.headings
            .filter((h) => !headingQuery || h.toLowerCase().includes(headingQuery))
            .map((h) => ({
                label: h,
                type: "property",
                detail: t("linkHandler.heading"),
                apply: h,
            }))
            .slice(0, 50);

        if (options.length === 0) return null;
        return { from: headingFrom, options, validFor: /^[^\]#]*$/ };
    }

    // ─── Phase 1: file name completions ───
    const query = inner.toLowerCase();
    const entries = vaultStore.fileTree();
    const allPaths = flattenEntries(entries);

    const options: Completion[] = allPaths
        .filter((p) => p.endsWith(".md"))
        .map((p) => {
            const name = p.replace(/\.md$/, "");
            return { label: name, type: "file", detail: p };
        })
        .filter((opt) => query === "" || opt.label.toLowerCase().includes(query))
        .slice(0, 50);

    if (options.length === 0) return null;

    return {
        from,
        options,
        validFor: /^[^\]#]*$/,
    };
}

// ---------------------------------------------------------------------------
// Ctrl+Alt+C / Ctrl+Alt+V — link anchor copy/paste
// ---------------------------------------------------------------------------

/**
 * Ctrl+Alt+C: copy the selected text as a link anchor reference.
 *   Stores `filename#heading` or `filename#line-text` in a session var.
 *
 * Ctrl+Alt+V: paste a wiki link to the previously copied anchor.
 */
let _linkAnchorClipboard: string | null = null;

const linkAnchorHandler = EditorView.domEventHandlers({
    keydown(event: KeyboardEvent, view: EditorView) {
        if (!(event.ctrlKey || event.metaKey) || !event.altKey) return false;

        if (event.key === "c" || event.key === "C") {
            // Copy: take the current selection (or the line text) as anchor
            const sel = view.state.selection.main;
            const line = view.state.doc.lineAt(sel.head);
            const activeFile = vaultStore.activeFile();
            if (!activeFile) return false;

            const fileName = activeFile.path.replace(/\.md$/, "");
            let anchor: string;

            // Check if the line is a heading
            const headingMatch = line.text.match(/^(#{1,6})\s+(.+)$/);
            if (headingMatch) {
                anchor = headingMatch[2].trim();
            } else if (sel.from !== sel.to) {
                // Use selected text
                anchor = view.state.sliceDoc(sel.from, sel.to).trim();
            } else {
                // Use full line text
                anchor = line.text.trim();
            }

            _linkAnchorClipboard = `${fileName}#${anchor}`;
            event.preventDefault();
            return true;
        }

        if (event.key === "v" || event.key === "V") {
            if (!_linkAnchorClipboard) return false;
            // Insert wiki link at cursor
            const link = `[[${_linkAnchorClipboard}]]`;
            const { head } = view.state.selection.main;
            view.dispatch({
                changes: { from: head, insert: link },
                selection: { anchor: head + link.length },
            });
            event.preventDefault();
            return true;
        }

        return false;
    },
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function linkHandlerExtension(): Extension {
    return [
        linkClickHandler,
        ctrlHoverStyle,
        ctrlHoverPlugin,
        linkAnchorHandler,
        autocompletion({
            override: [wikiLinkCompletions],
            activateOnTyping: true,
        }),
    ];
}
