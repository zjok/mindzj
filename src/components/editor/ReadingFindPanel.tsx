/**
 * Find-in-file panel for reading mode.
 *
 * Reading mode doesn't have a CodeMirror instance, so the CM6 search
 * panel that lives at the top of the editor isn't available. This
 * component provides the same VS Code-style floating widget — tight
 * row with query input, Aa / W / .* toggles, match counter, prev/next
 * arrows, close — wired to walk the reading view's DOM instead.
 *
 * Highlighting strategy: find matching text nodes, wrap each hit in a
 * `<mark class="mz-reading-find-match">` (and add `…-current` on the
 * currently focused hit). We restore the DOM on close by replacing
 * every mark with its text content in place — CodeMirror's search
 * extension manages its own decoration set so the two never touch.
 *
 * Known limitation: matches that span multiple text nodes (e.g. a run
 * of text interrupted by a `<strong>` wrap) can't be highlighted as a
 * single span. In practice this rarely matters for the kinds of notes
 * MindZJ targets; the panel degrades to per-node matches so at least
 * something highlights. Matching across nodes would require reflowing
 * the DOM, which would invalidate reactivity and break checkboxes in
 * task lists.
 */

import {
    Component,
    createEffect,
    createSignal,
    onCleanup,
    onMount,
    Show,
} from "solid-js";
import {
    findQuery,
    setFindQuery,
    findCaseSensitive,
    setFindCaseSensitive,
    findWholeWord,
    setFindWholeWord,
    findRegex,
    setFindRegex,
} from "../../stores/findState";

interface Props {
    /**
     * The element whose text content should be searched. Usually the
     * `.mz-reading-view` container emitted by ReadingView.
     */
    container: HTMLElement | null;
    /**
     * The scrollable ancestor of `container`. Used to scroll the
     * currently focused match into view without jumping the page.
     */
    scrollContainer: HTMLElement | null;
    /**
     * Fired when the user presses Escape or clicks the close button.
     * ReadingView should flip its `findPanelOpen` signal off.
     */
    onClose: () => void;
}

interface MatchInfo {
    mark: HTMLElement;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Walk every text node inside `root`, splitting runs that contain one
 * or more matches of `regex` and wrapping each match in a fresh
 * `<mark class="mz-reading-find-match">`. Returns the newly-created
 * marks in document order.
 *
 * Skips nodes inside existing marks (search results, search-reveal
 * flashes) so we don't nest marks — Firefox stops painting outlines
 * when marks are siblings but also chokes on deeply nested ones.
 */
function wrapMatches(
    root: HTMLElement,
    regex: RegExp,
): HTMLElement[] {
    if (!regex.source) return [];

    const marks: HTMLElement[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node: Node): number {
            // Reject text inside existing marks (prevents nesting),
            // inside <script>/<style>, and inside the find panel
            // itself (otherwise typing in the input would match
            // itself — an infinite loop).
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest(".mz-reading-find-panel")) {
                return NodeFilter.FILTER_REJECT;
            }
            if (parent.closest(".mz-reading-find-match")) {
                return NodeFilter.FILTER_REJECT;
            }
            const tag = parent.tagName;
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
                return NodeFilter.FILTER_REJECT;
            }
            if (!node.nodeValue || !node.nodeValue.trim()) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const nodesToProcess: Text[] = [];
    let current = walker.nextNode();
    while (current) {
        nodesToProcess.push(current as Text);
        current = walker.nextNode();
    }

    for (const textNode of nodesToProcess) {
        const text = textNode.nodeValue ?? "";
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        let lastIdx = 0;
        const fragments: (Text | HTMLElement)[] = [];
        // eslint-disable-next-line no-cond-assign
        while ((match = regex.exec(text)) !== null) {
            if (match[0].length === 0) {
                // Guard against a zero-width match (empty alternation
                // in a regex query) — infinite-loop the cursor by one.
                regex.lastIndex = match.index + 1;
                continue;
            }
            if (match.index > lastIdx) {
                fragments.push(
                    document.createTextNode(text.slice(lastIdx, match.index)),
                );
            }
            const mark = document.createElement("mark");
            mark.className = "mz-reading-find-match";
            mark.textContent = match[0];
            fragments.push(mark);
            marks.push(mark);
            lastIdx = match.index + match[0].length;
        }
        if (fragments.length === 0) continue;
        if (lastIdx < text.length) {
            fragments.push(document.createTextNode(text.slice(lastIdx)));
        }
        const parent = textNode.parentNode;
        if (!parent) continue;
        for (const fragment of fragments) {
            parent.insertBefore(fragment, textNode);
        }
        parent.removeChild(textNode);
    }

    return marks;
}

/**
 * Undo `wrapMatches` — replace every `.mz-reading-find-match` inside
 * `root` with its text content and normalize the result so adjacent
 * text nodes fuse back. Running this on close keeps the DOM shape
 * identical to what ReadingView originally rendered (critical for
 * stable scroll positions between open/close cycles).
 */
function unwrapMatches(root: HTMLElement) {
    const marks = root.querySelectorAll<HTMLElement>(".mz-reading-find-match");
    for (const mark of marks) {
        const text = document.createTextNode(mark.textContent ?? "");
        mark.parentNode?.replaceChild(text, mark);
    }
    root.normalize();
}

export const ReadingFindPanel: Component<Props> = (props) => {
    // Query + option toggles live in the cross-mode shared store
    // (findState.ts) so switching between Editor and ReadingView via
    // Ctrl+E preserves the search. Re-aliased here for readability.
    const query = findQuery;
    const setQuery = setFindQuery;
    const caseSensitive = findCaseSensitive;
    const setCaseSensitive = setFindCaseSensitive;
    const wholeWord = findWholeWord;
    const setWholeWord = setFindWholeWord;
    const useRegex = findRegex;
    const setUseRegex = setFindRegex;
    const [matches, setMatches] = createSignal<MatchInfo[]>([]);
    const [currentIdx, setCurrentIdx] = createSignal(0);
    const [regexError, setRegexError] = createSignal<string | null>(null);

    let inputRef: HTMLInputElement | undefined;

    function buildRegex(): RegExp | null {
        const q = query();
        if (!q) return null;
        let source: string;
        if (useRegex()) {
            source = q;
        } else {
            source = escapeRegExp(q);
        }
        if (wholeWord()) {
            source = `\\b${source}\\b`;
        }
        const flags = caseSensitive() ? "g" : "gi";
        try {
            const regex = new RegExp(source, flags);
            setRegexError(null);
            return regex;
        } catch (e) {
            setRegexError(e instanceof Error ? e.message : "Invalid pattern");
            return null;
        }
    }

    /**
     * Re-run the search from scratch. Called on every input/option
     * change. We always tear down the previous marks and rebuild from
     * the DOM — partial diffs are hard to keep in sync with external
     * DOM mutations (e.g. task-list checkbox toggles), and the reading
     * view rarely has enough text for a full rescan to be slow.
     */
    function refreshMatches(preserveIndex = false) {
        if (!props.container) {
            setMatches([]);
            setCurrentIdx(0);
            return;
        }
        unwrapMatches(props.container);
        const regex = buildRegex();
        if (!regex) {
            setMatches([]);
            setCurrentIdx(0);
            return;
        }
        const marks = wrapMatches(props.container, regex);
        const infos: MatchInfo[] = marks.map((mark) => ({ mark }));
        setMatches(infos);
        let nextIdx = 0;
        if (preserveIndex) {
            nextIdx = Math.min(currentIdx(), Math.max(0, infos.length - 1));
        }
        setCurrentIdx(nextIdx);
        if (infos.length > 0) {
            focusMatch(nextIdx);
        }
    }

    function focusMatch(idx: number) {
        const list = matches();
        if (list.length === 0) return;
        const clamped = ((idx % list.length) + list.length) % list.length;
        for (let i = 0; i < list.length; i++) {
            list[i].mark.classList.toggle(
                "mz-reading-find-match-current",
                i === clamped,
            );
        }
        const mark = list[clamped].mark;
        const scrollAncestor = props.scrollContainer;
        if (scrollAncestor) {
            // Center the match vertically in the scroll ancestor,
            // similar to VS Code's "reveal" behaviour. Plain
            // scrollIntoView would anchor to the nearest scrollable
            // root which for us is usually the window, not the pane.
            const markRect = mark.getBoundingClientRect();
            const containerRect = scrollAncestor.getBoundingClientRect();
            const offset =
                markRect.top -
                containerRect.top +
                scrollAncestor.scrollTop -
                scrollAncestor.clientHeight / 2 +
                markRect.height / 2;
            scrollAncestor.scrollTop = offset;
        } else {
            mark.scrollIntoView({ block: "center" });
        }
        setCurrentIdx(clamped);
    }

    function nextMatch() {
        if (matches().length === 0) return;
        focusMatch(currentIdx() + 1);
    }

    function prevMatch() {
        if (matches().length === 0) return;
        focusMatch(currentIdx() - 1);
    }

    function close() {
        if (props.container) {
            unwrapMatches(props.container);
        }
        props.onClose();
    }

    function handleInputKeyDown(e: KeyboardEvent) {
        if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) prevMatch();
            else nextMatch();
        } else if (e.key === "Escape") {
            e.preventDefault();
            close();
        }
    }

    // Re-run search whenever any input / option changes.
    createEffect(() => {
        query();
        caseSensitive();
        wholeWord();
        useRegex();
        refreshMatches();
    });

    onMount(() => {
        // Focus + pre-select any pre-existing query so Ctrl+F →
        // immediately typing replaces the last query (VS Code
        // behaviour) rather than appending.
        queueMicrotask(() => {
            inputRef?.focus();
            inputRef?.select();
        });

        // External set-query event: fired by App.tsx's Ctrl+F handler
        // when the panel is already open and the user has selected
        // text in the reading view. Replaces the current query with
        // the selection and refocuses so subsequent typing edits it.
        // With no selection we only refocus — blanking the existing
        // query just because the user pressed Ctrl+F would be an
        // unpleasant surprise.
        const handleSetQuery = (event: Event) => {
            const detail = (event as CustomEvent<{ query?: string }>).detail;
            const next = detail?.query;
            if (typeof next === "string" && next.length > 0) {
                setQuery(next);
            }
            queueMicrotask(() => {
                if (inputRef) {
                    inputRef.focus();
                    inputRef.select();
                }
            });
        };
        document.addEventListener("mindzj:reading-find-set-query", handleSetQuery);

        // Content-refresh event: fired by ReadingView after it swaps
        // the rendered markdown (file open, mode switch, tab switch).
        // The old mark spans are gone with the innerHTML replace, so
        // rewrap matches from scratch against the new DOM.
        const handleContentRefresh = () => {
            refreshMatches();
        };
        document.addEventListener(
            "mindzj:reading-find-refresh",
            handleContentRefresh,
        );

        onCleanup(() => {
            document.removeEventListener(
                "mindzj:reading-find-set-query",
                handleSetQuery,
            );
            document.removeEventListener(
                "mindzj:reading-find-refresh",
                handleContentRefresh,
            );
        });
    });

    onCleanup(() => {
        if (props.container) {
            unwrapMatches(props.container);
        }
    });

    return (
        <div
            class="mz-reading-find-panel"
            onKeyDown={(e) => {
                // Stop editor-level Ctrl+F etc. from re-firing while
                // the panel is open. Individual keys (Escape, Enter,
                // Shift+Enter) are handled on the input itself.
                if (e.key === "Escape") {
                    e.stopPropagation();
                }
            }}
        >
            <input
                ref={inputRef}
                class="mz-reading-find-input"
                type="text"
                value={query()}
                placeholder="Find"
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={handleInputKeyDown}
                spellcheck={false}
                aria-label="Find"
            />

            <label
                class="mz-reading-find-toggle"
                title="Match Case"
                classList={{ "mz-reading-find-toggle-active": caseSensitive() }}
            >
                <input
                    type="checkbox"
                    checked={caseSensitive()}
                    onChange={(e) => setCaseSensitive(e.currentTarget.checked)}
                />
                Aa
            </label>

            <label
                class="mz-reading-find-toggle"
                title="Match Whole Word"
                classList={{ "mz-reading-find-toggle-active": wholeWord() }}
            >
                <input
                    type="checkbox"
                    checked={wholeWord()}
                    onChange={(e) => setWholeWord(e.currentTarget.checked)}
                />
                W
            </label>

            <label
                class="mz-reading-find-toggle"
                title="Use Regular Expression"
                classList={{ "mz-reading-find-toggle-active": useRegex() }}
            >
                <input
                    type="checkbox"
                    checked={useRegex()}
                    onChange={(e) => setUseRegex(e.currentTarget.checked)}
                />
                .*
            </label>

            <span class="mz-reading-find-count">
                <Show
                    when={!regexError()}
                    fallback={<span class="mz-reading-find-count-error">!</span>}
                >
                    {matches().length === 0
                        ? "No results"
                        : `${currentIdx() + 1} of ${matches().length}`}
                </Show>
            </span>

            <button
                type="button"
                class="mz-reading-find-btn"
                title="Previous Match (Shift+Enter)"
                onClick={prevMatch}
            >
                ↑
            </button>
            <button
                type="button"
                class="mz-reading-find-btn"
                title="Next Match (Enter)"
                onClick={nextMatch}
            >
                ↓
            </button>
            <button
                type="button"
                class="mz-reading-find-btn"
                title="Close (Escape)"
                onClick={close}
            >
                ×
            </button>
        </div>
    );
};
