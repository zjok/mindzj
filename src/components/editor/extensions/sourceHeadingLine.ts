/**
 * Source-mode Heading Line Decoration Extension
 *
 * In source mode the markdown language applies `.cm-header-N` classes to
 * inline <span> elements covering the heading text. If the CSS gives those
 * spans a larger font-size, the visible line becomes taller than the
 * `.cm-line` wrapper's computed line-height — and CodeMirror's height map
 * (which measures the line wrapper, not inline children) ends up out of
 * sync with the actual rendered layout. The symptom the user reported:
 * arrow-up/down jumps multiple lines on headings, and clicks don't land
 * on the expected character.
 *
 * This extension fixes that by adding a line-level decoration (class
 * `mz-src-h1` … `mz-src-h6`) to every heading line in source mode. The
 * CSS in `editor.css` targets these line classes instead of the inline
 * `.cm-header-*` spans, so the font-size is applied to the whole
 * `.cm-line` element. CodeMirror measures the line as a single unit and
 * its height map stays accurate.
 */

import { StateField, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import type { Range } from "@codemirror/state";

const headingDeco: Record<number, Decoration> = {
    1: Decoration.line({ class: "mz-src-h1" }),
    2: Decoration.line({ class: "mz-src-h2" }),
    3: Decoration.line({ class: "mz-src-h3" }),
    4: Decoration.line({ class: "mz-src-h4" }),
    5: Decoration.line({ class: "mz-src-h5" }),
    6: Decoration.line({ class: "mz-src-h6" }),
};

const HEADING_RE = /^(#{1,6})\s+\S/;

function buildSourceHeadingDecorations(
    state: import("@codemirror/state").EditorState,
): DecorationSet {
    const doc = state.doc;
    const decos: Range<Decoration>[] = [];
    let inFence = false;

    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const text = line.text;

        // Skip fenced code blocks — `### foo` inside a code block is not
        // a heading.
        const fenceMatch = text.match(/^(`{3,}|~{3,})/);
        if (fenceMatch) {
            if (!inFence) {
                inFence = true;
            } else if (text.startsWith(fenceMatch[1][0].repeat(3))) {
                inFence = false;
            }
            continue;
        }
        if (inFence) continue;

        const match = text.match(HEADING_RE);
        if (!match) continue;

        const level = match[1].length;
        const deco = headingDeco[level];
        if (deco) {
            decos.push(deco.range(line.from));
        }
    }

    return Decoration.set(decos);
}

const sourceHeadingLineField = StateField.define<DecorationSet>({
    create(state) {
        return buildSourceHeadingDecorations(state);
    },
    update(deco, tr: Transaction) {
        if (tr.docChanged) {
            return buildSourceHeadingDecorations(tr.state);
        }
        return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
});

/**
 * Extension that tags every heading line with `mz-src-h1` … `mz-src-h6`
 * so heading styling in source mode can live on the line wrapper and
 * keep CodeMirror's height map accurate.
 */
export function sourceHeadingLineExtension() {
    return sourceHeadingLineField;
}
