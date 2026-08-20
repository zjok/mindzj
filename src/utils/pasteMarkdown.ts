/**
 * Clipboard text copied from terminals and web pages often prefixes otherwise
 * top-level ordered-list rows with layout whitespace. In Markdown that changes
 * the list nesting (and, with mixed spaces/tabs, can break hanging layout), so
 * canonicalise pasted numbered rows back to `1. text` form.
 */
export function normalizePastedOrderedLists(text: string): string {
    return text.replace(/(^|\n)[\t ]+(\d+\.[\t ]+)(?=\S)/g, "$1$2");
}
