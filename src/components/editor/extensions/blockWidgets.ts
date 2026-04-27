/**
 * Block-level widgets for MindZJ Live Preview
 *
 * Handles multi-line constructs:
 * - Fenced code blocks with Shiki syntax highlighting
 * - Math blocks ($$...$$) with KaTeX rendering
 * - Callout/admonition blocks (> [!type] title)
 * - Mermaid diagram rendering
 */

import {
    Decoration,
    DecorationSet,
    EditorView,
    WidgetType,
} from "@codemirror/view";
import { StateField, Transaction } from "@codemirror/state";
import katex from "katex";
import { createHighlighter, type Highlighter } from "shiki";
import { t } from "../../../i18n";

// ---------------------------------------------------------------------------
// Shiki singleton (lazy-loaded)
// ---------------------------------------------------------------------------

let shikiInstance: Highlighter | null = null;
let shikiLoading: Promise<Highlighter> | null = null;

async function getShiki(): Promise<Highlighter> {
    if (shikiInstance) return shikiInstance;
    if (shikiLoading) return shikiLoading;

    shikiLoading = createHighlighter({
        themes: ["github-dark", "github-light"],
        langs: [
            "javascript",
            "typescript",
            "python",
            "rust",
            "go",
            "java",
            "c",
            "cpp",
            "csharp",
            "html",
            "css",
            "json",
            "yaml",
            "toml",
            "bash",
            "shell",
            "sql",
            "markdown",
            "jsx",
            "tsx",
            "lua",
            "ruby",
            "php",
            "swift",
            "kotlin",
            "dart",
            "zig",
            "haskell",
        ],
    }).then((h) => {
        shikiInstance = h;
        return h;
    });

    return shikiLoading;
}

// Eagerly start loading Shiki
getShiki();

// ---------------------------------------------------------------------------
// Callout type definitions 
// ---------------------------------------------------------------------------

interface CalloutDef {
    icon: string;
    color: string;
}

const CALLOUT_TYPES: Record<string, CalloutDef> = {
    note: { icon: "📝", color: "var(--mz-callout-note)" },
    abstract: { icon: "📋", color: "var(--mz-callout-info)" },
    summary: { icon: "📋", color: "var(--mz-callout-info)" },
    info: { icon: "ℹ️", color: "var(--mz-callout-info)" },
    tip: { icon: "💡", color: "var(--mz-callout-tip)" },
    hint: { icon: "💡", color: "var(--mz-callout-tip)" },
    important: { icon: "🔥", color: "var(--mz-callout-warning)" },
    success: { icon: "✅", color: "var(--mz-callout-tip)" },
    check: { icon: "✅", color: "var(--mz-callout-tip)" },
    done: { icon: "✅", color: "var(--mz-callout-tip)" },
    question: { icon: "❓", color: "var(--mz-callout-warning)" },
    help: { icon: "❓", color: "var(--mz-callout-warning)" },
    faq: { icon: "❓", color: "var(--mz-callout-warning)" },
    warning: { icon: "⚠️", color: "var(--mz-callout-warning)" },
    caution: { icon: "⚠️", color: "var(--mz-callout-warning)" },
    attention: { icon: "⚠️", color: "var(--mz-callout-warning)" },
    failure: { icon: "❌", color: "var(--mz-callout-danger)" },
    fail: { icon: "❌", color: "var(--mz-callout-danger)" },
    missing: { icon: "❌", color: "var(--mz-callout-danger)" },
    danger: { icon: "🔴", color: "var(--mz-callout-danger)" },
    error: { icon: "⛔", color: "var(--mz-callout-danger)" },
    bug: { icon: "🐛", color: "var(--mz-callout-danger)" },
    example: { icon: "📖", color: "var(--mz-callout-note)" },
    quote: { icon: "❝", color: "var(--mz-text-muted)" },
    cite: { icon: "❝", color: "var(--mz-text-muted)" },
};

// ---------------------------------------------------------------------------
// Widget: Syntax-highlighted code block
// ---------------------------------------------------------------------------

class CodeBlockWidget extends WidgetType {
    private cachedHtml: string | null = null;

    constructor(
        private code: string,
        private lang: string,
        _id: string,
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const wrapper = document.createElement("div");
        wrapper.className = "mz-block-code";

        // Language badge
        if (this.lang) {
            const badge = document.createElement("span");
            badge.className = "mz-block-code-lang";
            badge.textContent = this.lang;
            wrapper.appendChild(badge);
        }

        // Copy button
        const copyBtn = document.createElement("button");
        copyBtn.className = "mz-block-code-copy";
        copyBtn.textContent = t("common.copy");
        copyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(this.code).then(() => {
                copyBtn.textContent = t("common.copyDone");
                setTimeout(() => {
                    copyBtn.textContent = t("common.copy");
                }, 1500);
            });
        });
        wrapper.appendChild(copyBtn);

        // Code content
        const codeEl = document.createElement("div");
        codeEl.className = "mz-block-code-content";

        // Helper that adds `data-mz-source-line="N"` to each `<span class="line">`
        // (shiki output) or to each text line (plain fallback). The offsets are
        // 1-based within the source block (0 = opening fence).
        const annotateLines = () => {
            const spans = codeEl.querySelectorAll<HTMLElement>(
                "pre code .line, pre code > span, pre .line",
            );
            spans.forEach((el, idx) => {
                el.setAttribute("data-mz-source-line", String(idx + 1));
            });
        };

        if (this.cachedHtml) {
            codeEl.innerHTML = this.cachedHtml;
            wrapper.appendChild(codeEl);
            annotateLines();
        } else {
            // Render plain first, then upgrade with Shiki
            const pre = document.createElement("pre");
            pre.style.cssText = "margin:0; padding:12px 16px; overflow-x:auto;";
            const code = document.createElement("code");
            // Split into per-line spans so each line becomes a click target.
            const codeLines = this.code.split("\n");
            codeLines.forEach((lineText, idx) => {
                const span = document.createElement("span");
                span.className = "line";
                span.setAttribute("data-mz-source-line", String(idx + 1));
                span.textContent = lineText;
                code.appendChild(span);
                if (idx < codeLines.length - 1)
                    code.appendChild(document.createTextNode("\n"));
            });
            pre.appendChild(code);
            codeEl.appendChild(pre);
            wrapper.appendChild(codeEl);

            // Async Shiki highlighting
            if (this.lang && this.lang !== "text" && this.lang !== "plain") {
                getShiki().then((shiki) => {
                    try {
                        const loadedLangs = shiki.getLoadedLanguages();
                        if (loadedLangs.includes(this.lang as any)) {
                            const html = shiki.codeToHtml(this.code, {
                                lang: this.lang,
                                theme: "github-dark",
                            });
                            this.cachedHtml = html;
                            codeEl.innerHTML = html;
                            // Style the Shiki output
                            const shikiPre = codeEl.querySelector("pre");
                            if (shikiPre) {
                                shikiPre.style.cssText =
                                    "margin:0; padding:12px 16px; overflow-x:auto; background:transparent !important; font-size: 0.88em; line-height: 1.5;";
                            }
                            annotateLines();
                        }
                    } catch {
                        // Keep plain text on error
                    }
                });
            }
        }

        return wrapper;
    }

    eq(other: CodeBlockWidget): boolean {
        return this.code === other.code && this.lang === other.lang;
    }

    // Return -1 so CM6 measures the actual rendered DOM height instead
    // of using an estimate. The old `Math.max(60, lines*20 + 32)` formula
    // was off by 3-8 pixels per code block (Shiki's actual line-height,
    // padding, copy-button overlay, border all differ from the estimate).
    // CM6 uses estimated heights to build its HeightMap tree, and errors
    // accumulate down the document — so after scrolling past several
    // code blocks, clicks on lines below them landed on the NEXT line.
    // -1 tells CM6 "measure me, don't guess", which gives perfect
    // accuracy regardless of scroll distance.
    get estimatedHeight(): number {
        return -1;
    }
}

// ---------------------------------------------------------------------------
// Widget: KaTeX math block
// ---------------------------------------------------------------------------

class MathBlockWidget extends WidgetType {
    constructor(private tex: string) {
        super();
    }

    toDOM(): HTMLElement {
        const wrapper = document.createElement("div");
        wrapper.className = "mz-block-math";
        try {
            katex.render(this.tex.trim(), wrapper, {
                displayMode: true,
                throwOnError: false,
                output: "html",
                trust: true,
            });
        } catch (e) {
            wrapper.textContent = this.tex;
            wrapper.style.color = "var(--mz-error)";
        }
        return wrapper;
    }

    eq(other: MathBlockWidget): boolean {
        return this.tex === other.tex;
    }
}

// ---------------------------------------------------------------------------
// Widget: Callout block
// ---------------------------------------------------------------------------

class CalloutWidget extends WidgetType {
    constructor(
        private type: string,
        private title: string,
        private body: string,
        private foldable: boolean,
        private defaultOpen: boolean,
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const def =
            CALLOUT_TYPES[this.type.toLowerCase()] ?? CALLOUT_TYPES.note;
        const wrapper = document.createElement("div");
        wrapper.className = "mz-block-callout";
        wrapper.style.borderLeftColor = def.color;

        // Header
        const header = document.createElement("div");
        header.className = "mz-block-callout-header";

        const icon = document.createElement("span");
        icon.className = "mz-block-callout-icon";
        icon.textContent = def.icon;
        header.appendChild(icon);

        const titleEl = document.createElement("span");
        titleEl.className = "mz-block-callout-title";
        titleEl.textContent =
            this.title ||
            this.type.charAt(0).toUpperCase() + this.type.slice(1);
        titleEl.style.color = def.color;
        header.appendChild(titleEl);

        if (this.foldable) {
            const fold = document.createElement("span");
            fold.className = "mz-block-callout-fold";
            fold.textContent = this.defaultOpen ? "▼" : "▶";
            header.appendChild(fold);
        }

        // Header is always line 0 of the callout's source range.
        header.setAttribute("data-mz-source-line", "0");
        wrapper.appendChild(header);

        // Body
        if (this.body.trim()) {
            const bodyEl = document.createElement("div");
            bodyEl.className = "mz-block-callout-body";

            if (this.foldable && !this.defaultOpen) {
                bodyEl.style.display = "none";
            }

            // Render each body line as its own element so clicking a
            // specific paragraph moves the cursor to that exact source
            // line instead of the callout header.
            const bodyLines = this.body.split("\n");
            bodyLines.forEach((bl, idx) => {
                const lineEl = document.createElement("div");
                lineEl.textContent = bl;
                // body line idx 0 corresponds to source line offset 1
                // (since offset 0 is the header line with `> [!type] ...`)
                lineEl.setAttribute("data-mz-source-line", String(idx + 1));
                bodyEl.appendChild(lineEl);
            });

            wrapper.appendChild(bodyEl);

            if (this.foldable) {
                header.style.cursor = "pointer";
                header.addEventListener("click", () => {
                    const visible = bodyEl.style.display !== "none";
                    bodyEl.style.display = visible ? "none" : "block";
                    const fold = header.querySelector(".mz-block-callout-fold");
                    if (fold) fold.textContent = visible ? "▶" : "▼";
                });
            }
        }

        return wrapper;
    }

    eq(other: CalloutWidget): boolean {
        return (
            this.type === other.type &&
            this.title === other.title &&
            this.body === other.body
        );
    }
}

// ---------------------------------------------------------------------------
// Widget: Mermaid diagram
// ---------------------------------------------------------------------------

class MermaidWidget extends WidgetType {
    constructor(
        private code: string,
        private id: string,
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const wrapper = document.createElement("div");
        wrapper.className = "mz-block-mermaid";

        const loading = document.createElement("div");
        loading.textContent = t("common.loading");
        loading.style.cssText =
            "color: var(--mz-text-muted); font-size: 12px; padding: 16px; text-align: center;";
        wrapper.appendChild(loading);

        // Async render mermaid
        import("mermaid").then(({ default: mermaid }) => {
            mermaid.initialize({
                startOnLoad: false,
                theme: "dark",
                securityLevel: "strict",
            });
            const mermaidId = `mz-mermaid-${this.id}-${Date.now()}`;
            mermaid
                .render(mermaidId, this.code)
                .then(({ svg }) => {
                    wrapper.innerHTML = svg;
                    wrapper.style.textAlign = "center";
                })
                .catch(() => {
                    wrapper.innerHTML = "";
                    const err = document.createElement("pre");
                    err.textContent = this.code;
                    err.style.cssText =
                        "color: var(--mz-error); font-size: 12px; padding: 12px;";
                    wrapper.appendChild(err);
                });
        });

        return wrapper;
    }

    eq(other: MermaidWidget): boolean {
        return this.code === other.code;
    }
}

// ---------------------------------------------------------------------------
// Widget: Rendered table
// ---------------------------------------------------------------------------

class TableWidget extends WidgetType {
    constructor(private lines: string[]) {
        super();
    }

    toDOM(): HTMLElement {
        const wrapper = document.createElement("div");
        wrapper.style.cssText = "margin: 8px 0; overflow-x: auto;";

        const table = document.createElement("table");
        table.className = "mz-lp-table";

        const parseRow = (line: string): string[] =>
            line
                .replace(/^\|/, "")
                .replace(/\|$/, "")
                .split("|")
                .map((c) => c.trim());

        if (this.lines.length < 2) return wrapper;

        const headerCells = parseRow(this.lines[0]);
        const alignRow = parseRow(this.lines[1]);
        const aligns = alignRow.map((c) => {
            if (c.startsWith(":") && c.endsWith(":")) return "center";
            if (c.endsWith(":")) return "right";
            return "left";
        });

        const thead = document.createElement("thead");
        const headTr = document.createElement("tr");
        // `data-mz-source-line` tells SourceLinkedWidget which line of the
        // block's source the row corresponds to. Clicking the row will
        // move the cursor to exactly that line in the raw markdown.
        headTr.setAttribute("data-mz-source-line", "0");
        for (let j = 0; j < headerCells.length; j++) {
            const th = document.createElement("th");
            th.textContent = headerCells[j];
            th.style.textAlign = aligns[j] || "left";
            headTr.appendChild(th);
        }
        thead.appendChild(headTr);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        for (let r = 2; r < this.lines.length; r++) {
            const cells = parseRow(this.lines[r]);
            const tr = document.createElement("tr");
            tr.setAttribute("data-mz-source-line", String(r));
            for (let j = 0; j < headerCells.length; j++) {
                const td = document.createElement("td");
                td.textContent = cells[j] || "";
                td.style.textAlign = aligns[j] || "left";
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrapper.appendChild(table);
        return wrapper;
    }

    eq(other: TableWidget): boolean {
        return this.lines.join("\n") === other.lines.join("\n");
    }
}

// ---------------------------------------------------------------------------
// Block detection & decoration building
// ---------------------------------------------------------------------------

interface Block {
    type: "code" | "math" | "callout" | "mermaid" | "table";
    from: number;
    to: number;
    widget: WidgetType;
}

/**
 * Detect renderable blocks (code fences, math blocks, callouts, tables).
 * Blocks are NOT produced when the cursor is on any of their source
 * lines OR on the line immediately before/after them — that adjacency
 * rule is what makes arrow keys work: pressing ↓ from the line above a
 * block causes the block to un-render (because cursor now sits in the
 * expanded "near" zone), and the arrow key's default CM6 handler can
 * freely step into the first source line of the (now raw) block.
 *
 * Without the ±1 line padding, the block's `Decoration.replace` range
 * is atomic and arrow keys skip the entire block.
 */
export function detectBlocks(
    state: import("@codemirror/state").EditorState,
): Block[] {
    const doc = state.doc;
    const cursorLine = doc.lineAt(state.selection.main.head).number;
    const blocks: Block[] = [];

    // Returns true if the cursor is INSIDE the block or on an adjacent
    // line — in either case we skip producing the block widget so the
    // raw source is visible and the cursor can edit it.
    const cursorNear = (startLine: number, endLine: number) =>
        cursorLine >= startLine - 1 && cursorLine <= endLine + 1;

    let i = 1;
    while (i <= doc.lines) {
        const line = doc.line(i);
        const text = line.text;

        // --- Fenced code block: ```lang ... ``` ---
        const codeMatch = text.match(/^(`{3,}|~{3,})(\w*)\s*$/);
        if (codeMatch) {
            const fence = codeMatch[1];
            const lang = codeMatch[2] || "";
            const startLine = i;
            const from = line.from;
            let endLine = -1;

            // Find closing fence
            for (let j = i + 1; j <= doc.lines; j++) {
                const closeLine = doc.line(j);
                if (
                    closeLine.text.startsWith(
                        fence.charAt(0).repeat(fence.length),
                    ) &&
                    closeLine.text.trim().length <= fence.length + 1
                ) {
                    endLine = j;
                    break;
                }
            }

            if (endLine > 0) {
                const to = doc.line(endLine).to;

                // Skip the widget if the cursor is inside OR adjacent to
                // the block — the adjacency padding is what lets arrow
                // keys navigate into the raw source cleanly.
                if (!cursorNear(startLine, endLine)) {
                    // Extract code content (lines between fences)
                    const codeLines: string[] = [];
                    for (let j = startLine + 1; j < endLine; j++) {
                        codeLines.push(doc.line(j).text);
                    }
                    const code = codeLines.join("\n");
                    const blockId = `${from}-${to}`;

                    if (lang === "mermaid") {
                        blocks.push({
                            type: "mermaid",
                            from,
                            to,
                            widget: new MermaidWidget(code, blockId),
                        });
                    } else {
                        blocks.push({
                            type: "code",
                            from,
                            to,
                            widget: new CodeBlockWidget(code, lang, blockId),
                        });
                    }
                }
                i = endLine + 1;
                continue;
            }
        }

        // --- Math block: $$ ... $$ ---
        if (text.trim() === "$$") {
            const startLine = i;
            const from = line.from;
            let endLine = -1;

            for (let j = i + 1; j <= doc.lines; j++) {
                if (doc.line(j).text.trim() === "$$") {
                    endLine = j;
                    break;
                }
            }

            if (endLine > 0) {
                const to = doc.line(endLine).to;
                if (!cursorNear(startLine, endLine)) {
                    const mathLines: string[] = [];
                    for (let j = startLine + 1; j < endLine; j++) {
                        mathLines.push(doc.line(j).text);
                    }
                    blocks.push({
                        type: "math",
                        from,
                        to,
                        widget: new MathBlockWidget(mathLines.join("\n")),
                    });
                }
                i = endLine + 1;
                continue;
            }
        }

        // --- Callout block: > [!type] title ---
        const calloutMatch = text.match(/^>\s*\[!(\w+)\]([+-])?\s*(.*)?$/);
        if (calloutMatch) {
            const calloutType = calloutMatch[1];
            const foldChar = calloutMatch[2];
            const title = calloutMatch[3] || "";
            const startLine = i;
            const from = line.from;
            const bodyLines: string[] = [];

            // Collect continuation lines (lines starting with >)
            let endLine = i;
            for (let j = i + 1; j <= doc.lines; j++) {
                const nextLine = doc.line(j).text;
                if (nextLine.startsWith("> ") || nextLine === ">") {
                    bodyLines.push(nextLine.replace(/^>\s?/, ""));
                    endLine = j;
                } else {
                    break;
                }
            }

            const to = doc.line(endLine).to;
            if (!cursorNear(startLine, endLine)) {
                const foldable = foldChar === "+" || foldChar === "-";
                const defaultOpen = foldChar !== "-";
                blocks.push({
                    type: "callout",
                    from,
                    to,
                    widget: new CalloutWidget(
                        calloutType,
                        title,
                        bodyLines.join("\n"),
                        foldable,
                        defaultOpen,
                    ),
                });
            }
            i = endLine + 1;
            continue;
        }

        // --- Table: | col1 | col2 | ... followed by |---|---| ---
        if (text.includes("|") && i + 1 <= doc.lines) {
            const nextText = doc.line(i + 1).text;
            if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(nextText)) {
                const startLine = i;
                const from = line.from;
                const tableLines: string[] = [text];
                let endLine = i;
                // Collect all table lines
                for (let j = i + 1; j <= doc.lines; j++) {
                    const tl = doc.line(j).text;
                    if (tl.includes("|")) {
                        tableLines.push(tl);
                        endLine = j;
                    } else {
                        break;
                    }
                }
                const to = doc.line(endLine).to;
                if (!cursorNear(startLine, endLine) && tableLines.length >= 2) {
                    blocks.push({
                        type: "table",
                        from,
                        to,
                        widget: new TableWidget(tableLines),
                    });
                }
                i = endLine + 1;
                continue;
            }
        }

        i++;
    }

    return blocks;
}

/**
 * Empty placeholder widget — kept for potential future re-enablement
 * of a block-widget-based approach. Currently unused while LivePreview
 * uses line decorations in livePreview.ts instead.
 */
/**
 * Wrapper that would delegate rendering to an inner widget and make it
 * click-to-edit. Kept for future use.
 */
class SourceLinkedWidget extends WidgetType {
    constructor(
        private inner: WidgetType,
        private sourceFrom: number,
    ) {
        super();
    }
    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement("div");
        wrapper.className = "mz-block-source-linked";
        const innerEl = this.inner.toDOM(view);
        wrapper.appendChild(innerEl);

        // Track where the drag started so we can distinguish a click from
        // a text selection inside the widget. If the user clicks-and-holds
        // to select, we let the browser do its native selection thing
        // (so they can copy text out of the rendered block). A plain click
        // (pointer up near the same position) dispatches a cursor move to
        // the exact source line.
        let downX = 0,
            downY = 0,
            downOnWidget = false;

        wrapper.addEventListener("mousedown", (e) => {
            const target = e.target as HTMLElement;
            // Interactive children (copy button, checkbox, fold toggle)
            // manage their own click behavior.
            if (target.closest("button, input, a, textarea, select")) {
                downOnWidget = false;
                return;
            }
            downOnWidget = true;
            downX = e.clientX;
            downY = e.clientY;
            // Do NOT preventDefault here — we want to allow the browser
            // to start a native text selection. We decide on mouseup.
        });

        wrapper.addEventListener("mouseup", (e) => {
            if (!downOnWidget) return;
            downOnWidget = false;

            // If the user dragged more than a few pixels treat it as a
            // text-selection gesture and leave their selection alone.
            const dx = Math.abs(e.clientX - downX);
            const dy = Math.abs(e.clientY - downY);
            if (dx > 4 || dy > 4) return;

            // Also leave it alone if they selected non-empty text.
            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) return;

            // Walk up from the clicked element to find the nearest element
            // tagged with `data-mz-source-line`. Widgets tag table rows /
            // code lines / callout body lines with a per-line offset so we
            // can place the cursor on the exact source line the user
            // clicked, not just the block start.
            const target = e.target as HTMLElement;
            let anchor = this.sourceFrom;
            const tagged = target.closest(
                "[data-mz-source-line]",
            ) as HTMLElement | null;
            if (tagged) {
                const offset = parseInt(
                    tagged.getAttribute("data-mz-source-line") || "0",
                    10,
                );
                if (!isNaN(offset) && offset > 0) {
                    const startLine = view.state.doc.lineAt(
                        this.sourceFrom,
                    ).number;
                    const targetLineNum = Math.min(
                        startLine + offset,
                        view.state.doc.lines,
                    );
                    anchor = view.state.doc.line(targetLineNum).from;
                }
            }
            e.preventDefault();
            view.dispatch({
                selection: { anchor },
                scrollIntoView: true,
            });
            view.focus();
        });

        return wrapper;
    }
    eq(other: SourceLinkedWidget): boolean {
        return (
            other instanceof SourceLinkedWidget &&
            this.sourceFrom === other.sourceFrom &&
            this.inner.eq(other.inner as any)
        );
    }
    get estimatedHeight(): number {
        const inner = this.inner as WidgetType & { estimatedHeight?: number };
        return inner.estimatedHeight ?? -1;
    }
}

/**
 * Build the DecorationSet for block-level widgets (tables, code fences, math
 * blocks, callouts, mermaid) from an EditorState.
 *
 * CRUCIAL: this function is called from a StateField, not from a ViewPlugin.
 *
 * The reason is documented in CM6's `EditorView.decorations` facet docs:
 *
 *   > Only decoration sets provided directly are allowed to influence the
 *   > editor's vertical layout structure. The ones provided as functions are
 *   > called _after_ the new viewport has been computed, and thus MUST NOT
 *   > introduce block widgets or replacing decorations that cover line breaks.
 *
 * A `ViewPlugin.decorations` source is exactly the "provided as function"
 * path. When we previously used one, any block widget decoration in it was
 * silently rejected by CM6 and nuked the live-preview rendering for the
 * entire note — which is the "nothing shows up in live-preview" bug on any
 * note containing a table, code fence, math block or callout (e.g. 2.md).
 *
 * A StateField, in contrast, is fed into the `EditorView.decorations` facet
 * directly (via `provide: f => EditorView.decorations.from(f)`) and IS
 * allowed to produce block widgets. That's the correct path for these.
 */
/**
 * Disabled — block widgets are NOT used in LivePreview.
 *
 * Earlier iterations rendered tables/code blocks/callouts as block
 * widgets that REPLACED the raw source. That approach has a fundamental
 * conflict with what the user actually wants (and what
 * LivePreview does): `Decoration.replace({block: true})` is atomic, so
 * arrow keys skip over the entire block and the lines inside are not
 * cursor-addressable.
 *
 *  actual trick is to leave the source fully in place and
 * style it via LINE DECORATIONS (font-family, border, background) so
 * that `|col1|col2|` / ```` ``` ```` etc. visually read as tables / code
 * blocks while every character remains a real cursor position. That
 * rendering lives in `livePreview.ts`'s `lineDecorationField`.
 *
 * This function is kept for the Reading view / future re-enablement.
 */
function buildBlockDecorations(
    state: import("@codemirror/state").EditorState,
): DecorationSet {
    const blocks = detectBlocks(state);
    if (blocks.length === 0) return Decoration.none;

    return Decoration.set(
        blocks.map((block) =>
            Decoration.replace({
                block: true,
                widget: new SourceLinkedWidget(block.widget, block.from),
            }).range(block.from, block.to),
        ),
        true,
    );
}

// ---------------------------------------------------------------------------
// StateField that owns the block-widget DecorationSet
// ---------------------------------------------------------------------------

const blockWidgetField = StateField.define<DecorationSet>({
    create(state) {
        return buildBlockDecorations(state);
    },
    update(deco, tr: Transaction) {
        // Rebuild when the document changes OR when the selection moves
        // across a line boundary (block widgets un-render on the line the
        // cursor is on). Mapping is not enough because the set of blocks
        // that need rendering depends on the cursor position.
        if (tr.docChanged || tr.selection) {
            return buildBlockDecorations(tr.state);
        }
        return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// Theme for block widgets
// ---------------------------------------------------------------------------

const blockWidgetTheme = EditorView.baseTheme({
    // Hover affordance for click-to-edit block widgets. We also
    // force `user-select: text` so the user can drag to select text
    // inside the rendered widget (CM6 widgets default to unselectable).
    ".mz-block-source-linked": {
        cursor: "text",
        userSelect: "text",
        "-webkit-user-select": "text",
    },
    ".mz-block-source-linked *": {
        userSelect: "text",
        "-webkit-user-select": "text",
    },

    // Code blocks
    ".mz-block-code": {
        position: "relative",
        background: "var(--mz-bg-tertiary)",
        borderRadius: "6px",
        margin: "8px 0",
        overflow: "hidden",
        border: "1px solid var(--mz-border)",
        fontFamily: "var(--mz-font-mono)",
    },
    ".mz-block-code-lang": {
        position: "absolute",
        top: "4px",
        right: "60px",
        fontSize: "10px",
        color: "var(--mz-text-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        padding: "2px 6px",
        borderRadius: "3px",
        background: "var(--mz-bg-hover)",
    },
    ".mz-block-code-copy": {
        position: "absolute",
        top: "4px",
        right: "4px",
        fontSize: "11px",
        color: "var(--mz-text-muted)",
        background: "var(--mz-bg-hover)",
        border: "1px solid var(--mz-border)",
        borderRadius: "3px",
        padding: "2px 8px",
        cursor: "pointer",
        fontFamily: "var(--mz-font-sans)",
        "&:hover": {
            color: "var(--mz-text-primary)",
            background: "var(--mz-bg-active)",
        },
    },
    ".mz-block-code-content pre": {
        margin: "0",
        padding: "12px 16px",
        overflowX: "auto",
        fontSize: "0.88em",
        lineHeight: "1.5",
    },
    ".mz-block-code-content code": {
        fontFamily: "var(--mz-font-mono)",
    },

    // Math blocks
    ".mz-block-math": {
        padding: "16px",
        margin: "8px 0",
        textAlign: "center",
        overflowX: "auto",
    },
    ".mz-block-math .katex-display": {
        margin: "0",
    },

    // Callout blocks
    ".mz-block-callout": {
        borderLeft: "4px solid var(--mz-callout-note)",
        background: "var(--mz-bg-tertiary)",
        borderRadius: "0 6px 6px 0",
        margin: "8px 0",
        padding: "0",
        overflow: "hidden",
    },
    ".mz-block-callout-header": {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 12px",
        fontWeight: "600",
        fontSize: "0.95em",
    },
    ".mz-block-callout-icon": {
        fontSize: "1.1em",
        flexShrink: "0",
    },
    ".mz-block-callout-title": {
        flex: "1",
    },
    ".mz-block-callout-fold": {
        fontSize: "10px",
        color: "var(--mz-text-muted)",
    },
    ".mz-block-callout-body": {
        padding: "0 12px 10px 12px",
        fontSize: "0.92em",
        color: "var(--mz-text-secondary)",
        lineHeight: "1.6",
        whiteSpace: "pre-wrap",
    },

    // Mermaid
    ".mz-block-mermaid": {
        margin: "8px 0",
        padding: "16px",
        background: "var(--mz-bg-tertiary)",
        borderRadius: "6px",
        border: "1px solid var(--mz-border)",
        overflow: "auto",
    },
    ".mz-block-mermaid svg": {
        maxWidth: "100%",
    },
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function blockWidgetExtension() {
    return [blockWidgetTheme, blockWidgetField];
}
