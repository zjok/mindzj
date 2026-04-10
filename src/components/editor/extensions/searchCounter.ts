import { searchPanelOpen, getSearchQuery } from "@codemirror/search";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

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
        if (
            selection.from === match.from &&
            selection.to === match.to
        ) {
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

    if (total === 0) return "0/0";
    return `${current || nextAfterSelection || 1}/${total}`;
}

function syncSearchCounter(view: EditorView) {
    const panel = view.dom.querySelector<HTMLElement>(".cm-search");
    if (!panel) return;

    let counter = panel.querySelector<HTMLElement>(".mz-search-match-counter");
    if (!counter) {
        counter = document.createElement("span");
        counter.className = "mz-search-match-counter";
        const closeButton = panel.querySelector('button[name="close"]');
        if (closeButton?.parentElement === panel) {
            panel.insertBefore(counter, closeButton);
        } else {
            panel.appendChild(counter);
        }
    }

    const label = searchPanelOpen(view.state) ? getMatchProgress(view) : "";
    counter.textContent = label;
    counter.style.display = label ? "inline-flex" : "none";
}

export function searchCounterExtension() {
    return ViewPlugin.fromClass(
        class {
            constructor(private view: EditorView) {
                queueMicrotask(() => syncSearchCounter(this.view));
            }

            update(update: ViewUpdate) {
                if (
                    update.docChanged ||
                    update.selectionSet ||
                    searchPanelOpen(update.startState) ||
                    searchPanelOpen(update.state)
                ) {
                    queueMicrotask(() => syncSearchCounter(update.view));
                }
            }

            destroy() {
                const counter = this.view.dom.querySelector(".mz-search-match-counter");
                counter?.remove();
            }
        },
    );
}
