/**
 * VS Code-style custom search panel for CodeMirror 6.
 *
 * Replaces CM6's default `.cm-search` form with a DOM that mirrors
 * the VS Code find widget:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ ▼  [ Find          ] [Aa] [ab] [.*]  No results ↑ ↓ ≡ ×      │
 *   │    [ Replace       ] [AB]                      ⟳ ⟳⋆          │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * The ▼ chevron at the far left toggles the Replace row between
 * collapsed (find only, single-row widget) and expanded (find +
 * replace, two-row widget) — matching the same affordance in VS
 * Code's find panel.
 *
 * Wiring notes:
 *
 *   - Panel DOM is built with `document.createElement`. CM6's Panel
 *     API expects plain DOM, not a SolidJS tree.
 *   - Every state change (query text, toggle flip, replace value)
 *     dispatches `setSearchQuery.of(new SearchQuery(...))` so CM6's
 *     built-in match decorator keeps rendering `.cm-searchMatch` /
 *     `.cm-searchMatch-selected` spans in the document.
 *   - Prev/Next/Replace/ReplaceAll buttons call the corresponding
 *     CM6 commands (`findPrevious`, `findNext`, `replaceNext`,
 *     `replaceAll`).
 *   - The ≡ "find in selection" button maps to `selectMatches` —
 *     selects every match in the document so the user can multi-
 *     cursor edit them. CM6 doesn't expose a true scoped-to-current-
 *     selection search, so this is the nearest native behavior.
 *   - Match counter text is recomputed on every `update()` that
 *     changes the doc, selection, or search query. The logic is
 *     shared with `searchCounter.ts`.
 *   - Enter / Shift-Enter / Escape inside either input trigger
 *     findNext / findPrevious / closeSearchPanel so the keyboard
 *     flow matches VS Code.
 */

import {
    closeSearchPanel,
    findNext,
    findPrevious,
    getSearchQuery,
    replaceAll,
    replaceNext,
    SearchQuery,
    selectMatches,
    setSearchQuery,
} from "@codemirror/search";
import { EditorView, Panel, ViewUpdate } from "@codemirror/view";

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function makeIconButton(
    icon: string,
    title: string,
    extraClass?: string,
): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `mz-search-iconbtn${extraClass ? ` ${extraClass}` : ""}`;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = icon;
    return btn;
}

interface Toggle {
    el: HTMLLabelElement;
    input: HTMLInputElement;
    isActive: () => boolean;
    setActive: (v: boolean) => void;
}

function makeToggle(label: string, title: string): Toggle {
    const wrapper = document.createElement("label");
    wrapper.className = "mz-search-toggle";
    wrapper.title = title;
    wrapper.setAttribute("aria-label", title);

    const input = document.createElement("input");
    input.type = "checkbox";

    const text = document.createElement("span");
    text.textContent = label;

    wrapper.appendChild(input);
    wrapper.appendChild(text);

    // Toggle state flip is driven by the checkbox so browser and
    // screen-reader semantics stay correct. CSS keys off
    // `:has(input:checked)` to paint the active state.
    return {
        el: wrapper,
        input,
        isActive: () => input.checked,
        setActive: (v: boolean) => {
            input.checked = v;
        },
    };
}

// ---------------------------------------------------------------------------
// Match counter (same logic as searchCounter.ts, adapted to return text)
// ---------------------------------------------------------------------------

function getMatchProgress(view: EditorView): string {
    const query = getSearchQuery(view.state);
    if (!query.search || !query.valid) return "";

    const selection = view.state.selection.main;
    const cursor = query.getCursor(view.state);
    let total = 0;
    let current = 0;
    let nextAfterSelection = 0;

    while (true) {
        const next = cursor.next();
        if (next.done) break;
        total += 1;
        const match = next.value;
        if (selection.from === match.from && selection.to === match.to) {
            current = total;
        } else if (
            current === 0 &&
            selection.from <= match.to &&
            selection.to >= match.from
        ) {
            current = total;
        } else if (nextAfterSelection === 0 && match.from >= selection.from) {
            nextAfterSelection = total;
        }
    }

    if (total === 0) return "No results";
    return `${current || nextAfterSelection || 1} of ${total}`;
}

// ---------------------------------------------------------------------------
// SVG icons — kept inline so the panel has no external asset deps
// ---------------------------------------------------------------------------

const ICON_CHEVRON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 6 8 10 12 6"/></svg>`;
const ICON_ARROW_UP = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3"/><polyline points="4 7 8 3 12 7"/></svg>`;
const ICON_ARROW_DOWN = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10"/><polyline points="4 9 8 13 12 9"/></svg>`;
const ICON_SELECTION = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M3 8h10M3 12h6"/></svg>`;
const ICON_CLOSE = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
const ICON_REPLACE = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h6v3M6 6L3 3l3-3" transform="translate(0 1)"/><rect x="7" y="9" width="6" height="4" rx="0.5"/></svg>`;
const ICON_REPLACE_ALL = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h5v2.5M5.5 5.5L3 3l2.5-2.5" transform="translate(0 1)"/><rect x="7" y="5" width="6" height="3" rx="0.5"/><rect x="7" y="10" width="6" height="3" rx="0.5"/></svg>`;

// ---------------------------------------------------------------------------
// Panel factory
// ---------------------------------------------------------------------------

export function createVSCodeSearchPanel(view: EditorView): Panel {
    const dom = document.createElement("div");
    dom.className = "cm-search mz-search-panel";
    dom.setAttribute("role", "search");

    // ── Find row ──
    const findRow = document.createElement("div");
    findRow.className = "mz-search-row";

    const chevron = makeIconButton(
        ICON_CHEVRON,
        "Toggle Replace",
        "mz-search-chevron",
    );

    const findInput = document.createElement("input");
    findInput.type = "text";
    findInput.name = "search";
    findInput.placeholder = "Find";
    findInput.className = "mz-search-input";
    findInput.setAttribute("autocomplete", "off");
    findInput.setAttribute("spellcheck", "false");
    findInput.setAttribute("aria-label", "Find");

    const caseToggle = makeToggle("Aa", "Match Case");
    const wordToggle = makeToggle("ab", "Match Whole Word");
    const regexToggle = makeToggle(".*", "Use Regular Expression");

    const counter = document.createElement("span");
    counter.className = "mz-search-count";

    const prevBtn = makeIconButton(ICON_ARROW_UP, "Previous Match (Shift+Enter)");
    const nextBtn = makeIconButton(ICON_ARROW_DOWN, "Next Match (Enter)");
    const selectAllBtn = makeIconButton(
        ICON_SELECTION,
        "Find in Selection (select all matches)",
    );
    const closeBtn = makeIconButton(ICON_CLOSE, "Close (Escape)");

    findRow.appendChild(chevron);
    findRow.appendChild(findInput);
    findRow.appendChild(caseToggle.el);
    findRow.appendChild(wordToggle.el);
    findRow.appendChild(regexToggle.el);
    findRow.appendChild(counter);
    findRow.appendChild(prevBtn);
    findRow.appendChild(nextBtn);
    findRow.appendChild(selectAllBtn);
    findRow.appendChild(closeBtn);

    // ── Replace row (collapsed by default) ──
    const replaceRow = document.createElement("div");
    replaceRow.className = "mz-search-row mz-search-replace-row";

    // Empty spacer so the replace input lines up under the find
    // input (the chevron column on the find row takes one width
    // unit; we reserve the same width here).
    const replaceSpacer = document.createElement("div");
    replaceSpacer.className = "mz-search-chevron-spacer";

    const replaceInput = document.createElement("input");
    replaceInput.type = "text";
    replaceInput.name = "replace";
    replaceInput.placeholder = "Replace";
    replaceInput.className = "mz-search-input";
    replaceInput.setAttribute("autocomplete", "off");
    replaceInput.setAttribute("spellcheck", "false");
    replaceInput.setAttribute("aria-label", "Replace");

    const preserveCaseToggle = makeToggle("AB", "Preserve Case");

    const replaceBtn = makeIconButton(ICON_REPLACE, "Replace (Enter)");
    const replaceAllBtn = makeIconButton(
        ICON_REPLACE_ALL,
        "Replace All (Shift+Enter)",
    );

    replaceRow.appendChild(replaceSpacer);
    replaceRow.appendChild(replaceInput);
    replaceRow.appendChild(preserveCaseToggle.el);
    replaceRow.appendChild(replaceBtn);
    replaceRow.appendChild(replaceAllBtn);

    dom.appendChild(findRow);
    dom.appendChild(replaceRow);

    // `expanded` reflects whether the replace row is visible. The
    // class flips both the chevron rotation (via CSS) and the panel
    // height (via the replace row's display).
    let expanded = false;
    function setExpanded(next: boolean) {
        expanded = next;
        dom.classList.toggle("mz-search-panel-expanded", expanded);
    }
    setExpanded(false);

    chevron.addEventListener("click", () => {
        setExpanded(!expanded);
        if (expanded) {
            // Expanding from a find-only search is a strong hint the
            // user wants to replace — focus the replace input so
            // they can start typing immediately.
            queueMicrotask(() => replaceInput.focus());
        }
    });

    // ── Commit query changes to the CM6 search state ──
    function commit() {
        view.dispatch({
            effects: setSearchQuery.of(
                new SearchQuery({
                    search: findInput.value,
                    caseSensitive: caseToggle.isActive(),
                    wholeWord: wordToggle.isActive(),
                    regexp: regexToggle.isActive(),
                    replace: replaceInput.value,
                }),
            ),
        });
        scheduleCounterUpdate();
    }

    findInput.addEventListener("input", commit);
    replaceInput.addEventListener("input", commit);
    caseToggle.input.addEventListener("change", commit);
    wordToggle.input.addEventListener("change", commit);
    regexToggle.input.addEventListener("change", commit);

    // ── Keyboard handling on the inputs ──
    findInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) findPrevious(view);
            else findNext(view);
        } else if (e.key === "Escape") {
            e.preventDefault();
            closePanelAndFocus();
        }
    });

    replaceInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) doReplaceAll();
            else doReplaceNext();
        } else if (e.key === "Escape") {
            e.preventDefault();
            closePanelAndFocus();
        }
    });

    // ── Button handlers ──
    prevBtn.addEventListener("click", () => {
        findPrevious(view);
        findInput.focus();
    });

    nextBtn.addEventListener("click", () => {
        findNext(view);
        findInput.focus();
    });

    selectAllBtn.addEventListener("click", () => {
        selectMatches(view);
        view.focus();
    });

    closeBtn.addEventListener("click", () => {
        closePanelAndFocus();
    });

    // Replace: if preserve-case is on, compute a case-preserved
    // variant of the replace value per-match. CM6's `replaceNext`
    // takes the configured `replace` text verbatim, so we do a
    // one-shot SearchQuery reconfig RIGHT before calling it — swap
    // in the adapted replacement, fire the command, then restore
    // the user-typed value.
    function doReplaceNext() {
        if (preserveCaseToggle.isActive()) {
            withPreservedCaseReplace(view, findInput.value, replaceInput.value, () =>
                replaceNext(view),
            );
        } else {
            replaceNext(view);
        }
    }

    function doReplaceAll() {
        if (preserveCaseToggle.isActive()) {
            withPreservedCaseReplace(view, findInput.value, replaceInput.value, () =>
                replaceAll(view),
            );
        } else {
            replaceAll(view);
        }
    }

    replaceBtn.addEventListener("click", () => {
        doReplaceNext();
        findInput.focus();
    });

    replaceAllBtn.addEventListener("click", () => {
        doReplaceAll();
        findInput.focus();
    });

    // Close + counter helpers.
    function clearQueryForClose() {
        const current = getSearchQuery(view.state);
        view.dispatch({
            effects: setSearchQuery.of(
                new SearchQuery({
                    search: "",
                    caseSensitive: current.caseSensitive,
                    wholeWord: current.wholeWord,
                    regexp: current.regexp,
                    replace: "",
                }),
            ),
        });
    }

    function closePanelAndFocus() {
        clearQueryForClose();
        closeSearchPanel(view);
        view.focus();
    }

    // Counter updates are deferred so the panel can paint first.
    let counterRaf: number | null = null;
    let counterTimer: number | null = null;

    function cancelCounterUpdate() {
        if (counterRaf !== null) {
            window.cancelAnimationFrame(counterRaf);
            counterRaf = null;
        }
        if (counterTimer !== null) {
            window.clearTimeout(counterTimer);
            counterTimer = null;
        }
    }

    function scheduleCounterUpdate() {
        const query = getSearchQuery(view.state);
        if (!query.search || !query.valid) {
            cancelCounterUpdate();
            counter.textContent = "";
            return;
        }

        cancelCounterUpdate();
        counterRaf = window.requestAnimationFrame(() => {
            counterRaf = null;
            counterTimer = window.setTimeout(() => {
                counterTimer = null;
                counter.textContent = getMatchProgress(view);
            }, 0);
        });
    }

    return {
        dom,
        top: true,
        mount() {
            // Re-hydrate from existing search state (if the panel was
            // closed-and-reopened, CM6 keeps the last query around).
            const q = getSearchQuery(view.state);
            if (q) {
                if (q.search) findInput.value = q.search;
                caseToggle.setActive(q.caseSensitive);
                wordToggle.setActive(q.wholeWord);
                regexToggle.setActive(q.regexp);
                if (q.replace) replaceInput.value = q.replace;
            }
            scheduleCounterUpdate();
            queueMicrotask(() => {
                findInput.focus();
                findInput.select();
            });
        },
        update(u: ViewUpdate) {
            if (
                u.docChanged ||
                u.selectionSet ||
                u.transactions.some((tr) =>
                    tr.effects.some((ef) => ef.is(setSearchQuery)),
                )
            ) {
                scheduleCounterUpdate();
            }
        },
        destroy() {
            cancelCounterUpdate();
        },
    };
}

// ---------------------------------------------------------------------------
// Preserve-case replace adapter
//
// CM6 doesn't support VS Code's "preserve case" replace natively.
// We fake it by temporarily swapping the replace string on the
// current SearchQuery before calling `replaceNext` / `replaceAll`,
// then restoring the user-typed value.
//
// Limitations: `replaceAll` replaces every match with the SAME
// string, so we can only preserve case for the FIRST-match pattern
// when using Replace All. For single Replace, we inspect the current
// selection and adapt per-match. This matches VS Code's rough
// approximation — not perfect, but covers the common cases of
// UPPERCASE → UPPERCASE, Capitalized → Capitalized, lowercase →
// lowercase.
// ---------------------------------------------------------------------------

function detectCasePattern(s: string): "upper" | "lower" | "capitalized" | "mixed" {
    if (!s) return "mixed";
    if (s === s.toUpperCase() && s !== s.toLowerCase()) return "upper";
    if (s === s.toLowerCase() && s !== s.toUpperCase()) return "lower";
    if (
        s[0] === s[0].toUpperCase() &&
        s.slice(1) === s.slice(1).toLowerCase()
    ) {
        return "capitalized";
    }
    return "mixed";
}

function applyCasePattern(
    replacement: string,
    pattern: "upper" | "lower" | "capitalized" | "mixed",
): string {
    switch (pattern) {
        case "upper":
            return replacement.toUpperCase();
        case "lower":
            return replacement.toLowerCase();
        case "capitalized":
            return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
        default:
            return replacement;
    }
}

function withPreservedCaseReplace(
    view: EditorView,
    searchText: string,
    replaceText: string,
    run: () => void,
) {
    // Derive the adapted replacement from the currently selected
    // match — if nothing's selected yet, fall back to the user's
    // literal replace string.
    const selection = view.state.selection.main;
    const matchText = view.state.doc.sliceString(selection.from, selection.to);
    const adapted = matchText
        ? applyCasePattern(replaceText, detectCasePattern(matchText))
        : replaceText;

    const current = getSearchQuery(view.state);
    view.dispatch({
        effects: setSearchQuery.of(
            new SearchQuery({
                search: current.search,
                caseSensitive: current.caseSensitive,
                wholeWord: current.wholeWord,
                regexp: current.regexp,
                replace: adapted,
            }),
        ),
    });
    run();
    // Restore the user-typed replace string so the panel's input
    // value and the query stay in sync for the next operation.
    view.dispatch({
        effects: setSearchQuery.of(
            new SearchQuery({
                search: current.search,
                caseSensitive: current.caseSensitive,
                wholeWord: current.wholeWord,
                regexp: current.regexp,
                replace: replaceText,
            }),
        ),
    });
    // Silence the unused-param warning — retained as a defensive
    // second-argument so the function's signature reads clearly at
    // the call site.
    void searchText;
}
