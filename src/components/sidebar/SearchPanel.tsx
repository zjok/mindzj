import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { displayName } from "../../utils/displayName";
import { openFileRouted } from "../../utils/openFileRouted";
import { vaultStore, type VaultEntry } from "../../stores/vault";
import { confirmDialog } from "../common/ConfirmDialog";

interface SearchResult {
  path: string;
  file_name: string;
  snippets: {
    text: string;
    line: number;
    highlight_start: number;
    highlight_end: number;
  }[];
  score: number;
}

// ---------------------------------------------------------------------------
// Module-level state
//
// Lives outside the component so the query, results, replace draft, and
// toggle flags all survive sidebar-tab switches. The panel itself
// unmounts/remounts via <Show when={sidebarTab === "search"}>, so without
// module scope the user would lose their search every time they clicked
// the Files/Outline/Calendar tab and came back. Matches the pattern used
// by `folderOpenState` in FileTree.tsx.
//
// NOTE: this state is intentionally separate from the per-file Ctrl+F
// state in `stores/findState.ts`. The two widgets share visual language
// but have different scopes (current file vs vault-wide) and their
// queries/toggles are independent — mixing them would surprise users.
// ---------------------------------------------------------------------------

const [query, setQueryInternal] = createSignal("");
const [results, setResults] = createSignal<SearchResult[]>([]);
const [isSearching, setIsSearching] = createSignal(false);
const [replaceText, setReplaceText] = createSignal("");
const [replaceExpanded, setReplaceExpanded] = createSignal(false);
const [isReplacing, setIsReplacing] = createSignal(false);
const [caseSensitive, setCaseSensitive] = createSignal(false);
const [wholeWord, setWholeWord] = createSignal(false);
const [useRegex, setUseRegex] = createSignal(false);
const [preserveCase, setPreserveCase] = createSignal(false);
const [regexError, setRegexError] = createSignal<string | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Exposed setter so App.tsx's Ctrl+Shift+F handler can pre-populate
 *  the query with whatever the user had selected in the editor. */
export function setQuery(value: string) {
  setQueryInternal(value);
}

/** Exposed getter so App.tsx can tell whether a user-initiated search
 *  is currently active (for event suppression, etc.). */
export function getQuery() {
  return query();
}

/** Exposed so App.tsx / hotkeys can trigger an immediate search. */
export function runSearchNow() {
  void runSearch(query());
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the RegExp used by both search and replace. Returns null on
 *  an invalid user regex (and records the error in `regexError` so
 *  the UI can render a warning). Empty query → null. */
function buildRegex(): RegExp | null {
  const q = query();
  if (!q) {
    setRegexError(null);
    return null;
  }
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
 * Walk the vault file tree collecting every file whose extension
 * makes sense to grep. Markdown + plain-text for now; binary files
 * (images, PDFs, Office docs) are skipped because reading them as
 * UTF-8 would either corrupt the output or blow up `read_file`.
 */
function collectSearchableFiles(
  entries: VaultEntry[],
  acc: string[] = [],
): string[] {
  for (const entry of entries) {
    if (entry.is_dir) {
      if (entry.children) collectSearchableFiles(entry.children, acc);
      continue;
    }
    const ext = (entry.extension ?? "").toLowerCase();
    if (
      ext === "md" ||
      ext === "markdown" ||
      ext === "txt" ||
      ext === "mindzj"
    ) {
      acc.push(entry.relative_path);
    }
  }
  return acc;
}

/** Read `filePath`, scan it with `regex`, and collect up to
 *  `maxSnippets` line snippets per file. Returns null if no matches. */
function scanFileContent(
  filePath: string,
  content: string,
  regex: RegExp,
  maxSnippets = 3,
): SearchResult | null {
  const snippets: SearchResult["snippets"] = [];
  const lines = content.split("\n");
  let totalMatches = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Each RegExp must start fresh per line so the `g` flag's
    // internal `lastIndex` never leaks across lines (which would
    // skip matches on some lines).
    regex.lastIndex = 0;
    const match = regex.exec(line);
    if (!match) continue;
    totalMatches += 1;
    if (snippets.length >= maxSnippets) continue;
    snippets.push({
      text: line,
      line: i,
      highlight_start: match.index,
      highlight_end: match.index + match[0].length,
    });
  }
  if (totalMatches === 0) return null;
  const name = filePath.split("/").pop() ?? filePath;
  return {
    path: filePath,
    file_name: name,
    snippets,
    score: totalMatches,
  };
}

/**
 * Client-side vault search. Reads every markdown/text file from the
 * vault tree in parallel and applies the user's regex (built from
 * the query + toggles). Replaces the previous tantivy-backed path
 * because tantivy's tokenised match doesn't support case-sensitive
 * / whole-word / regex semantics the way the Ctrl+Shift+F widget is
 * now specced to.
 *
 * Concurrency is capped so we don't open the floodgates on very
 * large vaults. In practice MindZJ targets personal-vault sizes
 * (thousands of files max) where even the serial case is fast.
 */
async function runSearch(value: string, markSearching = true): Promise<void> {
  if (!value.trim()) {
    setResults([]);
    setRegexError(null);
    return;
  }
  const regex = buildRegex();
  if (!regex) {
    // Invalid regex (error already set in buildRegex); keep prior
    // results so the user can keep editing the pattern without the
    // list flickering to empty on every keystroke.
    return;
  }

  if (markSearching) setIsSearching(true);
  try {
    const paths = collectSearchableFiles(vaultStore.fileTree());
    const out: SearchResult[] = [];
    const concurrency = 16;
    for (let i = 0; i < paths.length; i += concurrency) {
      const batch = paths.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (p) => {
          try {
            const fc = await invoke<{ content: string }>("read_file", {
              relativePath: p,
            });
            return scanFileContent(p, fc.content ?? "", regex);
          } catch {
            return null;
          }
        }),
      );
      for (const r of batchResults) {
        if (r) out.push(r);
      }
    }
    // Sort by total match count (score) descending, path ascending
    // as the stable tiebreaker so re-runs preserve order.
    out.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    });
    setResults(out);
  } catch (error) {
    console.error("Search failed:", error);
    setResults([]);
  } finally {
    if (markSearching) setIsSearching(false);
  }
}

function scheduleSearch(value: string) {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (!value.trim()) {
    setResults([]);
    setRegexError(null);
    return;
  }
  debounceTimer = setTimeout(() => {
    void runSearch(value);
  }, 300);
}

// File-save listener. Registered ONCE at module load so the search
// panel stays fresh even while the user is looking at a different
// sidebar tab (in which case the panel is unmounted but we still want
// its results to be up-to-date the next time they switch back).
if (typeof document !== "undefined") {
  document.addEventListener("mindzj:vault-file-saved", () => {
    // Skip while a Replace All is running — the loop writes one file
    // at a time and would otherwise trigger a re-search per file,
    // which both wastes work and flickers the result list. The
    // replaceAll caller runs a single authoritative search when the
    // loop is done.
    if (isReplacing()) return;
    const q = query();
    if (!q.trim()) return;
    // Don't flip the spinner on — the refresh is background work
    // driven by an editor save, not a user-initiated search, and
    // flashing the spinner every autosave would look like a bug.
    void runSearch(q, false);
  });
}

// ---------------------------------------------------------------------------
// Case-preservation for Replace (AB toggle).
//
// When "Preserve Case" is on, we adapt each individual match's
// replacement string to match the casing pattern of the original
// match (UPPER / lower / Capitalized / mixed → passthrough). This is
// the same three-category model VS Code uses in its find widget and
// is the same behaviour the in-editor Ctrl+F replace uses.
// ---------------------------------------------------------------------------

type CasePattern = "upper" | "lower" | "capitalized" | "mixed";

function detectCase(s: string): CasePattern {
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

function applyCase(replacement: string, pattern: CasePattern): string {
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

/** Replace every regex match in `content` with `replaceText`. When
 *  preserve-case is active, each match's replacement is re-cased to
 *  match the original match's pattern. Returns `{next, count}`. */
function replaceAllInContent(
  content: string,
  regex: RegExp,
  replacement: string,
  preserve: boolean,
): { next: string; count: number } {
  let count = 0;
  const next = content.replace(regex, (match) => {
    count += 1;
    if (preserve) {
      return applyCase(replacement, detectCase(match));
    }
    return replacement;
  });
  return { next, count };
}

/** Replace just the FIRST regex match in `content`. Mirrors CM6's
 *  `replaceNext` semantic — though global search has no concept of a
 *  "selected next match" the way in-file search does, so the first
 *  match in document order is the sensible target. */
function replaceFirstInContent(
  content: string,
  regex: RegExp,
  replacement: string,
  preserve: boolean,
): { next: string; replaced: boolean } {
  regex.lastIndex = 0;
  const match = regex.exec(content);
  if (!match) return { next: content, replaced: false };
  const rep = preserve ? applyCase(replacement, detectCase(match[0])) : replacement;
  const next =
    content.slice(0, match.index) +
    rep +
    content.slice(match.index + match[0].length);
  return { next, replaced: true };
}

// ---------------------------------------------------------------------------
// Icons — inline so the panel has no external asset deps. Matches the
// sizing used in extensions/searchPanel.ts so the global and in-file
// search widgets look visually consistent.
// ---------------------------------------------------------------------------

const ICON_CHEVRON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 6 8 10 12 6"/></svg>`;
const ICON_REPLACE = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h6v3M6 6L3 3l3-3" transform="translate(0 1)"/><rect x="7" y="9" width="6" height="4" rx="0.5"/></svg>`;
const ICON_REPLACE_ALL = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h5v2.5M5.5 5.5L3 3l2.5-2.5" transform="translate(0 1)"/><rect x="7" y="5" width="6" height="3" rx="0.5"/><rect x="7" y="10" width="6" height="3" rx="0.5"/></svg>`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SearchPanel: Component = () => {
  let searchInputRef: HTMLInputElement | undefined;
  let replaceInputRef: HTMLInputElement | undefined;

  const handleInput = (value: string) => {
    setQueryInternal(value);
    scheduleSearch(value);
  };

  const highlightText = (text: string, start: number, end: number) => [
    text.slice(0, start),
    text.slice(start, end),
    text.slice(end),
  ];

  /**
   * Open a search result and reveal (scroll + flash highlight) the
   * matched text on a specific line. Two code paths (same-file vs
   * different-file) mirror the original behaviour so flash timing
   * and scroll restoration match what the user has learned.
   */
  const openAndReveal = async (path: string, line: number) => {
    const q = query();
    const dispatchReveal = () => {
      document.dispatchEvent(
        new CustomEvent("mindzj:editor-command", {
          detail: {
            command: "search-reveal",
            line,
            query: q,
          },
        }),
      );
    };

    const alreadyActive = vaultStore.activeFile()?.path === path;
    if (alreadyActive) {
      dispatchReveal();
      return;
    }

    try {
      await openFileRouted(path);
    } catch (e) {
      console.warn("[search] openFileRouted failed:", e);
      return;
    }
    setTimeout(dispatchReveal, 150);
  };

  /**
   * Common prelude for both Replace and Replace-All: build the regex,
   * check we have a query, and lock the replacing flag so the
   * save-event listener doesn't trigger a re-search mid-loop.
   */
  function prepareReplace(): RegExp | null {
    const q = query();
    if (!q || isReplacing()) return null;
    return buildRegex();
  }

  /** Replace the FIRST match in the FIRST result file, save it, and
   *  re-run the search. Wired to both the Replace button and Enter
   *  inside the replace input. */
  const replaceOne = async () => {
    const regex = prepareReplace();
    if (!regex) return;
    const r = replaceText();
    const preserve = preserveCase();

    setIsReplacing(true);
    try {
      for (const result of results()) {
        try {
          const fc = await invoke<{ content: string }>("read_file", {
            relativePath: result.path,
          });
          const { next, replaced } = replaceFirstInContent(
            fc.content ?? "",
            regex,
            r,
            preserve,
          );
          if (!replaced) continue;
          await vaultStore.saveFile(result.path, next);
          // Re-run the search AFTER the replace lands so counts + the
          // result list reflect the new state of the vault.
          await runSearch(query());
          return;
        } catch (err) {
          console.warn("[search] replaceOne read/write failed:", result.path, err);
        }
      }
      // Nothing was replaced across any file — either the regex no
      // longer matches anything or all files have been cleaned up
      // already. Tell the user instead of silently no-oping.
      await confirmDialog(t("search.replaceNone"));
    } finally {
      setIsReplacing(false);
    }
  };

  /** Replace every regex match in every result file. Tallies first,
   *  confirms, then writes. Mirrors CM6's Replace-All but across the
   *  whole vault. Bound to the "Replace All" button and Shift+Enter. */
  const replaceAll = async () => {
    const regex = prepareReplace();
    if (!regex) return;
    const r = replaceText();
    const preserve = preserveCase();

    setIsReplacing(true);
    try {
      let totalHits = 0;
      const affected: { path: string; content: string; count: number }[] = [];
      for (const result of results()) {
        try {
          const fc = await invoke<{ content: string }>("read_file", {
            relativePath: result.path,
          });
          // Rebuild a fresh regex per file: `g` flag RegExps carry
          // `lastIndex` state, and reusing the same instance across
          // files would stall on whatever position it was at after
          // the previous file's `replace()` call.
          const perFileRegex = new RegExp(regex.source, regex.flags);
          const { next, count } = replaceAllInContent(
            fc.content ?? "",
            perFileRegex,
            r,
            preserve,
          );
          if (count > 0) {
            totalHits += count;
            affected.push({ path: result.path, content: next, count });
          }
        } catch (err) {
          console.warn("[search] read_file failed during replace:", result.path, err);
        }
      }

      if (totalHits === 0 || affected.length === 0) {
        await confirmDialog(t("search.replaceNone"), {
          confirmLabel: t("common.confirm"),
          cancelLabel: t("common.cancel"),
          variant: "primary",
        });
        return;
      }

      // Single confirmation; custom button labels per user request
      // ("取消" / "确认替换") and primary/accent colour since Replace
      // All isn't a destructive-delete operation — just a bulk edit.
      const confirmed = await confirmDialog(
        t("search.replaceAllConfirm", {
          count: totalHits,
          files: affected.length,
        }),
        {
          confirmLabel: t("search.replaceAllConfirmButton"),
          cancelLabel: t("common.cancel"),
          variant: "primary",
        },
      );
      if (!confirmed) return;

      // Apply every replacement without any further prompts. Saving
      // through `vaultStore.saveFile` updates the vault's in-memory
      // FileContent, which fires `resolvedFile` in every open Editor;
      // that in turn dispatches a CM6 changes transaction on the view
      // if the replaced file is currently open, giving the user both
      // an instant refresh of the visible tab AND Ctrl+Z / Ctrl+Shift+Z
      // undo of the replace within that file's editor history.
      for (const entry of affected) {
        try {
          await vaultStore.saveFile(entry.path, entry.content);
        } catch (err) {
          console.warn("[search] write_file failed during replace:", entry.path, err);
        }
      }

      // Re-run the search to reflect the post-replace state. No "done"
      // dialog — the search result list emptying out is its own
      // feedback, and a second modal on every Replace All was noisy.
      await runSearch(query());
    } finally {
      setIsReplacing(false);
    }
  };

  onMount(() => {
    // Auto-focus the search input whenever the panel mounts (user
    // switched to this tab). Preserves any pre-existing query via the
    // module-level `query` signal.
    queueMicrotask(() => {
      searchInputRef?.focus();
      if (query()) searchInputRef?.select();
    });
    // If a non-empty query exists but no results yet (e.g. tab was
    // switched mid-debounce, or the query was set externally by
    // Ctrl+Shift+F with a selection), run an immediate search so the
    // results list matches the input value.
    const q = query();
    if (q.trim() && results().length === 0 && !isSearching()) {
      void runSearch(q);
    }
  });

  onCleanup(() => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  });

  return (
    <div
      class="mz-global-search"
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
      }}
    >
      <div style={{ padding: "8px", display: "flex", "flex-direction": "column", gap: "4px" }}>
        {/* Find row: chevron + input + Aa/ab/.* toggles. */}
        <div class="mz-global-search-row">
          <button
            type="button"
            class="mz-global-search-chevron"
            classList={{ "mz-global-search-chevron-expanded": replaceExpanded() }}
            title={t("search.toggleReplace")}
            aria-label={t("search.toggleReplace")}
            onClick={() => {
              const next = !replaceExpanded();
              setReplaceExpanded(next);
              if (next) {
                queueMicrotask(() => replaceInputRef?.focus());
              }
            }}
            innerHTML={ICON_CHEVRON}
          />
          <input
            ref={searchInputRef}
            type="text"
            class="mz-sidebar-search-input mz-global-search-input"
            placeholder={t("search.placeholder")}
            value={query()}
            onInput={(event) => handleInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void runSearch(query());
              }
            }}
          />
          <label
            class="mz-global-search-toggle"
            title={t("search.matchCase")}
            classList={{ "mz-global-search-toggle-active": caseSensitive() }}
          >
            <input
              type="checkbox"
              checked={caseSensitive()}
              onChange={(e) => {
                setCaseSensitive(e.currentTarget.checked);
                scheduleSearch(query());
              }}
            />
            Aa
          </label>
          <label
            class="mz-global-search-toggle"
            title={t("search.wholeWord")}
            classList={{ "mz-global-search-toggle-active": wholeWord() }}
          >
            <input
              type="checkbox"
              checked={wholeWord()}
              onChange={(e) => {
                setWholeWord(e.currentTarget.checked);
                scheduleSearch(query());
              }}
            />
            ab
          </label>
          <label
            class="mz-global-search-toggle"
            title={t("search.regex")}
            classList={{ "mz-global-search-toggle-active": useRegex() }}
          >
            <input
              type="checkbox"
              checked={useRegex()}
              onChange={(e) => {
                setUseRegex(e.currentTarget.checked);
                scheduleSearch(query());
              }}
            />
            .*
          </label>
        </div>

        {/* Replace row: hidden until the chevron is toggled. */}
        <Show when={replaceExpanded()}>
          <div class="mz-global-search-row">
            <div class="mz-global-search-chevron-spacer" aria-hidden="true" />
            <input
              ref={replaceInputRef}
              type="text"
              class="mz-sidebar-search-input mz-global-search-input"
              placeholder={t("search.replacePlaceholder")}
              value={replaceText()}
              onInput={(event) => setReplaceText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.shiftKey) {
                    void replaceAll();
                  } else {
                    void replaceOne();
                  }
                }
              }}
            />
            <label
              class="mz-global-search-toggle"
              title={t("search.preserveCase")}
              classList={{ "mz-global-search-toggle-active": preserveCase() }}
            >
              <input
                type="checkbox"
                checked={preserveCase()}
                onChange={(e) => setPreserveCase(e.currentTarget.checked)}
              />
              AB
            </label>
            <button
              type="button"
              class="mz-global-search-iconbtn"
              title={t("search.replaceEnter")}
              aria-label={t("search.replaceEnter")}
              disabled={!query() || results().length === 0 || isReplacing()}
              onClick={() => void replaceOne()}
              innerHTML={ICON_REPLACE}
            />
            <button
              type="button"
              class="mz-global-search-iconbtn"
              title={t("search.replaceAllShiftEnter")}
              aria-label={t("search.replaceAllShiftEnter")}
              disabled={!query() || results().length === 0 || isReplacing()}
              onClick={() => void replaceAll()}
              innerHTML={ICON_REPLACE_ALL}
            />
          </div>
        </Show>

        <Show when={regexError()}>
          <div class="mz-global-search-regex-error">
            {regexError()}
          </div>
        </Show>
      </div>

      <div style={{ flex: "1", overflow: "auto", padding: "0 4px" }}>
        <Show when={isSearching()}>
          <div style={emptyStyle}>{t("search.searching")}</div>
        </Show>

        <Show when={!isSearching() && query().trim() && results().length === 0 && !regexError()}>
          <div style={emptyStyle}>{t("search.noResults")}</div>
        </Show>

        <For each={results()}>
          {(result) => (
            <div
              style={{
                "margin-bottom": "2px",
                "border-radius": "var(--mz-radius-sm)",
                overflow: "hidden",
              }}
            >
              <div
                onClick={() => {
                  const firstLine = result.snippets[0]?.line ?? 0;
                  void openAndReveal(result.path, firstLine);
                }}
                style={{
                  padding: "4px 8px",
                  "font-size": "var(--mz-font-size-sm)",
                  "font-weight": "500",
                  color: "var(--mz-accent)",
                  cursor: "pointer",
                  "border-radius": "var(--mz-radius-sm)",
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = "var(--mz-bg-hover)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "transparent";
                }}
              >
                {displayName(result.file_name)}
              </div>

              <For each={result.snippets.slice(0, 3)}>
                {(snippet) => {
                  const [before, match, after] = highlightText(
                    snippet.text,
                    snippet.highlight_start,
                    snippet.highlight_end,
                  );

                  return (
                    <div
                      onClick={() => void openAndReveal(result.path, snippet.line)}
                      style={{
                        padding: "2px 8px 2px 16px",
                        "font-size": "var(--mz-font-size-xs)",
                        color: "var(--mz-text-secondary)",
                        cursor: "pointer",
                        "line-height": "1.5",
                        "white-space": "nowrap",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                      }}
                      onMouseEnter={(event) => {
                        event.currentTarget.style.background = "var(--mz-bg-hover)";
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span style={{ color: "var(--mz-text-muted)" }}>
                        L{snippet.line + 1}{" "}
                      </span>
                      {before}
                      <span
                        style={{
                          background: "var(--mz-syntax-highlight-bg)",
                          color: "var(--mz-text-primary)",
                          "border-radius": "2px",
                          padding: "0 1px",
                        }}
                      >
                        {match}
                      </span>
                      {after}
                    </div>
                  );
                }}
              </For>
            </div>
          )}
        </For>

        <Show when={!query().trim() && !isSearching()}>
          <div style={emptyStyle}>{t("search.startHint")}</div>
        </Show>
      </div>

      <Show when={results().length > 0}>
        <div
          style={{
            padding: "4px 8px",
            "border-top": "1px solid var(--mz-border)",
            "font-size": "var(--mz-font-size-xs)",
            color: "var(--mz-text-muted)",
          }}
        >
          {t("search.resultCount", { count: results().length })}
        </div>
      </Show>
    </div>
  );
};

const emptyStyle = {
  padding: "16px",
  "text-align": "center" as const,
  color: "var(--mz-text-muted)",
  "font-size": "var(--mz-font-size-xs)",
};
