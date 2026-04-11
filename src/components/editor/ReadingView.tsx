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
import katex from "katex";
import { resolveImageAssetUrl } from "../../utils/vaultPaths";
import { openFileRouted } from "../../utils/openFileRouted";
import { showImageContextMenu } from "./extensions/livePreview";
import { LIST_INDENT_EXTRA_PX, LIST_RENDER_TAB_SIZE } from "./extensions/listUtils";
import { attachWheelZoom, attachCtrlClick } from "../../utils/imageInteraction";
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
    const taskMatch = line.match(/^(\s*)- \[([ xX])\]\s(.+)$/);
    if (taskMatch) {
        return {
            kind: "task",
            level: measureListIndent(taskMatch[1] ?? ""),
            line: lineNumber,
            content: taskMatch[3],
            checked: taskMatch[2] !== " ",
        };
    }

    const unorderedMatch = line.match(/^(\s*)([-*+])\s(.+)$/);
    if (unorderedMatch) {
        return {
            kind: "ul",
            level: measureListIndent(unorderedMatch[1] ?? ""),
            line: lineNumber,
            content: unorderedMatch[3],
        };
    }

    const orderedMatch = line.match(/^(\s*)(\d+)\.\s(.+)$/);
    if (orderedMatch) {
        return {
            kind: "ol",
            level: measureListIndent(orderedMatch[1] ?? ""),
            line: lineNumber,
            content: orderedMatch[3],
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
    return `<li data-line="${token.line}">${content}`;
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

    // Images: ![alt](src)
    result = result.replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        (_, alt, src) => {
            const rawSrc = unescapeHtml(src);
            const resolvedSrc = resolveImageSrc(
                rawSrc,
                ctx.vaultRoot,
                ctx.currentFilePath,
            );
            const escapedAlt = escapeAttr(alt);
            return `<span class="image-embed internal-embed is-loaded"><img src="${resolvedSrc}" data-src="${escapeAttr(rawSrc)}" alt="${escapedAlt}" class="mz-rv-image" loading="lazy" /></span>`;
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
                // Find the heading element matching the target line number
                const headings = containerRef.querySelectorAll<HTMLElement>("[data-line]");
                let target: HTMLElement | null = null;
                for (const h of headings) {
                    const hLine = parseInt(h.getAttribute("data-line") || "-1");
                    if (hLine === targetLine) {
                        target = h;
                        break;
                    }
                }
                if (target) {
                    // Instant scroll (no smooth animation) — user wants
                    // outline clicks to jump straight to the target.
                    const containerTop = scrollContainerRef.getBoundingClientRect().top;
                    const targetTop = target.getBoundingClientRect().top;
                    const offset = targetTop - containerTop + scrollContainerRef.scrollTop;
                    scrollContainerRef.scrollTop = offset;
                }
            }
        };
        document.addEventListener("mindzj:editor-command", handler);
        onCleanup(() => {
            document.removeEventListener("mindzj:editor-command", handler);
            document.removeEventListener(
                "mindzj:remember-active-viewport",
                handleRememberViewport,
            );
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

                // Handle image interactions: context menu, wheel zoom, ctrl+click
                containerRef
                    .querySelectorAll<HTMLImageElement>(".mz-rv-image")
                    .forEach((img) => {
                        const rawSrc = img.getAttribute("data-src") ?? "";
                        img.addEventListener("contextmenu", (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            showImageContextMenu(e, rawSrc, activeFile.path, img);
                        });
                        attachWheelZoom(img);
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
