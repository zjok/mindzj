/**
 * Search-result / outline flash highlight.
 *
 * A CodeMirror StateField that holds a (possibly empty) set of
 * decorations used to temporarily highlight text. Two shapes, each
 * with its own CSS class so the two use cases can diverge visually:
 *
 *   1. `addSearchFlash({from, to})` — a MARK decoration over the
 *      matched text range, class `mz-search-flash`. Fired by the
 *      global search panel when the user clicks a hit. Amber/green
 *      to stand out against any background.
 *
 *   2. `addLineFlash(from)` — a LINE decoration on the line that
 *      contains `from`, class `mz-outline-flash`. Fired when the
 *      user clicks a heading in the Outline panel; CM6 paints the
 *      row-wide `.cm-line` background in the theme accent colour
 *      at 20% opacity so the whole heading row flashes.
 *
 * A `setTimeout` in the command handler fires `clearSearchFlash`
 * ~1 second later to remove whichever decoration is active.
 */

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

/** Fired to start highlighting a range (mark decoration). */
export const addSearchFlash = StateEffect.define<{ from: number; to: number }>();

/**
 * Fired to start highlighting a full line (line decoration). Payload
 * is any offset inside the target line — the field resolves it to
 * the containing line's `from` on the current document.
 */
export const addLineFlash = StateEffect.define<number>();

/** Fired to clear any active flash highlight. Payload is ignored. */
export const clearSearchFlash = StateEffect.define<null>();

const flashMarkDeco = Decoration.mark({ class: "mz-search-flash" });
const flashLineDeco = Decoration.line({ class: "mz-outline-flash" });

export const searchFlashField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decos, tr) {
        // Map existing decorations through document changes so they
        // stay attached to the right characters if the user edits
        // before the flash timer fires.
        decos = decos.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(addSearchFlash)) {
                const { from, to } = effect.value;
                // Clamp to a valid range — the StateField can be
                // called with stale positions if the document was
                // modified between dispatch and effect application.
                const safeFrom = Math.max(0, Math.min(from, tr.state.doc.length));
                const safeTo = Math.max(safeFrom, Math.min(to, tr.state.doc.length));
                if (safeTo > safeFrom) {
                    decos = Decoration.set([flashMarkDeco.range(safeFrom, safeTo)]);
                } else {
                    decos = Decoration.none;
                }
            } else if (effect.is(addLineFlash)) {
                const pos = effect.value;
                const safePos = Math.max(0, Math.min(pos, tr.state.doc.length));
                const line = tr.state.doc.lineAt(safePos);
                // Line decorations MUST be attached at the line's
                // start offset; `Decoration.line` throws otherwise.
                decos = Decoration.set([flashLineDeco.range(line.from)]);
            } else if (effect.is(clearSearchFlash)) {
                decos = Decoration.none;
            }
        }
        return decos;
    },
    provide: (f) => EditorView.decorations.from(f),
});
