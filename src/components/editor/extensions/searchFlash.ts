/**
 * Search-result flash highlight.
 *
 * A CodeMirror StateField that holds a (possibly empty) set of
 * decorations used to temporarily highlight a range of text. Used
 * by the global search panel: when the user clicks a search hit,
 * the panel dispatches a `search-reveal` editor command which
 * scrolls the view and fires `addSearchFlash` to mark the matched
 * text. A `setTimeout` in the command handler fires `clearSearchFlash`
 * ~1.5 seconds later to remove the decoration.
 *
 * The decoration uses the `.mz-search-flash` class (see
 * `src/styles/editor.css`) which paints a yellow-ish background
 * and runs a brief fade-in keyframe so the flash is visually
 * distinct from a steady selection.
 */

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

/** Fired to start highlighting a range. Payload is the text range. */
export const addSearchFlash = StateEffect.define<{ from: number; to: number }>();

/** Fired to clear any active flash highlight. Payload is ignored. */
export const clearSearchFlash = StateEffect.define<null>();

const flashDeco = Decoration.mark({ class: "mz-search-flash" });

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
                    decos = Decoration.set([flashDeco.range(safeFrom, safeTo)]);
                } else {
                    decos = Decoration.none;
                }
            } else if (effect.is(clearSearchFlash)) {
                decos = Decoration.none;
            }
        }
        return decos;
    },
    provide: (f) => EditorView.decorations.from(f),
});
