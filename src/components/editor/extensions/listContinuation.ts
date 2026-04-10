import { EditorSelection, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
    buildIndentFromColumns,
    DEFAULT_CHILD_LIST_MARKER,
    getContinuationInfo,
    getEmptyContinuationInfo,
    isListItemLine,
    LIST_INDENT_UNIT,
    LIST_INDENT_WIDTH,
    measureIndentColumns,
} from "./listUtils";

function getCollapsedLineContext(view: EditorView) {
    const selection = view.state.selection.main;
    if (!selection.empty) return null;

    const line = view.state.doc.lineAt(selection.head);
    return { selection, line };
}

function insertPlainNewlineAfterList(view: EditorView): boolean {
    const context = getCollapsedLineContext(view);
    if (!context) return false;

    const { selection, line } = context;
    if (selection.head !== line.to) return false;
    if (!isListItemLine(line.text)) return false;

    view.dispatch({
        changes: { from: selection.head, insert: "\n" },
        selection: { anchor: selection.head + 1 },
    });
    return true;
}

function continueList(view: EditorView): boolean {
    const context = getCollapsedLineContext(view);
    if (!context) return false;

    const { selection, line } = context;
    if (selection.head !== line.to) return false;

    const emptyInfo = getEmptyContinuationInfo(line.text);
    if (emptyInfo) {
        view.dispatch({
            changes: { from: line.from, to: line.to, insert: "" },
            selection: { anchor: line.from },
        });
        return true;
    }

    const info = getContinuationInfo(line.text);
    if (!info) return false;

    const insert = `\n${info.indent}${info.continuation}`;
    view.dispatch({
        changes: { from: selection.head, insert },
        selection: { anchor: selection.head + insert.length },
    });
    return true;
}

function createChildListItem(view: EditorView): boolean {
    const context = getCollapsedLineContext(view);
    if (!context) return false;

    const { line } = context;
    if (line.text.trim() !== "") return false;
    if (line.number <= 1) return false;

    const previousLine = view.state.doc.line(line.number - 1);
    const previousInfo = getContinuationInfo(previousLine.text);
    if (!previousInfo || previousInfo.kind === "blockquote") return false;

    const childPrefix = `${previousInfo.indent}${LIST_INDENT_UNIT}${DEFAULT_CHILD_LIST_MARKER}`;
    view.dispatch({
        changes: { from: line.from, to: line.to, insert: childPrefix },
        selection: { anchor: line.from + childPrefix.length },
    });
    return true;
}

function insertLiteralTab(view: EditorView): boolean {
    const transaction = view.state.changeByRange((range) => ({
        changes: {
            from: range.from,
            to: range.to,
            insert: LIST_INDENT_UNIT,
        },
        range: EditorSelection.cursor(range.from + LIST_INDENT_UNIT.length),
    }));

    view.dispatch(transaction);
    return true;
}

function handleTab(view: EditorView): boolean {
    return createChildListItem(view) || insertLiteralTab(view);
}

function outdentCurrentLine(view: EditorView): boolean {
    const selection = view.state.selection.main;
    const line = view.state.doc.lineAt(selection.head);
    const leadingWhitespace = line.text.match(/^[\t ]+/)?.[0] ?? "";

    if (!leadingWhitespace) return false;

    const currentColumns = measureIndentColumns(leadingWhitespace);
    const nextIndent = buildIndentFromColumns(
        Math.max(0, currentColumns - LIST_INDENT_WIDTH),
    );

    view.dispatch({
        changes: {
            from: line.from,
            to: line.from + leadingWhitespace.length,
            insert: nextIndent,
        },
        selection: {
            anchor: Math.max(line.from, selection.head - (leadingWhitespace.length - nextIndent.length)),
        },
    });
    return true;
}

export function listContinuationExtension(): Extension {
    return keymap.of([
        { key: "Shift-Enter", run: insertPlainNewlineAfterList },
        { key: "Enter", run: continueList },
        { key: "Tab", run: handleTab },
        { key: "Shift-Tab", run: outdentCurrentLine },
    ]);
}
