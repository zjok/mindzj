/**
 * Cross-mode Find panel state.
 *
 * The Ctrl+F find widget lives in three different places depending on
 * the active view mode:
 *   - Source mode    → CodeMirror `search` extension (panel DOM in
 *                      searchPanel.ts, state in CM6's own StateEffect).
 *   - Live-preview   → same CM6 panel as source.
 *   - Reading mode   → `ReadingFindPanel` SolidJS component.
 *
 * Users switching between these modes (via Ctrl+E) would otherwise
 * lose their in-flight search whenever the active component unmounts:
 * CM6's state is destroyed with its EditorView, and the reading-mode
 * panel's local signals vanish with its component. Both the query
 * text and the open/closed state need to carry over so that
 * "Ctrl+F, type foo, Ctrl+E, Ctrl+E" returns to the same search.
 *
 * Each mode writes to these signals as the user types / toggles, and
 * reads from them when mounting / creating a new EditorView. Replace
 * is only driven in CM6 modes — reading mode disables it.
 */

import { createSignal } from "solid-js";

/**
 * True when any find panel should currently be visible. Cleared by
 * Escape, the × button in the panel, or an explicit close command.
 */
export const [findPanelOpen, setFindPanelOpen] = createSignal(false);

/** Current search query. Empty string = no search running. */
export const [findQuery, setFindQuery] = createSignal("");

/** Replace string. Only used in CM6 modes. */
export const [findReplaceText, setFindReplaceText] = createSignal("");

/** Aa toggle — exact-case match. */
export const [findCaseSensitive, setFindCaseSensitive] = createSignal(false);

/** ab toggle — require the match to span whole words. */
export const [findWholeWord, setFindWholeWord] = createSignal(false);

/** .* toggle — interpret the query as a regular expression. */
export const [findRegex, setFindRegex] = createSignal(false);

/** AB toggle — preserve the original match's case when replacing. */
export const [findPreserveCase, setFindPreserveCase] = createSignal(false);
