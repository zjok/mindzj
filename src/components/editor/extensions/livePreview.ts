/**
 * MindZJ Live Preview Extension for CodeMirror 6
 *
 * Renders Markdown inline while editing:
 * - Headings display at their rendered size
 * - Bold / italic / strikethrough / highlight render visually
 * - Links become clickable (when cursor is not on them)
 * - Images show inline previews
 * - Task list checkboxes are interactive
 * - Syntax markers (**, ~~, ==, etc.) hide when cursor is elsewhere
 *
 * Design principle: the line the cursor is on always shows raw Markdown,
 * all other lines show the rendered preview. This matches Obsidian's
 * Live Preview behavior.
 */

import {
    ViewPlugin,
    ViewUpdate,
    Decoration,
    DecorationSet,
    EditorView,
    WidgetType,
} from "@codemirror/view";
import { Range, StateField, Transaction } from "@codemirror/state";
import katex from "katex";
import { invoke } from "@tauri-apps/api/core";
import { resolveImageAssetUrl } from "../../../utils/vaultPaths";
import { attachWheelZoom, attachCtrlClick, getResizePresets, applyResizePreset } from "../../../utils/imageInteraction";
import {
    getContinuationInfo,
    LIST_INDENT_EXTRA_PX,
    LIST_INDENT_WIDTH,
    LIST_RENDER_TAB_SIZE,
} from "./listUtils";
import { t } from "../../../i18n";

// ---------------------------------------------------------------------------
// Image context menu
// ---------------------------------------------------------------------------

/**
 * Show a right-click context menu on an image with options to:
 * - Delete image from note and from vault storage
 * - Open image in default app
 * - Show image in file manager
 * - Copy image path
 */
function showImageContextMenu(
    e: MouseEvent,
    imageSrc: string,
    currentFilePath: string,
    imgElement?: HTMLImageElement,
) {
    // Remove any existing context menu
    document.querySelectorAll(".mz-image-context-menu").forEach((el) => el.remove());

    const menu = document.createElement("div");
    menu.className = "mz-image-context-menu";
    Object.assign(menu.style, {
        position: "fixed",
        zIndex: "10002",
        background: "var(--mz-bg-secondary, #2b2b2b)",
        border: "1px solid var(--mz-border-strong, #555)",
        borderRadius: "6px",
        padding: "4px 0",
        minWidth: "180px",
        maxWidth: "320px",
        boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
        fontSize: "13px",
        color: "var(--mz-text-primary, #ccc)",
        fontFamily: "var(--mz-font-sans, system-ui)",
        userSelect: "none",
    });

    function addMenuItem(
        label: string,
        onClick: () => void,
        opts?: { danger?: boolean },
    ) {
        const item = document.createElement("div");
        Object.assign(item.style, {
            padding: "6px 16px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            transition: "background 80ms",
            color: opts?.danger ? "var(--mz-error, #e06c75)" : "inherit",
        });
        item.textContent = label;
        item.addEventListener("mouseenter", () => {
            item.style.background = "var(--mz-bg-hover, #333)";
        });
        item.addEventListener("mouseleave", () => {
            item.style.background = "transparent";
        });
        item.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            closeMenu();
            onClick();
        });
        menu.appendChild(item);
    }

    function addSeparator() {
        const sep = document.createElement("div");
        Object.assign(sep.style, {
            height: "1px",
            background: "var(--mz-border, #3e3e3e)",
            margin: "4px 8px",
        });
        menu.appendChild(sep);
    }

    // Resolve the image path relative to the vault
    function resolveImagePath(): string {
        let imgPath = imageSrc;
        // Handle relative paths
        if (imgPath.startsWith("./") || imgPath.startsWith("../")) {
            const dir = currentFilePath.includes("/")
                ? currentFilePath.split("/").slice(0, -1).join("/")
                : "";
            const parts = (dir ? dir + "/" + imgPath : imgPath).split("/");
            const resolved: string[] = [];
            for (const p of parts) {
                if (p === "..") resolved.pop();
                else if (p !== ".") resolved.push(p);
            }
            imgPath = resolved.join("/");
        }
        // Strip leading "/" so Rust Path::join treats it as relative to vault root
        // (on Windows, a leading "/" would make it an absolute drive-root path)
        if (imgPath.startsWith("/")) {
            imgPath = imgPath.slice(1);
        }
        return imgPath;
    }

    // ── Copy image path ──
    addMenuItem(t("livePreview.copyImagePath"), () => {
        navigator.clipboard.writeText(imageSrc).catch(() => {});
    });

    // ── Open in default app ──
    addMenuItem(t("livePreview.openInDefaultApp"), () => {
        invoke("open_in_default_app", { relativePath: resolveImagePath() }).catch(
            (err) => { console.warn("[ImageContextMenu] Failed to open in default app:", err); },
        );
    });

    // ── Show in file manager ──
    addMenuItem(t("context.showInExplorer"), () => {
        invoke("reveal_in_file_manager", {
            relativePath: resolveImagePath(),
        }).catch((err) => { console.warn("[ImageContextMenu] Failed to reveal in file manager:", err); });
    });

    // ── Resize presets ──
    if (imgElement) {
        const presets = getResizePresets();
        if (presets.length > 0) {
            addSeparator();
            for (const preset of presets) {
                addMenuItem(t("livePreview.resizeTo", { preset }), () => {
                    applyResizePreset(imgElement, preset);
                });
            }
        }
    }

    addSeparator();

    // ── Delete image ──
    addMenuItem(
        t("livePreview.deleteImage"),
        async () => {
            const imgPath = resolveImagePath();
            // Check if there's an active editor (live-preview/source mode)
            const hasEditor = !!(window as any).__mindzj_plugin_editor_api;
            if (hasEditor) {
                // Dispatch to Editor.tsx handler which modifies the CM6 document
                document.dispatchEvent(
                    new CustomEvent("mindzj:delete-image", {
                        detail: {
                            imageSrc,
                            imagePath: imgPath,
                            currentFilePath,
                        },
                    }),
                );
            } else {
                // Reading mode: read the file, remove the reference, write back
                try {
                    const result = await invoke<{ content: string }>(
                        "read_file",
                        { relativePath: currentFilePath },
                    );
                    const escapedSrc = imageSrc.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        "\\$&",
                    );
                    const patterns = [
                        new RegExp(
                            `!\\[[^\\]]*\\]\\(${escapedSrc}\\)\\n?`,
                        ),
                        new RegExp(`!\\[\\[${escapedSrc}\\]\\]\\n?`),
                    ];
                    let newContent = result.content;
                    for (const re of patterns) {
                        const replaced = newContent.replace(re, "");
                        if (replaced !== newContent) {
                            newContent = replaced;
                            break;
                        }
                    }
                    if (newContent !== result.content) {
                        await invoke("write_file", {
                            relativePath: currentFilePath,
                            content: newContent,
                        });
                    }
                } catch (err) {
                    console.warn(
                        "[ImageContextMenu] Failed to update file:",
                        err,
                    );
                }
            }
            // Delete the image file from the vault
            invoke("delete_file", { relativePath: imgPath }).catch((err) => {
                console.warn(
                    "[ImageContextMenu] Failed to delete image:",
                    err,
                );
            });
        },
        { danger: true },
    );

    // Position menu at mouse cursor, clamped within viewport
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(0, x) + "px";
    menu.style.top = Math.max(0, y) + "px";

    // Backdrop to close menu on outside click
    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, {
        position: "fixed",
        inset: "0",
        zIndex: "10001",
        background: "transparent",
    });

    function closeMenu() {
        menu.remove();
        backdrop.remove();
    }

    backdrop.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        closeMenu();
    });
    backdrop.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        closeMenu();
    });
    document.body.appendChild(backdrop);
}

// Export for use by ReadingView
export { showImageContextMenu };

// ---------------------------------------------------------------------------
// Widget classes
// ---------------------------------------------------------------------------

/** Inline image preview widget */
class ImageWidget extends WidgetType {
    constructor(
        private src: string,
        private alt: string,
        private vaultRoot: string,
        private currentFilePath: string,
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const wrapper = document.createElement("div");
        wrapper.className = "mz-lp-image image-embed internal-embed is-loaded";
        wrapper.setAttribute("src", this.src);
        wrapper.setAttribute("alt", this.alt);
        wrapper.style.cssText =
            "padding: 8px 0; max-width: 100%; cursor: pointer;";

        const img = document.createElement("img");
        // data-src = raw vault-relative path from markdown (used by plugins like pixel-perfect-image)
        img.setAttribute("data-src", this.src);
        img.src = resolveImageAssetUrl(
            this.src,
            this.vaultRoot,
            this.currentFilePath,
        );
        img.alt = this.alt;
        img.className = "mz-embed-image";
        // Do NOT set max-width/max-height inline — use CSS class instead.
        // This allows plugins (pixel-perfect-image) to freely resize via inline style.width.
        img.style.cssText =
            "border-radius: 6px; display: block;";
        img.onerror = () => {
            img.style.display = "none";
            const fallback = document.createElement("span");
            fallback.textContent = `[${t("livePreview.imageFallback")}: ${this.alt || this.src}]`;
            fallback.style.cssText =
                "color: var(--mz-text-muted); font-size: 12px; font-style: italic;";
            wrapper.appendChild(fallback);
        };

        wrapper.appendChild(img);

        // Alt+wheel zoom & Ctrl+click
        attachWheelZoom(img);
        attachCtrlClick(img, this.src, this.currentFilePath);

        // Right-click context menu for image operations
        wrapper.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            showImageContextMenu(e, this.src, this.currentFilePath, img);
        });

        return wrapper;
    }

    eq(other: ImageWidget): boolean {
        return this.src === other.src;
    }
}

/** Interactive checkbox widget for task lists */
class CheckboxWidget extends WidgetType {
    constructor(private checked: boolean) {
        super();
    }

    toDOM(view: EditorView): HTMLElement {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = this.checked;
        cb.className = "mz-lp-checkbox";
        cb.style.cssText =
            "cursor: pointer; margin-right: 6px; transform: scale(1.1); vertical-align: middle; accent-color: var(--mz-accent);";

        cb.addEventListener("click", (e) => {
            e.preventDefault();
            // Find position and toggle the checkbox in the document
            const pos = view.posAtDOM(cb);
            const line = view.state.doc.lineAt(pos);
            const lineText = line.text;
            const newText = this.checked
                ? lineText.replace("- [x]", "- [ ]").replace("- [X]", "- [ ]")
                : lineText.replace("- [ ]", "- [x]");
            view.dispatch({
                changes: { from: line.from, to: line.to, insert: newText },
            });
        });

        return cb;
    }

    eq(other: CheckboxWidget): boolean {
        return this.checked === other.checked;
    }
}

/**
 * Tiny widget that renders the unordered-list marker (`-`, `*`, `+`) as
 * a round bullet. Inline (non-block) replace, so CM6 doesn't treat it
 * as atomic — arrow keys can move normally through the line.
 */
class BulletWidget extends WidgetType {
    toDOM(): HTMLElement {
        const anchor = document.createElement("span");
        anchor.className = "mz-lp-bullet-anchor";
        const dot = document.createElement("span");
        dot.className = "mz-lp-bullet";
        anchor.appendChild(dot);
        return anchor;
    }
    eq(): boolean { return true; }
}
const bulletWidget = new BulletWidget();

/** Inline math widget rendered with KaTeX */
class InlineMathWidget extends WidgetType {
    constructor(private tex: string) {
        super();
    }

    toDOM(): HTMLElement {
        const span = document.createElement("span");
        span.className = "mz-lp-inline-math";
        try {
            katex.render(this.tex.trim(), span, {
                displayMode: false,
                throwOnError: false,
                output: "html",
                trust: true,
            });
        } catch {
            span.textContent = `$${this.tex}$`;
            span.style.color = "var(--mz-error)";
        }
        return span;
    }

    eq(other: InlineMathWidget): boolean {
        return this.tex === other.tex;
    }
}

// ---------------------------------------------------------------------------
// Decoration builders
// ---------------------------------------------------------------------------

/**
 * Hide syntax markers (**, __, ~~, ==, [, ](url), etc.) via a MARK
 * decoration with CSS that collapses them to zero visual width.
 *
 * Previous approach used `Decoration.replace({})` which REMOVED the
 * characters from the DOM entirely. That caused two problems:
 *   1. CM6's `posAtCoords` lost positional accuracy because the
 *      replaced range was an atomic gap in the DOM — clicks on styled
 *      text near a hidden marker would land on the wrong character.
 *   2. Arrow-key movement skipped over replaced ranges unpredictably.
 *
 * Mark decorations keep the characters IN the DOM (so CM6's character-
 * level position map stays complete) but make them visually invisible
 * via CSS. The key CSS trick is `font-size: 0` which collapses the
 * text node to zero width/height while CM6 still knows those positions
 * exist. This is the same approach Obsidian uses for marker hiding.
 */
const hideMarker = Decoration.mark({ class: "mz-lp-hidden" });

/**
 * Heading decorations applied at the LINE level (not as mark spans).
 *
 * Using `Decoration.line` to set the class on the line's wrapping div
 * lets CM6 correctly measure line heights via `lineBlockAt`. The old
 * `Decoration.mark` approach wrapped only the heading text in a span
 * with `font-size: 1.8em`, and CM6's cached line-block heights stayed
 * at the normal line height until a later measure cycle — so clicks
 * on a heading landed on the line BELOW it (the "click on H1, cursor
 * jumps down" bug the user kept reporting). Line decorations invalidate
 * CM6's height cache correctly.
 */
const headingLineDeco: Record<number, Decoration> = {
    1: Decoration.line({ class: "mz-lp-h1-line" }),
    2: Decoration.line({ class: "mz-lp-h2-line" }),
    3: Decoration.line({ class: "mz-lp-h3-line" }),
    4: Decoration.line({ class: "mz-lp-h4-line" }),
    5: Decoration.line({ class: "mz-lp-h5-line" }),
    6: Decoration.line({ class: "mz-lp-h6-line" }),
};

const boldDeco = Decoration.mark({ class: "mz-lp-bold" });
const italicDeco = Decoration.mark({ class: "mz-lp-italic" });
const strikethroughDeco = Decoration.mark({ class: "mz-lp-strikethrough" });
const highlightDeco = Decoration.mark({ class: "mz-lp-highlight" });
const inlineCodeDeco = Decoration.mark({ class: "mz-lp-inline-code" });
const linkDeco = Decoration.mark({ class: "mz-lp-link" });
// linkUrlDeco removed — link URLs are hidden in preview
// Blockquote + HR: same reasoning as headings — use line decorations so
// their padding / border changes invalidate CM6's height cache and
// clicks map to the correct source line.
const blockquoteLineDeco = Decoration.line({ class: "mz-lp-blockquote-line" });
const hrLineDeco = Decoration.line({ class: "mz-lp-hr-line" });
function listGuideDeco(level: number): Decoration {
    return Decoration.line({
        class: "mz-lp-list-guides",
        attributes: {
            style: `--mz-list-level: ${level};`,
        },
    });
}

function measureListIndentWidth(view: EditorView): number {
    if (typeof document === "undefined") {
        return LIST_INDENT_WIDTH * 8 + LIST_INDENT_EXTRA_PX;
    }

    const probe = document.createElement("span");
    probe.textContent = "\t";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    probe.style.whiteSpace = "pre";
    probe.style.padding = "0";
    probe.style.margin = "0";
    probe.style.border = "0";
    probe.style.font = getComputedStyle(view.contentDOM).font;
    probe.style.tabSize = `${LIST_RENDER_TAB_SIZE}`;
    probe.style.setProperty("-moz-tab-size", `${LIST_RENDER_TAB_SIZE}`);
    view.contentDOM.appendChild(probe);
    const measured = probe.getBoundingClientRect().width;
    probe.remove();
    if (Number.isFinite(measured) && measured > 0) {
        return measured + LIST_INDENT_EXTRA_PX;
    }

    return Math.max(1, view.defaultCharacterWidth) * LIST_INDENT_WIDTH + LIST_INDENT_EXTRA_PX;
}

function syncListGuideMetrics(view: EditorView) {
    const rawIndentWidth = Math.max(40, Math.round(measureListIndentWidth(view)));
    const indentWidth = rawIndentWidth % 2 === 0 ? rawIndentWidth : rawIndentWidth + 1;
    const guideOffset = Math.max(1, indentWidth / 2);
    view.contentDOM.style.setProperty("tab-size", `${indentWidth}px`);
    view.contentDOM.style.setProperty("-moz-tab-size", `${indentWidth}px`);
    view.contentDOM.style.setProperty("--mz-list-indent-step", `${indentWidth}px`);
    view.contentDOM.style.setProperty("--mz-list-guide-offset", `${guideOffset}px`);
}
// Code fence + content + table line decorations (Obsidian-style: keep the
// raw source visible AND cursor-navigable; use CSS to make it LOOK like a
// rendered code block / table).
const codeFenceOpenDeco = Decoration.line({ class: "mz-lp-code-fence-open" });
const codeFenceCloseDeco = Decoration.line({ class: "mz-lp-code-fence-close" });
const codeContentDeco = Decoration.line({ class: "mz-lp-code-content-line" });
const tableHeaderDeco = Decoration.line({ class: "mz-lp-table-header-line" });
const tableSepDeco = Decoration.line({ class: "mz-lp-table-separator-line" });
const tableRowDeco = Decoration.line({ class: "mz-lp-table-row-line" });
const tagDeco = Decoration.mark({ class: "mz-lp-tag" });
const footnoteDeco = Decoration.mark({ class: "mz-lp-footnote" });
// Highlights the raw `[ ]` / `[x]` task brackets on the cursor line where the
// checkbox widget is not shown — without this they're rendered in the muted
// comment color and are almost invisible in the dark theme.
const taskMarkerDeco = Decoration.mark({ class: "mz-lp-task-marker" });
// Styling for the `](url)` portion of markdown links on the cursor line.
// Without an explicit rule this tail falls through to the muted comment
// colour and is hard to read — especially for anchor links like
// `](#section-name)` which hold actual readable content.
const linkUrlTailDeco = Decoration.mark({ class: "mz-lp-link-url-tail" });

// ---------------------------------------------------------------------------
// Core logic: build decorations from document content
// ---------------------------------------------------------------------------

function buildDecorations(
    view: EditorView,
    vaultRoot: string,
    currentFilePath: string,
): DecorationSet {
    try {
        return buildDecorationsImpl(view, vaultRoot, currentFilePath);
    } catch (err) {
        // A single bad decoration would otherwise throw from Decoration.set
        // and take down the live-preview plugin, leaving the editor blank.
        console.error("[live-preview] buildDecorations failed:", err);
        return Decoration.none;
    }
}

function buildDecorationsImpl(
    view: EditorView,
    vaultRoot: string,
    currentFilePath: string,
): DecorationSet {
    const decorations: Range<Decoration>[] = [];
    const doc = view.state.doc;
    const cursorLine = doc.lineAt(view.state.selection.main.head).number;
    // No block widgets — line decorations in buildLineDecorations handle
    // the visual rendering of code fences and tables while keeping every
    // character cursor-addressable. Here we only need to skip inline
    // formatting inside fenced code blocks and table rows.
    const tableSepRe = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
    const isTableRow = (t: string) =>
        t.trim().startsWith("|") && t.indexOf("|", t.indexOf("|") + 1) !== -1;
    let inFence = false;
    let activeFence = "";

    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const text = line.text;
        const isCurrentLine = i === cursorLine;

        // Skip empty lines
        if (!text.trim()) continue;

        const fenceMatch = text.match(/^(`{3,}|~{3,})/);
        if (fenceMatch) {
            if (!inFence) {
                inFence = true;
                activeFence = fenceMatch[1][0];
            } else if (text.startsWith(activeFence.repeat(3))) {
                inFence = false;
                activeFence = "";
            }
            continue;
        }
        if (inFence) continue;
        if (isTableRow(text) || tableSepRe.test(text)) continue;

        // --- Headings ---
        // NOTE: the line-level heading class (mz-lp-h{level}-line) is
        // attached by `lineDecorationField` — a StateField — not here.
        // The ViewPlugin path runs after viewport layout and its line
        // decorations wouldn't invalidate CM6's height cache, which
        // caused the click-on-heading-lands-below bug. Here we only
        // hide the `### ` markers on non-cursor lines.
        const headingMatch = text.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            const markerEnd = line.from + headingMatch[1].length + 1; // include space
            if (!isCurrentLine) {
                decorations.push(hideMarker.range(line.from, markerEnd));
            }
            continue; // Headings don't contain other inline syntax in this pass
        }

        // --- Horizontal rule ---
        // Line class is supplied by lineDecorationField. Here we just
        // hide the raw `---` characters on non-cursor lines.
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
            if (!isCurrentLine) {
                decorations.push(hideMarker.range(line.from, line.to));
            }
            continue;
        }

        // --- Blockquote ---
        // Line class is supplied by lineDecorationField. Here we just
        // hide the `> ` marker on non-cursor lines.
        if (text.startsWith("> ")) {
            if (!isCurrentLine) {
                decorations.push(hideMarker.range(line.from, line.from + 2));
            }
        }

        // --- Task list checkboxes ---
        const taskMatch = text.match(/^(\s*)-\s+\[([ xX])\]\s/);
        if (taskMatch) {
            // Always style the "[ ]" / "[x]" brackets so they're readable on
            // the cursor line too (where the widget replacement is skipped).
            const bracketStart = line.from + taskMatch[1].length + 2; // after "- "
            const bracketEnd = bracketStart + 3; // "[x]" or "[ ]"
            decorations.push(taskMarkerDeco.range(bracketStart, bracketEnd));
        }
        if (taskMatch && !isCurrentLine) {
            const checkStart = line.from + taskMatch[1].length;
            const checkEnd =
                checkStart + taskMatch[0].length - taskMatch[1].length;
            const isChecked = taskMatch[2] !== " ";

            // Replace "- [x] " with checkbox widget
            decorations.push(
                Decoration.replace({
                    widget: new CheckboxWidget(isChecked),
                }).range(checkStart, checkEnd),
            );
        } else if (!taskMatch && !isCurrentLine) {
            // --- Unordered list bullet (plain, not a task item) ---
            // Replace the `-`, `*`, or `+` marker with a round bullet.
            // Leading whitespace (tabs) is kept — it provides the natural
            // indentation.  The CSS padding class is skipped for tab-
            // indented lines (see list-lines section below).
            const bulletMatch = text.match(/^(\s*)([-*+])(\s)/);
            if (bulletMatch) {
                const markerStart = line.from + bulletMatch[1].length;
                // Replace ONLY the marker character (1 char).
                // The trailing space is kept so character widths stay
                // identical to the raw text — no positional shift.
                const markerEnd = markerStart + 1;
                decorations.push(
                    Decoration.replace({ widget: bulletWidget }).range(
                        markerStart,
                        markerEnd,
                    ),
                );
            }
        }

        // --- Inline formatting (only apply when cursor is not on this line) ---
        if (!isCurrentLine) {
            // Bold: **text** or __text__
            applyInlineFormat(
                text,
                line.from,
                /\*\*(.+?)\*\*/g,
                2,
                2,
                boldDeco,
                decorations,
            );
            applyInlineFormat(
                text,
                line.from,
                /__(.+?)__/g,
                2,
                2,
                boldDeco,
                decorations,
            );

            // Italic: *text* or _text_ (but not ** or __)
            applyInlineFormat(
                text,
                line.from,
                /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
                1,
                1,
                italicDeco,
                decorations,
            );

            // Strikethrough: ~~text~~
            applyInlineFormat(
                text,
                line.from,
                /~~(.+?)~~/g,
                2,
                2,
                strikethroughDeco,
                decorations,
            );

            // Highlight: ==text==
            applyInlineFormat(
                text,
                line.from,
                /==(.+?)==/g,
                2,
                2,
                highlightDeco,
                decorations,
            );

            // Inline code: `text`
            applyInlineFormat(
                text,
                line.from,
                /(?<!`)`(?!`)(.+?)(?<!`)`(?!`)/g,
                1,
                1,
                inlineCodeDeco,
                decorations,
            );

            // Images: ![alt](src)
            const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
            let imgMatch;
            while ((imgMatch = imgRegex.exec(text)) !== null) {
                const start = line.from + imgMatch.index;
                const end = start + imgMatch[0].length;
                const alt = imgMatch[1];
                const src = imgMatch[2];
                decorations.push(
                    Decoration.replace({
                        widget: new ImageWidget(src, alt, vaultRoot, currentFilePath),
                    }).range(start, end),
                );
            }

            // Markdown links: [text](url) — not images
            const linkRegex = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
            let linkMatch;
            while ((linkMatch = linkRegex.exec(text)) !== null) {
                const fullStart = line.from + linkMatch.index;
                const fullEnd = fullStart + linkMatch[0].length;
                const textStart = fullStart + 1;
                const textEnd = textStart + linkMatch[1].length;
                // Hide [ and ](url)
                decorations.push(hideMarker.range(fullStart, textStart)); // [
                decorations.push(hideMarker.range(textEnd, fullEnd)); // ](url)
                // Style the link text
                decorations.push(linkDeco.range(textStart, textEnd));
            }

            // Wiki links: [[target]] or [[target|display]]
            const wikiRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
            let wikiMatch;
            while ((wikiMatch = wikiRegex.exec(text)) !== null) {
                const fullStart = line.from + wikiMatch.index;
                const fullEnd = fullStart + wikiMatch[0].length;
                const displayStart = wikiMatch[2]
                    ? fullStart + 2 + wikiMatch[1].length + 1
                    : fullStart + 2;
                const displayEnd = fullEnd - 2;

                // Hide [[ and ]] (and target| if display text exists)
                if (wikiMatch[2]) {
                    decorations.push(hideMarker.range(fullStart, displayStart)); // [[target|
                    decorations.push(hideMarker.range(displayEnd, fullEnd)); // ]]
                } else {
                    decorations.push(
                        hideMarker.range(fullStart, fullStart + 2),
                    ); // [[
                    decorations.push(hideMarker.range(fullEnd - 2, fullEnd)); // ]]
                }
                decorations.push(linkDeco.range(displayStart, displayEnd));
            }

            // Inline math: $...$ (not $$)
            const mathRegex = /(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g;
            let mathMatch;
            while ((mathMatch = mathRegex.exec(text)) !== null) {
                const start = line.from + mathMatch.index;
                const end = start + mathMatch[0].length;
                const tex = mathMatch[1];
                decorations.push(
                    Decoration.replace({
                        widget: new InlineMathWidget(tex),
                    }).range(start, end),
                );
            }

            // Tags: #tag (but not inside code or links)
            const tagRegex =
                /(?<=\s|^)#([a-zA-Z\u4e00-\u9fff][\w\u4e00-\u9fff/\-]*)/g;
            let tagMatch;
            while ((tagMatch = tagRegex.exec(text)) !== null) {
                const start = line.from + tagMatch.index;
                const end = start + tagMatch[0].length;
                decorations.push(tagDeco.range(start, end));
            }

            // Footnote references: [^id]
            const fnRegex = /\[\^([^\]]+)\]/g;
            let fnMatch;
            while ((fnMatch = fnRegex.exec(text)) !== null) {
                // Skip footnote definitions at start of line
                if (
                    fnMatch.index === 0 &&
                    text.startsWith("[^") &&
                    text.includes("]:")
                )
                    continue;
                const start = line.from + fnMatch.index;
                const end = start + fnMatch[0].length;
                decorations.push(footnoteDeco.range(start, end));
            }
        }

        // Cursor-line readability: on the active line we keep raw markdown
        // visible, but the `](url)` tail of a link defaults to a dim colour.
        // Mark it with a brighter class so anchors like `](#section)` stay
        // legible while the user is editing.
        if (isCurrentLine) {
            const linkRegexC = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
            let lmC;
            while ((lmC = linkRegexC.exec(text)) !== null) {
                const tailStart = line.from + lmC.index + 1 + lmC[1].length;
                const tailEnd = line.from + lmC.index + lmC[0].length;
                if (tailStart < tailEnd) {
                    decorations.push(linkUrlTailDeco.range(tailStart, tailEnd));
                }
            }
        }
    }

    // Sort decorations by position (required by CM6)
    decorations.sort(
        (a, b) => a.from - b.from || a.value.startSide - b.value.startSide,
    );

    // Remove overlapping decorations (CM6 doesn't allow overlaps for replace decorations)
    const filtered = removeOverlaps(decorations);

    return Decoration.set(filtered);
}

/** Apply a regex-based inline format, hiding markers and styling content */
function applyInlineFormat(
    text: string,
    lineFrom: number,
    regex: RegExp,
    markerLenBefore: number,
    markerLenAfter: number,
    deco: Decoration,
    decorations: Range<Decoration>[],
) {
    let match;
    while ((match = regex.exec(text)) !== null) {
        const start = lineFrom + match.index;
        const end = start + match[0].length;
        const contentStart = start + markerLenBefore;
        const contentEnd = end - markerLenAfter;

        if (contentStart >= contentEnd) continue;

        // Hide opening marker
        decorations.push(hideMarker.range(start, contentStart));
        // Hide closing marker
        decorations.push(hideMarker.range(contentEnd, end));
        // Apply style to content
        decorations.push(deco.range(contentStart, contentEnd));
    }
}

/**
 * Drop decorations that would form invalid overlaps for CM6.
 *
 * CM6 rules (only the ones we care about here):
 * - Mark decorations can freely overlap each other (they nest into `<span>`s).
 * - Two REPLACE decorations on the same span are rejected by CM6.
 *
 * The previous implementation dropped any pair of overlapping decorations,
 * which silently erased legitimate styling — for example the `> ` hide marker
 * on a blockquote line that overlaps the full-line blockquote mark. That made
 * large chunks of a note disappear because the marker-hiding decorations got
 * thrown away along with their styling partners. Here we only suppress later
 * decorations that would collide with an ALREADY-ACCEPTED replace range.
 */
function removeOverlaps(decos: Range<Decoration>[]): Range<Decoration>[] {
    if (decos.length === 0) return decos;

    // A PointDecoration (widget / replace) has `point === true` on its value.
    // A MarkDecoration has `point === false`. A replace decoration, unlike a
    // plain widget, has `from < to`, so we use that to distinguish them.
    const isReplaceRange = (r: Range<Decoration>): boolean =>
        (r.value as any).point === true && r.from < r.to;

    const result: Range<Decoration>[] = [];
    const claimedReplaces: Array<[number, number]> = [];

    for (const curr of decos) {
        let conflict = false;
        for (const [cf, ct] of claimedReplaces) {
            if (curr.from < ct && curr.to > cf) {
                conflict = true;
                break;
            }
        }
        if (conflict) continue;
        result.push(curr);
        if (isReplaceRange(curr)) {
            claimedReplaces.push([curr.from, curr.to]);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// CSS for live preview decorations
// ---------------------------------------------------------------------------

const livePreviewTheme = EditorView.baseTheme({
    // Hide syntax markers (**, __, [, ](url), # , > , ---, etc.).
    //
    // Characters stay IN the DOM (so CM6's posAtCoords is exact).
    //
    // CRITICAL: `display: inline` (NOT `inline-block`). `inline-block`
    // creates a new formatting context whose zero width/height shifts
    // the baseline of the line and throws off CM6's per-character Y
    // coordinates — that was the root cause of the "click on line N
    // but cursor lands on line N+1" bug that persisted for 10+ rounds.
    //
    // With `display: inline`, the hidden span is a normal inline box
    // whose zero-size text content participates in the SAME line box
    // as the surrounding text. CM6's DOM measurement of character
    // positions stays consistent with the browser's own caret mapping.
    ".mz-lp-hidden": {
        fontSize: "0 !important",
        letterSpacing: "0",
        color: "transparent !important",
        overflow: "hidden",
    },

    // --- Global line-height guarantee ---
    // A generous line-height ensures the click-target per line is tall
    // enough that even small rounding differences between CM6's height
    // map and the browser's actual layout don't push the click into an
    // adjacent line. This single rule closes the remaining sub-pixel
    // click-accuracy gap that previous fixes couldn't fully eliminate.
    ".cm-content": {
        lineHeight: "1.75",
    },

    // Heading line styles.
    ".cm-line.mz-lp-h1-line": {
        fontSize: "1.8em",
        fontWeight: "700",
        color: "var(--mz-syntax-heading)",
        textDecoration: "none",
        borderBottom: "none",
    },
    ".cm-line.mz-lp-h2-line": {
        fontSize: "1.5em",
        fontWeight: "600",
        color: "var(--mz-syntax-heading)",
        textDecoration: "none",
        borderBottom: "none",
    },
    ".cm-line.mz-lp-h3-line": {
        fontSize: "1.25em",
        fontWeight: "600",
        color: "var(--mz-syntax-heading)",
        textDecoration: "none",
        borderBottom: "none",
    },
    ".cm-line.mz-lp-h4-line": {
        fontSize: "1.1em",
        fontWeight: "600",
        color: "var(--mz-syntax-heading)",
        textDecoration: "none",
        borderBottom: "none",
    },
    ".cm-line.mz-lp-h5-line": {
        fontSize: "1.05em",
        fontWeight: "600",
        color: "var(--mz-syntax-heading)",
        textDecoration: "none",
        borderBottom: "none",
    },
    ".cm-line.mz-lp-h6-line": {
        fontSize: "1em",
        fontWeight: "600",
        color: "var(--mz-syntax-heading)",
        textDecoration: "none",
        borderBottom: "none",
    },
    ".cm-line.mz-lp-blockquote-line": {
        color: "var(--mz-text-secondary)",
        borderLeft: "3px solid var(--mz-border-strong)",
        paddingLeft: "12px",
    },
    ".cm-line.mz-lp-hr-line": {
        borderTop: "1px solid var(--mz-border)",
    },

    // --- Fenced code block styling ---
    // Styled as a complete bordered box with rounded corners. Each
    // line keeps its raw text cursor-addressable; the CSS makes the
    // lines look like a unified code block.
    ".cm-line.mz-lp-code-fence-open": {
        fontFamily: "var(--mz-font-mono)",
        fontSize: "0.88em",
        color: "var(--mz-text-muted)",
        background: "var(--mz-syntax-code-bg)",
        borderTop: "1px solid var(--mz-border)",
        borderLeft: "1px solid var(--mz-border)",
        borderRight: "1px solid var(--mz-border)",
        borderTopLeftRadius: "6px",
        borderTopRightRadius: "6px",
        paddingLeft: "12px",
        paddingTop: "4px",
        marginTop: "4px",
    },
    ".cm-line.mz-lp-code-fence-close": {
        fontFamily: "var(--mz-font-mono)",
        fontSize: "0.88em",
        color: "var(--mz-text-muted)",
        background: "var(--mz-syntax-code-bg)",
        borderBottom: "1px solid var(--mz-border)",
        borderLeft: "1px solid var(--mz-border)",
        borderRight: "1px solid var(--mz-border)",
        borderBottomLeftRadius: "6px",
        borderBottomRightRadius: "6px",
        paddingLeft: "12px",
        paddingBottom: "4px",
        marginBottom: "4px",
    },
    ".cm-line.mz-lp-code-content-line": {
        fontFamily: "var(--mz-font-mono)",
        fontSize: "0.88em",
        background: "var(--mz-syntax-code-bg)",
        color: "var(--mz-text-primary)",
        borderLeft: "1px solid var(--mz-border)",
        borderRight: "1px solid var(--mz-border)",
        paddingLeft: "12px",
    },

    // --- Table styling ---
    // NO accent top border — clean subtle borders only.
    ".cm-line.mz-lp-table-header-line": {
        fontFamily: "var(--mz-font-mono)",
        fontSize: "0.95em",
        fontWeight: "700",
        background: "var(--mz-bg-tertiary)",
        color: "var(--mz-text-primary)",
        borderTop: "1px solid var(--mz-border)",
        borderLeft: "1px solid var(--mz-border)",
        borderRight: "1px solid var(--mz-border)",
        borderBottom: "1px solid var(--mz-border)",
    },
    ".cm-line.mz-lp-table-separator-line": {
        fontFamily: "var(--mz-font-mono)",
        fontSize: "0.75em",
        color: "var(--mz-text-muted)",
        background: "var(--mz-bg-tertiary)",
        borderLeft: "1px solid var(--mz-border)",
        borderRight: "1px solid var(--mz-border)",
    },
    ".cm-line.mz-lp-table-row-line": {
        fontFamily: "var(--mz-font-mono)",
        fontSize: "0.95em",
        background: "var(--mz-bg-secondary)",
        borderLeft: "1px solid var(--mz-border)",
        borderRight: "1px solid var(--mz-border)",
        borderBottom: "1px solid var(--mz-border)",
    },

    // Rendered bullet marker for unordered list items. The underlying
    // `-` / `*` / `+` char is inline-replaced with this widget on
    // non-cursor lines; when the cursor enters the line the real
    // character is visible again for editing.
    ".mz-lp-bullet-anchor": {
        display: "inline-block",
        width: "0.95em",
        height: "1em",
        position: "relative",
        verticalAlign: "middle",
    },
    ".mz-lp-bullet": {
        position: "absolute",
        left: "0",
        top: "50%",
        width: "0.42em",
        height: "0.42em",
        borderRadius: "999px",
        background: "var(--mz-text-muted)",
        transform: "translate(-50%, -50%)",
        pointerEvents: "none",
    },
    ".mz-lp-bold": {
        fontWeight: "700",
    },
    ".mz-lp-italic": {
        fontStyle: "italic",
    },
    ".mz-lp-strikethrough": {
        textDecoration: "line-through",
        color: "var(--mz-syntax-strikethrough)",
    },
    ".mz-lp-highlight": {
        background: "var(--mz-syntax-highlight-bg)",
        borderRadius: "2px",
        padding: "1px 2px",
    },
    ".mz-lp-inline-code": {
        fontFamily: "var(--mz-font-mono)",
        fontSize: "0.9em",
        background: "var(--mz-syntax-code-bg)",
        borderRadius: "3px",
        padding: "1px 4px",
    },
    ".mz-lp-link": {
        color: "var(--mz-syntax-link)",
        textDecoration: "none",
        cursor: "pointer",
        borderBottom: "1px solid var(--mz-syntax-link)",
        "&:hover": {
            opacity: "0.8",
        },
    },
    ".mz-lp-link-url": {
        color: "var(--mz-text-muted)",
        fontSize: "0.85em",
    },
    ".mz-lp-blockquote": {
        borderLeft: "3px solid var(--mz-border-strong)",
        paddingLeft: "12px",
        color: "var(--mz-text-secondary)",
        fontStyle: "italic",
    },
    ".mz-lp-hr": {
        display: "block",
        height: "1px",
        textAlign: "center",
        color: "transparent",
        borderBottom: "1px solid var(--mz-border)",
        lineHeight: "1px",
        margin: "8px 0",
    },
    ".mz-lp-image": {
        display: "block",
    },
    ".mz-lp-inline-math": {
        fontFamily: "KaTeX_Math, serif",
        padding: "0 2px",
    },
    ".mz-lp-inline-math .katex": {
        fontSize: "1em",
    },
    ".mz-lp-tag": {
        color: "var(--mz-accent)",
        background: "var(--mz-accent-subtle)",
        borderRadius: "3px",
        padding: "1px 4px",
        fontSize: "0.9em",
        cursor: "pointer",
    },
    ".mz-lp-footnote": {
        color: "var(--mz-accent)",
        fontSize: "0.85em",
        verticalAlign: "super",
        cursor: "pointer",
        "&:hover": {
            textDecoration: "underline",
        },
    },
});

// ---------------------------------------------------------------------------
// Line decorations (headings / blockquote / hr) via a StateField
// ---------------------------------------------------------------------------
//
// CRITICAL: line-level decorations that change font-size or padding affect
// CM6's vertical layout. Per the `EditorView.decorations` facet docs:
//
//   > Only decoration sets provided directly are allowed to influence the
//   > editor's vertical layout structure. The ones provided as functions
//   > are called _after_ the new viewport has been computed […]
//
// A `ViewPlugin.decorations` source is the "provided as function" path,
// so line decorations from a ViewPlugin end up in CM6's layout AFTER
// heights are measured. That staleness is exactly why clicking on a
// heading / blockquote / hr line kept landing on the line BELOW — CM6
// was using the pre-decoration line height for `posAtCoords`.
//
// A StateField instead feeds into `EditorView.decorations` directly via
// `provide: f => EditorView.decorations.from(f)`, runs during state
// updates (not after layout), and IS allowed to affect vertical layout.
// We keep inline/mark decorations in the ViewPlugin below (they don't
// change heights) for performance — only layout-affecting decorations
// need to go through the StateField path.

/**
 * Build JUST the line-level decorations (point decorations attached to
 * `line.from` that add a class to the `<div class="cm-line">` wrapper).
 * These are the ones that change height.
 */
/**
 * Build line-level decorations for the "visual preview" rendering of
 * the raw source. Every line of the document is classified and tagged
 * with a CSS class on its `.cm-line` wrapper. The CSS in
 * `livePreviewTheme` then styles each class so the raw source
 * LOOKS like a rendered preview while every character remains a real
 * cursor position (arrow keys move one line at a time, clicks land
 * on the exact character).
 */
function buildLineDecorations(
    state: import("@codemirror/state").EditorState,
): DecorationSet {
    const doc = state.doc;
    const decos: Range<Decoration>[] = [];
    // No block-widget exclusion — every line is styled via line
    // decorations so raw source LOOKS like rendered blocks while
    // every character stays a real cursor position.
    const tableSepRe = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
    const isTableRow = (t: string) =>
        t.trim().startsWith("|") && t.indexOf("|", t.indexOf("|") + 1) !== -1;

    let inFence = false;
    let fenceChar = "";

    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const text = line.text;

        // --- Fenced code block ---
        // Detect opening/closing fences and tag every line with a CSS
        // class so code blocks render with monospace font, background,
        // and border while keeping every character cursor-addressable.
        const fenceMatch = text.match(/^(`{3,}|~{3,})/);
        if (fenceMatch) {
            if (!inFence) {
                // Opening fence
                inFence = true;
                fenceChar = fenceMatch[1][0];
                decos.push(codeFenceOpenDeco.range(line.from));
            } else if (text.startsWith(fenceChar.repeat(3))) {
                // Closing fence
                inFence = false;
                fenceChar = "";
                decos.push(codeFenceCloseDeco.range(line.from));
            } else {
                // Fence-like line inside a different fence type — treat as content
                decos.push(codeContentDeco.range(line.from));
            }
            continue;
        }
        if (inFence) {
            decos.push(codeContentDeco.range(line.from));
            continue;
        }

        // --- Heading ---
        const headingMatch = text.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            if (headingLineDeco[level]) {
                decos.push(headingLineDeco[level].range(line.from));
            }
            continue;
        }

        // --- Horizontal rule ---
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
            decos.push(hrLineDeco.range(line.from));
            continue;
        }

        // --- Blockquote ---
        if (text.startsWith("> ")) {
            decos.push(blockquoteLineDeco.range(line.from));
        }

        // --- Nested list guide lines ---
        {
            const listInfo = getContinuationInfo(text);
            if (
                listInfo &&
                listInfo.kind !== "blockquote" &&
                listInfo.level > 0
            ) {
                decos.push(listGuideDeco(listInfo.level).range(line.from));
            }
        }

        if (isTableRow(text)) {
            if (tableSepRe.test(text)) {
                decos.push(tableSepDeco.range(line.from));
            } else if (
                i + 1 <= doc.lines &&
                tableSepRe.test(doc.line(i + 1).text)
            ) {
                decos.push(tableHeaderDeco.range(line.from));
            } else {
                // Body row — only decorate if a separator exists above
                let j = i - 1;
                let inTable = false;
                while (j >= 1) {
                    const pt = doc.line(j).text;
                    if (tableSepRe.test(pt)) { inTable = true; break; }
                    if (!isTableRow(pt)) break;
                    j--;
                }
                if (inTable) decos.push(tableRowDeco.range(line.from));
            }
            continue;
        }
    }
    return Decoration.set(decos);
}

const lineDecorationField = StateField.define<DecorationSet>({
    create(state) {
        return buildLineDecorations(state);
    },
    update(deco, tr: Transaction) {
        // Only rebuild when the document actually changed — line
        // classification doesn't depend on selection/scroll, so we can
        // skip rebuilds on cursor movement.
        if (tr.docChanged || tr.selection) {
            return buildLineDecorations(tr.state);
        }
        return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
});

// (forceMeasurePlugin removed — once block-widget `estimatedHeight`
// returns -1, CM6 measures actual DOM heights on render and HeightMap
// stays accurate without any manual measure-request nagging.)

// ---------------------------------------------------------------------------
// ViewPlugin: inline/mark decorations only (bold, italic, hide markers, etc.)
// ---------------------------------------------------------------------------

function createLivePreviewPlugin(vaultRoot: string, currentFilePath: string) {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;
            resizeObserver: ResizeObserver | null = null;

            constructor(view: EditorView) {
                syncListGuideMetrics(view);
                this.decorations = buildDecorations(view, vaultRoot, currentFilePath);

                if (typeof ResizeObserver !== "undefined") {
                    this.resizeObserver = new ResizeObserver(() => {
                        syncListGuideMetrics(view);
                    });
                    this.resizeObserver.observe(view.dom);
                }
            }

            update(update: ViewUpdate) {
                if (update.geometryChanged || update.viewportChanged) {
                    syncListGuideMetrics(update.view);
                }
                if (
                    update.docChanged ||
                    update.selectionSet ||
                    update.viewportChanged
                ) {
                    this.decorations = buildDecorations(
                        update.view,
                        vaultRoot,
                        currentFilePath,
                    );
                }
            }

            destroy() {
                this.resizeObserver?.disconnect();
            }
        },
        {
            decorations: (v) => v.decorations,
        },
    );
}

/**
 * Create the complete Live Preview extension bundle.
 *
 * Order matters:
 *   1. `livePreviewTheme` — base theme styles.
 *   2. `lineDecorationField` — StateField that owns line-level
 *      decorations (headings/blockquote/hr). MUST come through a
 *      StateField so CM6 can use it for vertical layout (see the
 *      long comment above `buildLineDecorations`).
 *   3. `createLivePreviewPlugin(vaultRoot)` — ViewPlugin that owns
 *      inline/mark/replace decorations (bold, italic, hide markers,
 *      links, etc.). These don't change line heights so they're safe
 *      to compute in the faster viewport-triggered path.
 *
 * @param vaultRoot - Absolute path to the vault root (for resolving image paths)
 * @returns Array of CM6 extensions to add to the editor
 */
export function livePreviewExtension(vaultRoot: string, currentFilePath: string) {
    return [
        livePreviewTheme,
        lineDecorationField,
        createLivePreviewPlugin(vaultRoot, currentFilePath),
    ];
}
