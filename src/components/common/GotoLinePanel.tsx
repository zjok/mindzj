/**
 * Ctrl+G goto-line popup.
 *
 * A compact floating widget that visually matches the Ctrl+F find
 * panel (`.mz-search-panel` in CM6 modes) but takes a bare line
 * number. On Enter it dispatches the existing `mindzj:editor-command`
 * with `command: "goto-line"` and a 0-based line, which both Editor
 * and ReadingView already know how to paint a ~1s line flash for.
 *
 * Placed in the center-top of the active editor area via a fixed
 * position overlay so split panes all see the same widget — the
 * dispatched command targets whichever view currently holds the
 * editor API focus.
 */

import { Component, onCleanup, onMount } from "solid-js";
import { t } from "../../i18n";

interface GotoLinePanelProps {
    onClose: () => void;
}

export const GotoLinePanel: Component<GotoLinePanelProps> = (props) => {
    let inputRef: HTMLInputElement | undefined;

    function submit() {
        const raw = (inputRef?.value ?? "").trim();
        if (!raw) {
            props.onClose();
            return;
        }
        // Accept either bare numbers ("42") or VS Code-style "line:column"
        // ("42:7"); the column part is currently ignored since the
        // existing goto-line command only takes a line.
        const [lineStr] = raw.split(":");
        const n = parseInt(lineStr, 10);
        if (!Number.isFinite(n) || n < 1) {
            props.onClose();
            return;
        }
        // Public contract: the goto-line command is 0-based (it
        // converts back to 1-based before calling `doc.line`). The
        // user's input is 1-based (standard).
        document.dispatchEvent(
            new CustomEvent("mindzj:editor-command", {
                detail: { command: "goto-line", line: n - 1 },
            }),
        );
        props.onClose();
    }

    function handleKey(event: KeyboardEvent) {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            submit();
        }
    }

    onMount(() => {
        queueMicrotask(() => {
            inputRef?.focus();
            inputRef?.select();
        });
        const onDocKey = (e: KeyboardEvent) => {
            // Close on Escape even if the input isn't focused (e.g.
            // the user moused out over the editor). Mirrors Ctrl+F's
            // ESC-anywhere close behaviour.
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                props.onClose();
            }
        };
        document.addEventListener("keydown", onDocKey, true);
        onCleanup(() => document.removeEventListener("keydown", onDocKey, true));
    });

    return (
        <div class="mz-goto-line-overlay" onClick={props.onClose}>
            <div
                class="mz-goto-line-panel"
                onClick={(e) => e.stopPropagation()}
            >
                <input
                    ref={inputRef}
                    class="mz-goto-line-input"
                    type="text"
                    inputmode="numeric"
                    placeholder={t("gotoLine.placeholder")}
                    onKeyDown={handleKey}
                    aria-label={t("gotoLine.label")}
                />
            </div>
        </div>
    );
};
