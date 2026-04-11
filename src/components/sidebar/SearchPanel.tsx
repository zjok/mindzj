import { Component, For, Show, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { displayName } from "../../utils/displayName";
import { openFileRouted } from "../../utils/openFileRouted";

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

export const SearchPanel: Component = () => {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [isSearching, setIsSearching] = createSignal(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceTimer) clearTimeout(debounceTimer);

    if (!value.trim()) {
      setResults([]);
      return;
    }

    debounceTimer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const response = await invoke<SearchResult[]>("search_vault", {
          query: value,
          limit: 20,
        });
        setResults(response);
      } catch (error) {
        console.error("Search failed:", error);
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  };

  const highlightText = (text: string, start: number, end: number) => [
    text.slice(0, start),
    text.slice(start, end),
    text.slice(end),
  ];

  /**
   * Open a search result and reveal (scroll + flash highlight) the
   * matched text on a specific line. The flow is:
   *
   *   1. `openFileRouted(path)` — if the file isn't already the
   *      active tab, this opens/switches to it. Async.
   *   2. Wait ~150ms so the Editor component has time to mount
   *      and CodeMirror has finished applying its initial
   *      viewport / decorations. Without this the dispatched
   *      command fires BEFORE the editor is ready and the scroll
   *      is silently dropped.
   *   3. Dispatch a `mindzj:editor-command` CustomEvent with
   *      `command: "search-reveal", line, query`. The Editor
   *      component listens for this at the document level and
   *      its handler in `Editor.tsx:dispatchEditorCommand` scrolls
   *      to the line, selects the match, and fires the 1.5s
   *      flash-highlight effect via `searchFlashField`.
   *
   * If the file was already open, the 150ms wait is pure
   * latency; still negligible vs the user's click-to-feedback
   * budget, and keeps the code path uniform.
   */
  const openAndReveal = async (path: string, line: number) => {
    const q = query();
    try {
      await openFileRouted(path);
    } catch (e) {
      console.warn("[search] openFileRouted failed:", e);
      return;
    }
    setTimeout(() => {
      document.dispatchEvent(
        new CustomEvent("mindzj:editor-command", {
          detail: {
            command: "search-reveal",
            line,
            query: q,
          },
        }),
      );
    }, 150);
  };

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
      }}
    >
      <div style={{ padding: "8px" }}>
        <input
          type="text"
          class="mz-sidebar-search-input"
          placeholder={t("search.placeholder")}
          value={query()}
          onInput={(event) => handleInput(event.currentTarget.value)}
          style={{
            width: "100%",
            padding: "6px 10px",
            border: "1px solid var(--mz-border)",
            background: "var(--mz-bg-primary)",
            color: "var(--mz-text-primary)",
            "font-size": "var(--mz-font-size-sm)",
            "border-radius": "var(--mz-radius-md)",
            outline: "none",
            "font-family": "var(--mz-font-sans)",
          }}
          onFocus={(event) => {
            event.currentTarget.style.borderColor = "var(--mz-accent)";
          }}
          onBlur={(event) => {
            event.currentTarget.style.borderColor = "var(--mz-border)";
          }}
        />
      </div>

      <div style={{ flex: "1", overflow: "auto", padding: "0 4px" }}>
        <Show when={isSearching()}>
          <div style={emptyStyle}>{t("search.searching")}</div>
        </Show>

        <Show when={!isSearching() && query().trim() && results().length === 0}>
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
                  // Clicking the file header jumps to the FIRST
                  // snippet's line so the user still sees the
                  // match they searched for, not just an arbitrary
                  // line-1 scroll position.
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
