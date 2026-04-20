/**
 * MindZJ Reading View
 *
 * Renders Markdown as fully styled HTML, matching Obsidian's reading mode.
 * Supports:
 * - Headings, paragraphs, blockquotes
 * - Bold, italic, strikethrough, highlight, inline code
 * - Links (markdown & wiki), images
 * - Fenced code blocks with Shiki syntax highlighting
 * - Math (inline $...$ and block $$...$$) with KaTeX
 * - Mermaid diagrams
 * - Callout/admonition blocks
 * - Tables
 * - Task lists, ordered/unordered lists
 * - Horizontal rules
 * - Footnotes
 * - Tags
 */

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
import { vaultStore } from "../../stores/vault";
import { editorStore } from "../../stores/editor";
import { settingsStore } from "../../stores/settings";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { ReadingFindPanel } from "./ReadingFindPanel";
import { findPanelOpen, setFindPanelOpen } from "../../stores/findState";
import katex from "katex";
import { resolveImageAssetUrl } from "../../utils/vaultPaths";
import { openFileRouted } from "../../utils/openFileRouted";
import { showImageContextMenu } from "./extensions/livePreview";
import { LIST_INDENT_EXTRA_PX, LIST_RENDER_TAB_SIZE } from "./extensions/listUtils";
import { attachWheelZoom, attachCtrlClick } from "../../utils/imageInteraction";
import { parseImageSize, formatImageAlt } from "../../utils/imageSize";
import { linkifyHtmlText, ensureScheme } from "../../utils/autoLink";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";

// ---------------------------------------------------------------------------
// Markdown → HTML renderer
// ---------------------------------------------------------------------------

interface RenderContext {
    vaultRoot: string;
    currentFilePath: string;
    footnotes: Map<string, string>;
}

type ReadingListKind = "task" | "ul" | "ol";

interface ReadingListToken {
    kind: ReadingListKind;
    level: number;
    line: number;
    content: string;
    checked?: boolean;
    start?: number;
}

function measureListIndent(whitespace: string): number {
    let columns = 0;
    for (const char of whitespace) {
        columns += char === "\t" ? 4 : 1;
    }
    return Math.floor(columns / 4);
}

function parseReadingListToken(
    line: string,
    lineNumber: number,
): ReadingListToken | null {
    // The third capture group is `(\s(.*))?` (optional) so that an
    // empty list item like `2. ` (or `- [ ]` or `- ` with no content)
    // STILL matches and renders as a list item with empty content.
    // The previous regexes used `\s(.+)$` which required at least
    // one character after the marker — that broke the very common
    // case of a half-typed ordered list where the last line is just
    // `3. ` and the user expects it to render aligned with `1.`/`2.`
    // instead of as a stray paragraph below the <ol>.

    const taskMatch = line.match(/^(\s*)- \[([ xX])\](?:\s(.*))?$/);
    if (taskMatch) {
        return {
            kind: "task",
            level: measureListIndent(taskMatch[1] ?? ""),
            line: lineNumber,
            content: taskMatch[3] ?? "",
            checked: taskMatch[2] !== " ",
        };
    }

    const unorderedMatch = line.match(/^(\s*)([-*+])(?:\s(.*))?$/);
    if (unorderedMatch) {
        return {
            kind: "ul",
            level: measureListIndent(unorderedMatch[1] ?? ""),
            line: lineNumber,
            content: unorderedMatch[3] ?? "",
        };
    }

    const orderedMatch = line.match(/^(\s*)(\d+)\.(?:\s(.*))?$/);
    if (orderedMatch) {
        return {
            kind: "ol",
            level: measureListIndent(orderedMatch[1] ?? ""),
            line: lineNumber,
            content: orderedMatch[3] ?? "",
            start: Number.parseInt(orderedMatch[2], 10),
        };
    }

    return null;
}

function openReadingList(token: ReadingListToken): string {
    const classes = ["mz-rv-list"];
    if (token.kind === "ol") {
        classes.push("mz-rv-list-ol");
        return `<ol class="${classes.join(" ")}" start="${token.start ?? 1}">`;
    }
    if (token.kind === "task") {
        classes.push("mz-rv-task-list", "mz-rv-list-ul");
        return `<ul class="${classes.join(" ")}">`;
    }
    classes.push("mz-rv-list-ul");
    return `<ul class="${classes.join(" ")}">`;
}

function renderReadingListItem(
    token: ReadingListToken,
    ctx: RenderContext,
): string {
    const content = renderInline(token.content, ctx);
    if (token.kind === "task") {
        return (
            `<li class="mz-rv-task-item${token.checked ? " checked" : ""}" data-line="${token.line}">` +
            `<input type="checkbox" ${token.checked ? "checked" : ""} disabled />` +
            `<div class="mz-rv-task-item-content"><span>${content}</span>`
        );
    }
    const body =
        token.content.trim() === ""
            ? '<span class="mz-rv-empty-list-slot" aria-hidden="true"></span>'
            : content;
    return `<li data-line="${token.line}">${body}`;
}

function renderReadingListTokens(
    tokens: ReadingListToken[],
    startIndex: number,
    level: number,
    ctx: RenderContext,
): { html: string; nextIndex: number } {
    let html = "";
    let index = startIndex;

    while (index < tokens.length) {
        const first = tokens[index];
        if (first.level < level) break;
        if (first.level > level) {
            const nested = renderReadingListTokens(tokens, index, first.level, ctx);
            html += nested.html;
            index = nested.nextIndex;
            continue;
        }

        html += openReadingList(first);
        while (index < tokens.length) {
            const token = tokens[index];
            if (token.level !== level || token.kind !== first.kind) break;

            html += renderReadingListItem(token, ctx);
            index++;

            while (index < tokens.length && tokens[index].level > level) {
                const nested = renderReadingListTokens(
                    tokens,
                    index,
                    tokens[index].level,
                    ctx,
                );
                html += nested.html;
                index = nested.nextIndex;
            }

            html += token.kind === "task" ? "</div></li>" : "</li>";
        }
        html += first.kind === "ol" ? "</ol>" : "</ul>";
    }

    return { html, nextIndex: index };
}

function renderReadingListBlock(
    lines: string[],
    startIndex: number,
    ctx: RenderContext,
): { html: string; nextIndex: number } | null {
    const tokens: ReadingListToken[] = [];
    let index = startIndex;

    while (index < lines.length) {
        const token = parseReadingListToken(lines[index], index);
        if (!token) break;
        tokens.push(token);
        index++;
    }

    if (tokens.length === 0) return null;

    return {
        html: renderReadingListTokens(tokens, 0, tokens[0].level, ctx).html,
        nextIndex: index,
    };
}

function markdownToHtml(md: string, ctx: RenderContext): string {
    const lines = md.split("\n");
    const html: string[] = [];
    let i = 0;
    const closeList = () => {};

    // First pass: collect footnote definitions
    for (const line of lines) {
        const fnDefMatch = line.match(/^\[\^([^\]]+)\]:\s*(.+)$/);
        if (fnDefMatch) {
            ctx.footnotes.set(fnDefMatch[1], fnDefMatch[2]);
        }
    }

    while (i < lines.length) {
        const line = lines[i];

        // --- Fenced code block ---
        const codeMatch = line.match(/^(`{3,}|~{3,})(\w*)\s*$/);
        if (codeMatch) {
            closeList();
            const fence = codeMatch[1];
            const lang = codeMatch[2] || "";
            const codeLines: string[] = [];
            i++;
            while (i < lines.length) {
                if (
                    lines[i].startsWith(fence.charAt(0).repeat(fence.length)) &&
                    lines[i].trim().length <= fence.length + 1
                ) {
                    i++;
                    break;
                }
                codeLines.push(lines[i]);
                i++;
            }
            const code = escapeHtml(codeLines.join("\n"));
            const langAttr = lang ? ` data-lang="${lang}"` : "";
            const langBadge = lang
                ? `<span class="mz-rv-code-lang">${lang}</span>`
                : "";

            if (lang === "mermaid") {
                html.push(
                    `<div class="mz-rv-mermaid" data-mermaid="${escapeAttr(codeLines.join("\n"))}">${langBadge}<pre><code>${code}</code></pre></div>`,
                );
            } else {
                html.push(
                    `<div class="mz-rv-code"${langAttr}>${langBadge}<button class="mz-rv-code-copy" onclick="navigator.clipboard.writeText(this.parentElement.querySelector('code').textContent).then(()=>{this.textContent='${escapeAttr(t("common.copyDone"))}';setTimeout(()=>this.textContent='${escapeAttr(t("common.copy"))}',1500)})">${t("common.copy")}</button><pre><code>${code}</code></pre></div>`,
                );
            }
            continue;
        }

        // --- Math block ---
        if (line.trim() === "$$") {
            closeList();
            const mathLines: string[] = [];
            i++;
            while (i < lines.length && lines[i].trim() !== "$$") {
                mathLines.push(lines[i]);
                i++;
            }
            if (i < lines.length) i++; // skip closing $$
            const tex = mathLines.join("\n");
            try {
                const rendered = katex.renderToString(tex.trim(), {
                    displayMode: true,
                    throwOnError: false,
                    output: "html",
                    trust: true,
                });
                html.push(`<div class="mz-rv-math-block">${rendered}</div>`);
            } catch {
                html.push(
                    `<div class="mz-rv-math-block mz-rv-error">${escapeHtml(tex)}</div>`,
                );
            }
            continue;
        }

        // --- Callout block ---
        const calloutMatch = line.match(/^>\s*\[!(\w+)\]([+-])?\s*(.*)?$/);
        if (calloutMatch) {
            closeList();
            const type = calloutMatch[1];
            const foldChar = calloutMatch[2] || "";
            const title =
                calloutMatch[3] || type.charAt(0).toUpperCase() + type.slice(1);
            const bodyLines: string[] = [];
            i++;
            while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
                bodyLines.push(lines[i].replace(/^>\s?/, ""));
                i++;
            }
            const bodyHtml = renderInline(bodyLines.join("\n"), ctx);
            const def = getCalloutDef(type);
            const foldable = foldChar === "+" || foldChar === "-";
            const defaultOpen = foldChar !== "-";

            html.push(
                `<div class="mz-rv-callout" style="border-left-color:${def.color}">` +
                    `<div class="mz-rv-callout-header"${foldable ? ' onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'block\':\'none\';this.querySelector(\'.fold\').textContent=this.nextElementSibling.style.display===\'none\'?\'▶\':\'▼\'" style="cursor:pointer"' : ""}>` +
                    `<span class="mz-rv-callout-icon">${def.icon}</span>` +
                    `<span class="mz-rv-callout-title" style="color:${def.color}">${escapeHtml(title)}</span>` +
                    (foldable
                        ? `<span class="fold">${defaultOpen ? "▼" : "▶"}</span>`
                        : "") +
                    `</div>` +
                    `<div class="mz-rv-callout-body"${foldable && !defaultOpen ? ' style="display:none"' : ""}>${bodyHtml}</div>` +
                    `</div>`,
            );
            continue;
        }

        // --- Table ---
        if (line.includes("|") && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
            closeList();
            const tableLines: string[] = [];
            while (i < lines.length && lines[i].includes("|")) {
                tableLines.push(lines[i]);
                i++;
            }
            html.push(renderTable(tableLines, ctx));
            continue;
        }

        // --- Horizontal rule ---
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            closeList();
            html.push('<hr class="mz-rv-hr" />');
            i++;
            continue;
        }

        // --- Heading ---
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            closeList();
            const level = headingMatch[1].length;
            const content = renderInline(headingMatch[2], ctx);
            const id = headingMatch[2]
                .toLowerCase()
                .replace(/[^\w\u4e00-\u9fff]+/g, "-")
                .replace(/(^-|-$)/g, "");
            html.push(`<h${level} id="${id}" class="mz-rv-h${level}" data-line="${i}">${content}</h${level}>`);
            i++;
            continue;
        }

        // --- Blockquote (non-callout) ---
        if (line.startsWith("> ") || line === ">") {
            closeList();
            const bqStart = i;
            const quoteLines: string[] = [];
            while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
                quoteLines.push(lines[i].replace(/^>\s?/, ""));
                i++;
            }
            const inner = renderInline(quoteLines.join("\n"), ctx);
            html.push(`<blockquote class="mz-rv-blockquote" data-line="${bqStart}">${inner}</blockquote>`);
            continue;
        }

        // --- Lists (ordered / unordered / task, with nesting) ---
        const listBlock = renderReadingListBlock(lines, i, ctx);
        if (listBlock) {
            closeList();
            html.push(listBlock.html);
            i = listBlock.nextIndex;
            continue;
        }

        // --- Footnote definition ---
        const fnDefMatch = line.match(/^\[\^([^\]]+)\]:\s*(.+)$/);
        if (fnDefMatch) {
            closeList();
            const id = fnDefMatch[1];
            const content = renderInline(fnDefMatch[2], ctx);
            html.push(
                `<div class="mz-rv-footnote-def" id="fn-${id}">` +
                    `<sup>${id}</sup> ${content}` +
                    `</div>`,
            );
            i++;
            continue;
        }

        // --- Empty line ---
        // Reading mode should collapse blank source lines instead of
        // emitting placeholder paragraphs, so we just skip them.
        if (line.trim() === "") {
            closeList();
            i++;
            continue;
        }

        // --- Paragraph ---
        closeList();
        const paraStart = i;
        const paraLines: string[] = [line];
        i++;
        while (
            i < lines.length &&
            lines[i].trim() !== "" &&
            !lines[i].match(/^#{1,6}\s/) &&
            !lines[i].match(/^(`{3,}|~{3,})/) &&
            !lines[i].startsWith("> ") &&
            !lines[i].match(/^\s*[-*+]\s/) &&
            !lines[i].match(/^\s*\d+\.\s/) &&
            lines[i].trim() !== "$$" &&
            !lines[i].match(/^(-{3,}|\*{3,}|_{3,})\s*$/)
        ) {
            paraLines.push(lines[i]);
            i++;
        }
        const paraContent = renderInline(paraLines.join("\n"), ctx);
        html.push(`<p data-line="${paraStart}">${paraContent}</p>`);
    }

    // Add footnote section if any
    if (ctx.footnotes.size > 0) {
        html.push('<hr class="mz-rv-hr" />');
        html.push('<section class="mz-rv-footnotes">');
        for (const [id, text] of ctx.footnotes) {
            if (!html.some((h) => h.includes(`id="fn-${id}"`))) {
                html.push(
                    `<div class="mz-rv-footnote-def" id="fn-${id}"><sup>${id}</sup> ${renderInline(text, ctx)}</div>`,
                );
            }
        }
        html.push("</section>");
    }

    return html.join("\n");
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function renderInline(text: string, ctx: RenderContext): string {
    let result = escapeHtml(text);

    // Inline math: $...$
    result = result.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_, tex) => {
        try {
            return katex.renderToString(unescapeHtml(tex).trim(), {
                displayMode: false,
                throwOnError: false,
                output: "html",
                trust: true,
            });
        } catch {
            return `<code class="mz-rv-error">${tex}</code>`;
        }
    });

    // Images: ![alt](src) — with optional `|width` / `|widthxheight`
    // suffix in the alt text for persisted display size (see
    // `utils/imageSize.ts`).
    result = result.replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        (_, alt, src) => {
            const rawSrc = unescapeHtml(src);
            const resolvedSrc = resolveImageSrc(
                rawSrc,
                ctx.vaultRoot,
                ctx.currentFilePath,
            );
            // Split `alt|width[xheight]` so the rendered alt text
            // doesn't include the size suffix, and the inline
            // style gets the persisted dimensions.
            const { altText, width, height } = parseImageSize(alt);
            const escapedAlt = escapeAttr(altText);
            const styleBits: string[] = [];
            if (width != null) {
                styleBits.push(`width:${width}px`);
                styleBits.push(height != null ? `height:${height}px` : "height:auto");
            }
            const styleAttr =
                styleBits.length > 0 ? ` style="${styleBits.join(";")}"` : "";
            const dataWidthAttr =
                width != null ? ` data-ppi-wheel-inline-width="${width}"` : "";
            return `<span class="image-embed internal-embed is-loaded"><img src="${resolvedSrc}" data-src="${escapeAttr(rawSrc)}" alt="${escapedAlt}" class="mz-rv-image"${styleAttr}${dataWidthAttr} loading="lazy" /></span>`;
        },
    );

    // Wiki links: [[target|display]] or [[target]]
    result = result.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, display) => {
        const label = display || target;
        return `<a class="mz-rv-wikilink" data-target="${escapeAttr(target)}">${label}</a>`;
    });

    // Markdown links: [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
        const isExternal = url.startsWith("http://") || url.startsWith("https://");
        return `<a href="${escapeAttr(url)}" class="mz-rv-link"${isExternal ? ' target="_blank" rel="noopener"' : ""}>${text}</a>`;
    });

    // Auto-link bare URLs (github.com/foo, https://example.com, …).
    // Gated by the `auto_link_urls` setting; when off, URLs render as
    // plain text. Skips URLs already inside an <a> tag so the
    // markdown-link replace above isn't clobbered.
    if (settingsStore.settings().auto_link_urls) {
        result = linkifyHtmlText(result, (url) => {
            const href = ensureScheme(url);
            return `<a href="${escapeAttr(href)}" class="mz-rv-link mz-rv-autolink" target="_blank" rel="noopener">${url}</a>`;
        });
    }

    // Bold: **text** or __text__
    result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    result = result.replace(/__(.+?)__/g, "<strong>$1</strong>");

    // Italic: *text* or _text_
    result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

    // Strikethrough: ~~text~~
    result = result.replace(/~~(.+?)~~/g, "<del>$1</del>");

    // Highlight: ==text==
    result = result.replace(/==(.+?)==/g, '<mark class="mz-rv-highlight">$1</mark>');

    // Inline code: `text`
    result = result.replace(/(?<!`)`(?!`)(.+?)(?<!`)`(?!`)/g, '<code class="mz-rv-inline-code">$1</code>');

    // Tags: #tag
    result = result.replace(
        /(?<=\s|^)#([a-zA-Z\u4e00-\u9fff][\w\u4e00-\u9fff/\-]*)/g,
        '<span class="mz-rv-tag">#$1</span>',
    );

    // Footnote references: [^id]
    result = result.replace(/\[\^([^\]]+)\]/g, '<sup class="mz-rv-footnote-ref"><a href="#fn-$1">$1</a></sup>');

    // Line breaks
    result = result.replace(/\n/g, "<br />");

    return result;
}

// ---------------------------------------------------------------------------
// Table renderer
// ---------------------------------------------------------------------------

function renderTable(lines: string[], ctx: RenderContext): string {
    const parseRow = (line: string): string[] =>
        line
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim());

    if (lines.length < 2) return "";

    const headerCells = parseRow(lines[0]);
    const alignRow = parseRow(lines[1]);
    const aligns = alignRow.map((cell) => {
        if (cell.startsWith(":") && cell.endsWith(":")) return "center";
        if (cell.endsWith(":")) return "right";
        return "left";
    });

    let html = '<table class="mz-rv-table"><thead><tr>';
    for (let j = 0; j < headerCells.length; j++) {
        html += `<th style="text-align:${aligns[j] || "left"}">${renderInline(headerCells[j], ctx)}</th>`;
    }
    html += "</tr></thead><tbody>";

    for (let i = 2; i < lines.length; i++) {
        const cells = parseRow(lines[i]);
        html += "<tr>";
        for (let j = 0; j < headerCells.length; j++) {
            html += `<td style="text-align:${aligns[j] || "left"}">${renderInline(cells[j] || "", ctx)}</td>`;
        }
        html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
}

// ---------------------------------------------------------------------------
// Callout definitions
// ---------------------------------------------------------------------------

interface CalloutDef {
    icon: string;
    color: string;
}

const CALLOUT_TYPES: Record<string, CalloutDef> = {
    note:      { icon: "📝", color: "var(--mz-callout-note)" },
    abstract:  { icon: "📋", color: "var(--mz-callout-info)" },
    summary:   { icon: "📋", color: "var(--mz-callout-info)" },
    info:      { icon: "ℹ️", color: "var(--mz-callout-info)" },
    tip:       { icon: "💡", color: "var(--mz-callout-tip)" },
    hint:      { icon: "💡", color: "var(--mz-callout-tip)" },
    important: { icon: "🔥", color: "var(--mz-callout-warning)" },
    success:   { icon: "✅", color: "var(--mz-callout-tip)" },
    check:     { icon: "✅", color: "var(--mz-callout-tip)" },
    done:      { icon: "✅", color: "var(--mz-callout-tip)" },
    question:  { icon: "❓", color: "var(--mz-callout-warning)" },
    help:      { icon: "❓", color: "var(--mz-callout-warning)" },
    faq:       { icon: "❓", color: "var(--mz-callout-warning)" },
    warning:   { icon: "⚠️", color: "var(--mz-callout-warning)" },
    caution:   { icon: "⚠️", color: "var(--mz-callout-warning)" },
    attention: { icon: "⚠️", color: "var(--mz-callout-warning)" },
    failure:   { icon: "❌", color: "var(--mz-callout-danger)" },
    fail:      { icon: "❌", color: "var(--mz-callout-danger)" },
    missing:   { icon: "❌", color: "var(--mz-callout-danger)" },
    danger:    { icon: "🔴", color: "var(--mz-callout-danger)" },
    error:     { icon: "⛔", color: "var(--mz-callout-danger)" },
    bug:       { icon: "🐛", color: "var(--mz-callout-danger)" },
    example:   { icon: "📖", color: "var(--mz-callout-note)" },
    quote:     { icon: "❝", color: "var(--mz-text-muted)" },
    cite:      { icon: "❝", color: "var(--mz-text-muted)" },
};

function getCalloutDef(type: string): CalloutDef {
    return CALLOUT_TYPES[type.toLowerCase()] ?? CALLOUT_TYPES.note;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function unescapeHtml(str: string): string {
    return str
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');
}

function escapeAttr(str: string): string {
    return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function resolveImageSrc(
    src: string,
    vaultRoot: string,
    currentFilePath: string,
): string {
    return resolveImageAssetUrl(src, vaultRoot, currentFilePath);
}

// ---------------------------------------------------------------------------
// Shiki code highlighting (post-render)
// ---------------------------------------------------------------------------

async function highlightCodeBlocks(container: HTMLElement): Promise<void> {
    const { createHighlighter } = await import("shiki");
    const codeBlocks = container.querySelectorAll<HTMLElement>(".mz-rv-code[data-lang]");
    if (codeBlocks.length === 0) return;

    const langs = new Set<string>();
    codeBlocks.forEach((block) => {
        const lang = block.dataset.lang;
        if (lang && lang !== "text" && lang !== "plain") langs.add(lang);
    });
    if (langs.size === 0) return;

    try {
        const highlighter = await createHighlighter({
            themes: ["github-dark", "github-light"],
            langs: [...langs] as any[],
        });

        codeBlocks.forEach((block) => {
            const lang = block.dataset.lang!;
            const codeEl = block.querySelector("code");
            if (!codeEl) return;

            const loadedLangs = highlighter.getLoadedLanguages();
            if (!loadedLangs.includes(lang as any)) return;

            const code = codeEl.textContent || "";
            try {
                const html = highlighter.codeToHtml(code, {
                    lang,
                    theme: "github-dark",
                });
                const wrapper = block.querySelector("pre")!;
                wrapper.outerHTML = html;
                // Fix Shiki pre styles
                const shikiPre = block.querySelector("pre");
                if (shikiPre) {
                    shikiPre.style.cssText =
                        "margin:0; padding:12px 16px; overflow-x:auto; background:transparent !important; font-size:0.88em; line-height:1.5;";
                }
            } catch {
                // Keep plain text
            }
        });
    } catch {
        // Shiki loading failed, keep plain code
    }
}

// ---------------------------------------------------------------------------
// Mermaid rendering (post-render)
// ---------------------------------------------------------------------------

async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
    const mermaidBlocks = container.querySelectorAll<HTMLElement>(".mz-rv-mermaid");
    if (mermaidBlocks.length === 0) return;

    try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
            startOnLoad: false,
            theme: "dark",
            securityLevel: "strict",
        });

        for (let i = 0; i < mermaidBlocks.length; i++) {
            const block = mermaidBlocks[i];
            const code = block.dataset.mermaid;
            if (!code) continue;

            try {
                const id = `mz-rv-mermaid-${Date.now()}-${i}`;
                const { svg } = await mermaid.render(id, code);
                block.innerHTML = svg;
                block.style.textAlign = "center";
            } catch {
                // Keep original code block on error
            }
        }
    } catch {
        // Mermaid loading failed
    }
}

// ---------------------------------------------------------------------------
// Reading-mode search reveal
// ---------------------------------------------------------------------------
//
// These module-level variables track the currently-active search
// flash in reading mode. Stored at module scope (not component
// scope) because:
//
//   1. `clearReadingFlash()` is called from multiple places —
//      both the `search-reveal` handler (to reset before a new
//      flash) and `onCleanup` (when the view unmounts). Having a
//      single source of truth keeps them in sync.
//   2. Multiple ReadingView instances (split panes) shouldn't
//      show simultaneous flashes anyway — only the one the user
//      last clicked a search result for. Module-level state
//      gives us "latest click wins" for free.
let _readingFlashMark: HTMLElement | null = null;
let _readingFlashTimer: number | null = null;

/**
 * Remove any currently-active reading-mode search flash.
 *
 * Un-wraps the `<mark class="mz-search-flash">` by replacing it
 * with a plain text node containing the same content, then calls
 * `normalize()` on the parent to merge adjacent text nodes (so the
 * DOM looks the same as it did before the flash was applied).
 *
 * Also cancels any pending clear-timer so a previous flash's 1.5s
 * timeout can't fire after a new one has started.
 */
function clearReadingFlash(): void {
    if (_readingFlashTimer != null) {
        clearTimeout(_readingFlashTimer);
        _readingFlashTimer = null;
    }
    const mark = _readingFlashMark;
    _readingFlashMark = null;
    if (mark && mark.parentNode) {
        const parent = mark.parentNode;
        const textNode = document.createTextNode(mark.textContent || "");
        parent.replaceChild(textNode, mark);
        parent.normalize();
    }
}

// Outline-click flash: tracks the heading element (if any) that
// currently has the `.mz-search-flash` class applied by an outline
// jump. Kept at module scope for the same reasons as
// `_readingFlashMark` — re-clicks on a different outline entry should
// clear the old flash before starting a new one.
let _outlineFlashEl: HTMLElement | null = null;
let _outlineFlashTimer: number | null = null;

/**
 * Apply the outline-flash class to a heading element for ~1 second,
 * producing a full-row background block in reading mode that mirrors
 * the CM6 line flash used in source / live-preview. Background is
 * `--mz-accent` at 20% opacity (see `.mz-outline-flash` in editor.css).
 *
 * The class is toggled in-place (no DOM restructuring), so reading
 * scroll offsets and nested element state stay stable.
 */
function flashReadingOutlineHeading(el: HTMLElement): void {
    if (_outlineFlashTimer != null) {
        clearTimeout(_outlineFlashTimer);
        _outlineFlashTimer = null;
    }
    if (_outlineFlashEl && _outlineFlashEl !== el) {
        _outlineFlashEl.classList.remove("mz-outline-flash");
    }
    el.classList.add("mz-outline-flash");
    _outlineFlashEl = el;
    _outlineFlashTimer = window.setTimeout(() => {
        _outlineFlashTimer = null;
        if (_outlineFlashEl) {
            _outlineFlashEl.classList.remove("mz-outline-flash");
            _outlineFlashEl = null;
        }
    }, 1000);
}

/**
 * Scroll an element into the middle of a scroll container without
 * using `scrollIntoView({ block: "center" })`, which produces a
 * weird "jumps back to top then snaps" animation in some Chromium
 * versions. We compute the target `scrollTop` manually and set it
 * directly — instant, reliable, no animation.
 */
function scrollElementToCenter(el: HTMLElement, scrollEl: HTMLElement): void {
    const elRect = el.getBoundingClientRect();
    const contRect = scrollEl.getBoundingClientRect();
    const offset =
        elRect.top -
        contRect.top +
        scrollEl.scrollTop -
        scrollEl.clientHeight / 2 +
        elRect.height / 2;
    scrollEl.scrollTop = Math.max(0, offset);
}

/**
 * Apply a temporary search-flash highlight in reading mode.
 *
 * Finds the first text node inside `container` that matches the
 * given `query` (case-insensitively, UTF-16 safe) — preferring
 * text nodes inside an element whose `data-line` attribute equals
 * `line` when multiple matches exist on the page. Wraps the match
 * in a `<mark class="mz-search-flash">`, scrolls it to the middle
 * of the viewport, and schedules an unwrap after 1.5 seconds.
 *
 * Re-clicks before the 1.5s expires call `clearReadingFlash()`
 * first, so the timer is effectively reset.
 */
function flashReadingSearch(
    container: HTMLElement,
    scrollContainer: HTMLElement,
    line: number,
    query: string,
): void {
    clearReadingFlash();
    if (!query) return;

    // Step 1: pick an "anchor" element — the one whose data-line
    // matches (or is closest to) the target line. Search INSIDE
    // the anchor first so multi-match files highlight the hit the
    // user clicked, not just the first occurrence in the document.
    const elts = container.querySelectorAll<HTMLElement>("[data-line]");
    let anchor: HTMLElement | null = null;
    let anchorDelta = Number.POSITIVE_INFINITY;
    for (const el of elts) {
        const ln = parseInt(el.getAttribute("data-line") || "-1", 10);
        if (ln < 0) continue;
        const delta = Math.abs(ln - line);
        if (delta < anchorDelta) {
            anchor = el;
            anchorDelta = delta;
            if (delta === 0) break;
        }
    }

    const queryLower = query.toLowerCase();

    /** Find the first text node in `root` whose contents contain
     *  the query. Skips empty text nodes and any node that's inside
     *  a pre/code element so we don't mangle syntax-highlighted
     *  code spans (those have their own styling and the flash would
     *  look weird anyway). */
    function findMatchIn(
        root: HTMLElement,
    ): { node: Text; index: number } | null {
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
                    // Rejecting <pre>/<code> descendants would lose
                    // matches in fenced code blocks; the user DOES
                    // search through those in the global search
                    // panel, so skipping them here would be
                    // inconsistent. Accept everything.
                    return NodeFilter.FILTER_ACCEPT;
                },
            },
        );
        let n: Node | null;
        while ((n = walker.nextNode())) {
            const textNode = n as Text;
            const idx = textNode.data.toLowerCase().indexOf(queryLower);
            if (idx >= 0) return { node: textNode, index: idx };
        }
        return null;
    }

    let match: { node: Text; index: number } | null = null;
    if (anchor) match = findMatchIn(anchor);
    if (!match) match = findMatchIn(container);

    if (!match) {
        // Couldn't find the query anywhere — still scroll to the
        // anchor so at least the user sees the target region.
        if (anchor) scrollElementToCenter(anchor, scrollContainer);
        return;
    }

    // Step 2: split the matched text node into
    // [before] [<mark>match</mark>] [after] and drop the original.
    const { node, index } = match;
    const matchLen = query.length;
    const text = node.data;
    const beforeText = text.slice(0, index);
    const matchText = text.slice(index, index + matchLen);
    const afterText = text.slice(index + matchLen);

    const parent = node.parentNode;
    if (!parent) return;

    const mark = document.createElement("mark");
    mark.className = "mz-search-flash";
    mark.textContent = matchText;

    if (beforeText) parent.insertBefore(document.createTextNode(beforeText), node);
    parent.insertBefore(mark, node);
    if (afterText) parent.insertBefore(document.createTextNode(afterText), node);
    parent.removeChild(node);

    _readingFlashMark = mark;

    // Step 3: scroll the match into the middle of the viewport.
    scrollElementToCenter(mark, scrollContainer);

    // Step 4: schedule the unwrap. `window.setTimeout` is typed
    // as `number` in the browser (vs `NodeJS.Timeout` in Node),
    // matching our `_readingFlashTimer: number | null` type.
    _readingFlashTimer = window.setTimeout(() => {
        _readingFlashTimer = null;
        clearReadingFlash();
    }, 1500);
}

// ---------------------------------------------------------------------------
// ReadingView Component
// ---------------------------------------------------------------------------

interface ReadingViewProps {
    file?: ReturnType<typeof vaultStore.activeFile>;
    isActive?: boolean;
    onActivate?: () => void;
}

export const ReadingView: Component<ReadingViewProps> = (props) => {
    let containerRef: HTMLDivElement | undefined;
    let scrollContainerRef: HTMLDivElement | undefined;
    let currentFilePath: string | null = null;
    const [contextMenu, setContextMenu] = createSignal<{
        x: number;
        y: number;
        items: MenuItem[];
    } | null>(null);
    // Find panel open-state is read from the shared cross-mode
    // signal in findState.ts so Ctrl+F survives Editor ↔ ReadingView
    // transitions. Imported at the top of the file.
    const resolvedFile = createMemo(() => props.file ?? vaultStore.activeFile());
    const isPaneActive = () => props.isActive ?? true;

    function closeContextMenu() {
        setContextMenu(null);
    }

    function activatePane() {
        props.onActivate?.();
    }

    function syncPluginReadingBindings() {
        if (!isPaneActive()) return;
        if (!containerRef || !scrollContainerRef) {
            (window as any).__mindzj_markdown_view = null;
            return;
        }

        const activePath = resolvedFile()?.path ?? "";
        const fileName = activePath.split("/").pop() ?? activePath;
        const activeFile = resolvedFile();
        const markdownView: any = {
            editor: {
                getValue: () => activeFile?.content ?? "",
                focus: () => scrollContainerRef.focus(),
            },
            containerEl: scrollContainerRef,
            contentEl: containerRef,
            editMode: null,
            currentMode: null,
            sourceMode: null,
            leaf: { width: scrollContainerRef.clientWidth || 0, containerEl: scrollContainerRef, view: null },
            file: activePath ? {
                path: activePath,
                name: fileName,
                basename: fileName.replace(/\.[^.]+$/, ""),
                extension: fileName.includes(".") ? fileName.split(".").pop() ?? "" : "",
                stat: { mtime: Date.now(), ctime: Date.now(), size: activeFile?.content.length ?? 0 },
                vault: { getName: () => vaultStore.vaultInfo()?.name ?? "vault" },
                parent: {
                    path: activePath.includes("/") ? activePath.split("/").slice(0, -1).join("/") : "",
                    name: activePath.includes("/") ? activePath.split("/").slice(-2, -1)[0] || "/" : "/",
                },
            } : null,
            getViewType: () => "markdown",
            getMode: () => "preview",
        };
        markdownView.leaf.view = markdownView;
        (window as any).__mindzj_markdown_view = markdownView;
    }

    // Helper: find the first data-line element whose top is at or past
    // the scroll container's top edge. Used to keep the "top visible
    // line" in the store up to date as the user scrolls.
    function computeTopVisibleLine(): number | null {
        if (!scrollContainerRef || !containerRef) return null;
        const containerTop = scrollContainerRef.getBoundingClientRect().top;
        const elts = containerRef.querySelectorAll<HTMLElement>("[data-line]");
        let best: { line: number; delta: number } | null = null;
        for (const el of elts) {
            const ln = parseInt(el.getAttribute("data-line") || "-1", 10);
            if (ln < 0) continue;
            const rect = el.getBoundingClientRect();
            const delta = rect.top - containerTop;
            if (delta >= -8) {
                if (!best || delta < best.delta) best = { line: ln + 1, delta };
            }
        }
        return best?.line ?? null;
    }

    function rememberReadingViewport(path: string | null = currentFilePath) {
        if (!path || !scrollContainerRef) return;
        editorStore.setFileScrollPosition(path, "reading", scrollContainerRef.scrollTop);
        const line = computeTopVisibleLine();
        if (line !== null) {
            editorStore.setFileTopLine(path, line);
            editorStore.setCursorLine(line);
        }
    }

    function setReadingSurfaceVisibility(visible: boolean) {
        if (!scrollContainerRef) return;
        scrollContainerRef.style.visibility = visible ? "visible" : "hidden";
    }

    function syncReadingListGuideMetrics() {
        if (!containerRef) return;
        const probe = document.createElement("span");
        probe.textContent = "\t";
        probe.style.position = "absolute";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.whiteSpace = "pre";
        probe.style.padding = "0";
        probe.style.margin = "0";
        probe.style.border = "0";
        probe.style.font = getComputedStyle(containerRef).font;
        probe.style.tabSize = `${LIST_RENDER_TAB_SIZE}`;
        (probe.style as any).MozTabSize = `${LIST_RENDER_TAB_SIZE}`;
        containerRef.appendChild(probe);
        const measured = probe.getBoundingClientRect().width;
        probe.remove();
        const rawIndentWidth = Math.max(
            40,
            Math.round((Number.isFinite(measured) ? measured : 0) + LIST_INDENT_EXTRA_PX),
        );
        const indentWidth = rawIndentWidth % 2 === 0 ? rawIndentWidth : rawIndentWidth + 1;
        const guideOffset = Math.max(1, indentWidth / 2);
        containerRef.style.setProperty("--mz-reading-list-indent-step", `${indentWidth}px`);
        containerRef.style.setProperty("--mz-reading-list-guide-offset", `${guideOffset}px`);
    }

    function selectAllReadingContent() {
        if (!containerRef) return;
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(containerRef);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    async function copyReadingSelection() {
        const text = window.getSelection()?.toString() ?? "";
        if (!text) return;
        await navigator.clipboard.writeText(text).catch(() => {});
    }

    function buildReadingContextMenu(): MenuItem[] {
        return [
            {
                label: t("common.copy"),
                action: () => { void copyReadingSelection(); },
            },
            {
                label: t("context.selectAll"),
                action: () => { selectAllReadingContent(); },
            },
            {
                label: t("context.readingView"),
                action: () => {
                    activatePane();
                    editorStore.setViewMode("reading", currentFilePath ?? undefined);
                },
                separator: true,
            },
            {
                label: t("context.editMode"),
                action: () => {
                    activatePane();
                    editorStore.setViewMode("live-preview", currentFilePath ?? undefined);
                },
            },
            {
                label: t("context.sourceMode"),
                action: () => {
                    activatePane();
                    editorStore.setViewMode("source", currentFilePath ?? undefined);
                },
            },
        ];
    }

    function handleRememberViewport() {
        rememberReadingViewport();
    }

    // Listen for outline heading clicks — scroll the heading to the TOP
    onMount(() => {
        syncPluginReadingBindings();
        document.addEventListener(
            "mindzj:remember-active-viewport",
            handleRememberViewport,
        );
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.command === "goto-line" && containerRef && scrollContainerRef) {
                const targetLine = detail.line;
                // Find an anchor element matching the target source
                // line. Exact match first; if none, fall back to the
                // largest `data-line` ≤ targetLine so Ctrl+G landing
                // on a blank / list-item line still produces a
                // useful scroll instead of silently doing nothing.
                const anchors = containerRef.querySelectorAll<HTMLElement>("[data-line]");
                let target: HTMLElement | null = null;
                let bestLine = -1;
                for (const h of anchors) {
                    const hLine = parseInt(h.getAttribute("data-line") || "-1");
                    if (hLine === targetLine) {
                        target = h;
                        bestLine = hLine;
                        break;
                    }
                    if (hLine >= 0 && hLine <= targetLine && hLine > bestLine) {
                        target = h;
                        bestLine = hLine;
                    }
                }
                if (!target && anchors.length > 0) {
                    target = anchors[0];
                }
                if (target) {
                    // Instant scroll (no smooth animation) — user wants
                    // outline / Ctrl+G clicks to jump straight to the
                    // target.
                    const containerTop = scrollContainerRef.getBoundingClientRect().top;
                    const targetTop = target.getBoundingClientRect().top;
                    const offset = targetTop - containerTop + scrollContainerRef.scrollTop;
                    scrollContainerRef.scrollTop = offset;

                    // Paint the same search-reveal flash on the target
                    // for ~1s so the user's eye can latch onto where
                    // the goto-line landed. Reuses the
                    // `.mz-search-flash` class so the colour matches
                    // the search-selection flash in CM6 modes.
                    flashReadingOutlineHeading(target);
                }
            } else if (detail?.command === "search-reveal") {
                // The search-reveal command may arrive BEFORE the
                // reading view has finished rendering (the 150ms
                // wait in SearchPanel covers typical cases but
                // can race on large files). Retry up to 20 times
                // at 50ms intervals — total ≤ 1s — until the
                // container has content, then fire the flash.
                const line = typeof detail.line === "number" ? detail.line : 0;
                const query: string = typeof detail.query === "string"
                    ? detail.query
                    : "";
                let retries = 0;
                const tryFlash = () => {
                    if (
                        containerRef &&
                        scrollContainerRef &&
                        containerRef.childElementCount > 0
                    ) {
                        flashReadingSearch(
                            containerRef,
                            scrollContainerRef,
                            line,
                            query,
                        );
                        return;
                    }
                    if (retries < 20) {
                        retries++;
                        setTimeout(tryFlash, 50);
                    }
                };
                tryFlash();
            }
        };
        document.addEventListener("mindzj:editor-command", handler);

        // Ctrl+F in reading mode: show the floating find panel. The
        // event is dispatched from App.tsx's global keydown handler
        // when the active pane is in reading mode (CM6 modes take the
        // `openSearchPanel(cmView)` path instead). Only the pane that
        // currently owns focus should open — otherwise pressing Ctrl+F
        // with two split reading panes would pop a panel in each.
        const handleOpenFind = () => {
            if (!isPaneActive()) return;
            setFindPanelOpen(true);
        };
        document.addEventListener("mindzj:open-reading-find", handleOpenFind);

        // Close event fires for ESC / Ctrl+F-to-toggle from App.tsx
        // regardless of where focus currently is. ALL open reading
        // panels close — split reading panes will each close their
        // own panel, which is fine (they're both unused at that point).
        const handleCloseFind = () => {
            setFindPanelOpen(false);
        };
        document.addEventListener("mindzj:close-reading-find", handleCloseFind);

        onCleanup(() => {
            document.removeEventListener("mindzj:editor-command", handler);
            document.removeEventListener(
                "mindzj:remember-active-viewport",
                handleRememberViewport,
            );
            document.removeEventListener(
                "mindzj:open-reading-find",
                handleOpenFind,
            );
            document.removeEventListener(
                "mindzj:close-reading-find",
                handleCloseFind,
            );
            // If we unmount while a flash is still pending, clear
            // it so the `<mark>` doesn't outlive its container (if
            // it ever got reparented by a future theme that moved
            // reading content into a portal, say).
            clearReadingFlash();
        });

        // Continuously track the top-visible line as the user scrolls so
        // (a) mode-switches restore the correct position, and (b) the
        // left sidebar outline highlights the heading that's currently
        // in view. We reuse `editorStore.cursorLine` for the outline
        // state because the MarkdownOutline component already reads it
        // — in reading mode there's no real cursor, so "the heading
        // you're currently reading" is the most useful proxy.
        let scrollTimer: number | null = null;
        const onScroll = () => {
            if (scrollTimer != null) return;
            scrollTimer = window.setTimeout(() => {
                scrollTimer = null;
                rememberReadingViewport();
            }, 60);
        };
        scrollContainerRef?.addEventListener("scroll", onScroll, { passive: true });
        // Kick an initial update so the outline reflects the first
        // visible heading the moment ReadingView mounts.
        requestAnimationFrame(() => onScroll());
        onCleanup(() => {
            scrollContainerRef?.removeEventListener("scroll", onScroll);
            if (scrollTimer != null) clearTimeout(scrollTimer);
        });
    });

    createEffect(
        on(
            resolvedFile,
            async (activeFile) => {
                if (!containerRef || !scrollContainerRef || !activeFile) return;
                setReadingSurfaceVisibility(false);
                const previousPath = currentFilePath;
                const sameFile = previousPath === activeFile.path;
                const preserveCurrentScrollTop = sameFile
                    ? scrollContainerRef.scrollTop
                    : null;
                const restoreExactScroll = !sameFile && previousPath !== null
                    ? editorStore.getFileScrollPosition(activeFile.path, "reading")
                    : preserveCurrentScrollTop;

                if (previousPath && !sameFile) {
                    rememberReadingViewport(previousPath);
                }

                currentFilePath = activeFile.path;
                closeContextMenu();
                syncPluginReadingBindings();

                const vaultRoot = vaultStore.vaultInfo()?.path ?? "";
                const ctx: RenderContext = {
                    vaultRoot,
                    currentFilePath: activeFile.path,
                    footnotes: new Map(),
                };

                const html = markdownToHtml(activeFile.content, ctx);
                containerRef.innerHTML = html;

                // Post-render: syntax highlighting and mermaid
                await Promise.all([
                    highlightCodeBlocks(containerRef),
                    renderMermaidBlocks(containerRef),
                ]);

                // Notify the reading-mode find panel that the DOM has
                // been replaced so it can re-wrap match spans against
                // the new content. Without this, the panel survives a
                // mode-switch / tab-switch but its match overlay is
                // still attached to the previous document, leaving
                // highlight marks stranded or absent.
                document.dispatchEvent(
                    new CustomEvent("mindzj:reading-find-refresh"),
                );

                // If the user is switching into Reading mode from an editing
                // mode we have a stashed anchor line — scroll to the element
                // whose source line is closest to (but not past) that line,
                // which gives the reader a position consistent with where
                // they were editing.
                if (restoreExactScroll !== null) {
                    scrollContainerRef.scrollTop = restoreExactScroll;
                } else {
                    const restoreLine = editorStore.getFileTopLine(activeFile.path);
                    if (restoreLine && containerRef && scrollContainerRef) {
                        const restoreDataLine = restoreLine - 1;
                        const elts = containerRef.querySelectorAll<HTMLElement>("[data-line]");
                        let target: HTMLElement | null = null;
                        let bestLine = -1;
                        for (const el of elts) {
                            const ln = parseInt(el.getAttribute("data-line") || "-1", 10);
                            if (ln < 0) continue;
                            // Prefer the greatest line number that is <= restoreLine.
                            if (ln <= restoreDataLine && ln > bestLine) {
                                bestLine = ln;
                                target = el;
                            }
                        }
                        // Fallback: if nothing matched (restoreLine is before the
                        // first anchor), use the very first anchor.
                        if (!target && elts.length > 0) target = elts[0];
                        if (target) {
                            const containerTop = scrollContainerRef.getBoundingClientRect().top;
                            const targetTop = target.getBoundingClientRect().top;
                            scrollContainerRef.scrollTop += targetTop - containerTop - 12;
                        }
                    }
                }

                // Handle wiki link clicks
                containerRef
                    .querySelectorAll<HTMLElement>(".mz-rv-wikilink")
                    .forEach((el) => {
                        el.addEventListener("click", async (e) => {
                            e.preventDefault();
                            const target = el.dataset.target;
                            if (target) {
                                let path = target;
                                if (!path.includes(".")) path += ".md";
                                try {
                                    activatePane();
                                    // Route via openFileRouted so wikilinks
                                    // pointing at images / office docs /
                                    // PDFs open in their proper viewer.
                                    await openFileRouted(path);
                                    editorStore.setViewMode("reading", path);
                                } catch {
                                    console.warn(t("reading.couldNotOpen", { path }));
                                }
                            }
                        });
                    });

                // External link click handling. The rendered markdown
                // gives every external link (`[text](http…)` and our
                // auto-linked bare URLs) `class="mz-rv-link"` with an
                // `href`. Tauri's webview doesn't honour
                // `target="_blank"` on anchor elements — they either
                // no-op or try to navigate the current view — so we
                // hijack the click and dispatch to the shell plugin,
                // which hands the URL to the user's default browser.
                containerRef
                    .querySelectorAll<HTMLAnchorElement>("a.mz-rv-link")
                    .forEach((el) => {
                        const href = el.getAttribute("href") ?? "";
                        if (!/^https?:\/\//i.test(href)) return;
                        el.addEventListener("click", async (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            try {
                                const shell = await import("@tauri-apps/plugin-shell");
                                await shell.open(href);
                            } catch (err) {
                                console.warn("[reading] failed to open external URL:", err);
                            }
                        });
                    });

                // Handle image interactions: context menu, wheel zoom, ctrl+click.
                //
                // `ordinal` disambiguates duplicate `src` references in
                // the same file — e.g. if the user embeds `logo.png`
                // three times, the first <img> has ordinal=0, the
                // second ordinal=1, etc. `persistImageSize` below
                // uses this to find the nth matching markdown image
                // and rewrite ONLY that occurrence.
                const ordinals = new Map<string, number>();
                containerRef
                    .querySelectorAll<HTMLImageElement>(".mz-rv-image")
                    .forEach((img) => {
                        const rawSrc = img.getAttribute("data-src") ?? "";
                        const ordinal = ordinals.get(rawSrc) ?? 0;
                        ordinals.set(rawSrc, ordinal + 1);

                        // Persist a new display size to the markdown
                        // source AND avoid triggering a re-render.
                        //
                        // Why we don't go through `vaultStore.saveFile`:
                        // `saveFile` calls `setActiveFile(...)` with
                        // a new FileContent object, which emits on
                        // the `resolvedFile` memo → fires this very
                        // `createEffect(on(resolvedFile, ...))` →
                        // rebuilds `containerRef.innerHTML` from
                        // scratch. The visible result is a hard
                        // flicker every time the user flicks the
                        // wheel, which is the exact bug we went
                        // through hell fixing for the search-click
                        // reveal in an earlier session.
                        //
                        // Instead we: (a) invoke the Rust `write_file`
                        // command directly so the disk has the new
                        // content, and (b) mutate the existing
                        // `activeFile.content` string IN PLACE so
                        // any consumer that later reads
                        // `vaultStore.activeFile()?.content` sees
                        // the new value. The in-place mutation
                        // does NOT trigger Solid reactivity —
                        // `activeFile` still holds the same object
                        // reference, so the memo doesn't re-emit,
                        // so the createEffect doesn't re-run.
                        //
                        // Consistency guarantees:
                        //  - Disk is always correct.
                        //  - In-memory `activeFile.content` is kept
                        //    in sync by the in-place mutation, so
                        //    switching to edit mode after a
                        //    wheel-zoom shows the same content.
                        //  - The DOM shows the new width instantly
                        //    because `attachWheelZoom` already
                        //    applied `img.style.width` before we
                        //    even get here (rAF batch).
                        const persistImageSize = (newWidth: number) => {
                            try {
                                const f = resolvedFile();
                                if (!f || f.path !== activeFile.path) return;
                                const src = rawSrc;
                                // Find the nth `![...](src)` match in
                                // the source where the src portion
                                // matches and the index == ordinal.
                                const escapedSrc = src.replace(
                                    /[.*+?^${}()|[\]\\]/g,
                                    "\\$&",
                                );
                                const regex = new RegExp(
                                    `!\\[([^\\]]*)\\]\\(${escapedSrc}\\)`,
                                    "g",
                                );
                                // Walk through every `![...](src)`
                                // match on this file and capture the
                                // one whose 0-based index equals the
                                // DOM ordinal of the clicked image.
                                // We can't just break on the first
                                // match because that would always
                                // rewrite the first image even when
                                // the user resized the second one.
                                let target: {
                                    index: number;
                                    length: number;
                                    alt: string;
                                } | null = null;
                                let iterMatch: RegExpExecArray | null;
                                let count = 0;
                                while ((iterMatch = regex.exec(f.content)) !== null) {
                                    if (count === ordinal) {
                                        target = {
                                            index: iterMatch.index,
                                            length: iterMatch[0].length,
                                            alt: iterMatch[1],
                                        };
                                        break;
                                    }
                                    count++;
                                }
                                if (!target) return;
                                const currentAlt = parseImageSize(target.alt).altText;
                                const newAlt = formatImageAlt(
                                    currentAlt,
                                    newWidth,
                                    null,
                                );
                                const newMd = `![${newAlt}](${src})`;
                                const mStart = target.index;
                                const mEnd = mStart + target.length;
                                if (f.content.slice(mStart, mEnd) === newMd) return;
                                const newContent =
                                    f.content.slice(0, mStart) +
                                    newMd +
                                    f.content.slice(mEnd);
                                // Persist to disk
                                void invoke("write_file", {
                                    relativePath: activeFile.path,
                                    content: newContent,
                                }).catch((err) => {
                                    console.warn(
                                        "[reading image-resize] write_file failed:",
                                        err,
                                    );
                                });
                                // Mutate in place — no reactive trigger.
                                (f as any).content = newContent;
                                img.setAttribute(
                                    "alt",
                                    currentAlt,
                                );
                            } catch (err) {
                                console.warn(
                                    "[reading image-resize] persist failed:",
                                    err,
                                );
                            }
                        };

                        img.addEventListener("contextmenu", (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            showImageContextMenu(
                                e,
                                rawSrc,
                                activeFile.path,
                                img,
                                persistImageSize,
                            );
                        });
                        attachWheelZoom(img, { onResize: persistImageSize });
                        attachCtrlClick(img, rawSrc, activeFile.path);
                    });

                rememberReadingViewport(activeFile.path);
                if (isPaneActive()) {
                    editorStore.updateStats(activeFile.content);
                }
                syncReadingListGuideMetrics();
                requestAnimationFrame(() => {
                    if (currentFilePath !== activeFile.path) return;
                    setReadingSurfaceVisibility(true);
                });
            },
        ),
    );

    // Apply zoom
    createEffect(() => {
        const zoom = editorStore.editorZoom();
        const baseFontSize = settingsStore.settings().font_size;
        if (containerRef) {
            containerRef.style.fontSize = `${(zoom / 100) * baseFontSize}px`;
            syncReadingListGuideMetrics();
        }
    });

    // When leaving Reading mode, stash the top-visible line so editing
    // mode can resume at the same place.
    onCleanup(() => {
        rememberReadingViewport();
        if ((window as any).__mindzj_markdown_view?.getMode?.() === "preview") {
            (window as any).__mindzj_markdown_view = null;
        }
    });

    return (
        <>
            {/* Outer wrapper: `position: relative` anchors the
                absolute-positioned find panel. The scroll container
                is INSIDE this wrapper rather than being the anchor
                itself — if the panel were absolute-positioned inside
                the scrolling element it would scroll away with the
                content (panel visually "pushed to the top" as the
                user scrolls down). With the wrapper holding position
                and the scroll container being a sibling of the panel
                at the same level, the panel stays fixed at the top-
                right of the wrapper regardless of scroll position,
                matching how live-preview / source mode's CM6 panel
                behaves. */}
            <div
                style={{
                    flex: "1",
                    display: "flex",
                    "flex-direction": "column",
                    "min-height": "0",
                    position: "relative",
                }}
            >
                <div
                    ref={scrollContainerRef}
                    // Ctrl+wheel text zoom — mirrors the Editor component's
                    // behaviour so the user can zoom rendered markdown the same
                    // way they zoom source/live-preview. Deltas are small (±2%)
                    // because the store throttles and accumulates via rAF.
                    onWheel={(e) => {
                        activatePane();
                        if (e.ctrlKey) {
                            e.preventDefault();
                            editorStore.zoomEditorText(e.deltaY > 0 ? -2 : 2);
                        }
                    }}
                    onContextMenu={(e) => {
                        activatePane();
                        const target = e.target as HTMLElement | null;
                        if (target?.closest(".mz-rv-image")) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            items: buildReadingContextMenu(),
                        });
                    }}
                    style={{
                        flex: "1",
                        overflow: "auto",
                        background: "var(--mz-bg-primary)",
                        "min-height": "0",
                        visibility: "hidden",
                    }}
                    onMouseDown={() => activatePane()}
                    onFocusIn={() => activatePane()}
                >
                    <div
                        ref={containerRef}
                        class="mz-reading-view"
                        style={{
                            padding: "10px 24px",
                            margin: "0 auto",
                            width: "100%",
                            color: "var(--mz-text-primary)",
                            "box-sizing": "border-box",
                        }}
                    />
                </div>
                <Show when={findPanelOpen()}>
                    <ReadingFindPanel
                        container={containerRef ?? null}
                        scrollContainer={scrollContainerRef ?? null}
                        onClose={() => setFindPanelOpen(false)}
                    />
                </Show>
            </div>
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
        </>
    );
};
