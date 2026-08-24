export interface OrderedListItem {
    indent: string;
    number: number;
    content: string;
    prefixLength: number;
}

export type OrderedListToggleMode =
    | "create-tight"
    | "create-loose"
    | "make-tight"
    | "make-loose";

export interface OrderedListToggleResult {
    lines: string[];
    mode: OrderedListToggleMode;
}

/** Match a Markdown ordered-list row without accepting prose like `1.text`. */
export function parseOrderedListItem(line: string): OrderedListItem | null {
    const match = line.match(/^(\s*)(\d+)\.(?:[ \t]+(.*))?$/);
    if (!match) return null;
    const content = match[3] ?? "";
    return {
        indent: match[1] ?? "",
        number: Number.parseInt(match[2], 10),
        content,
        prefixLength: line.length - content.length,
    };
}

/**
 * A single blank row can make one Markdown list loose. Two blank rows end the
 * block, and `1.` after a blank row explicitly starts a fresh ordered list.
 */
export function canContinueOrderedList(
    previous: OrderedListItem,
    next: OrderedListItem,
    blankLineCount: number,
): boolean {
    if (previous.indent !== next.indent) return false;
    if (blankLineCount === 0) return true;
    return blankLineCount === 1 && next.number !== 1;
}

function hasInternalBlankLine(lines: readonly string[]): boolean {
    const firstContent = lines.findIndex((line) => line.trim() !== "");
    let lastContent = -1;
    for (let index = lines.length - 1; index >= 0; index--) {
        if (lines[index]!.trim() !== "") {
            lastContent = index;
            break;
        }
    }
    if (firstContent < 0 || lastContent <= firstContent) return false;
    return lines
        .slice(firstContent + 1, lastContent)
        .some((line) => line.trim() === "");
}

/**
 * Convert plain selected rows into an ordered list, or toggle an existing
 * ordered list between tight (`1\n2`) and loose (`1\n\n2`) Markdown layouts.
 */
export function toggleOrderedListLines(
    sourceLines: readonly string[],
): OrderedListToggleResult {
    const lines = [...sourceLines];
    const nonBlankLines = lines.filter((line) => line.trim() !== "");
    if (nonBlankLines.length === 0) {
        return { lines: ["1. "], mode: "create-tight" };
    }
    const parsed = nonBlankLines.map(parseOrderedListItem);
    const isOrderedList =
        nonBlankLines.length > 0 &&
        parsed.every((item) => item !== null) &&
        parsed.every((item) => item!.indent === parsed[0]!.indent);
    const currentlyLoose = hasInternalBlankLine(lines);

    if (isOrderedList) {
        const items = parsed as OrderedListItem[];
        const startNumber = items[0]!.number;
        const normalized = items.map(
            (item, index) =>
                `${item.indent}${startNumber + index}. ${item.content}`,
        );
        const makeLoose = !currentlyLoose;
        return {
            lines: makeLoose ? normalized.flatMap((line, index) =>
                index === normalized.length - 1 ? [line] : [line, ""]
            ) : normalized,
            mode: makeLoose ? "make-loose" : "make-tight",
        };
    }

    const contentLines = nonBlankLines;
    const numbered = contentLines.map((line, index) => `${index + 1}. ${line}`);
    return {
        lines: currentlyLoose
            ? numbered.flatMap((line, index) =>
                index === numbered.length - 1 ? [line] : [line, ""]
            )
            : numbered,
        mode: currentlyLoose ? "create-loose" : "create-tight",
    };
}

/** Find the complete tight/loose ordered-list block containing a source row. */
export function findOrderedListBlock(
    lines: readonly string[],
    lineIndex: number,
): { from: number; to: number } | null {
    if (lines.length === 0) return null;
    const clamped = Math.max(0, Math.min(lines.length - 1, lineIndex));
    let seed = clamped;
    let seedItem = parseOrderedListItem(lines[seed]!);

    if (!seedItem && lines[seed]!.trim() === "") {
        let previous = seed - 1;
        while (previous >= 0 && lines[previous]!.trim() === "") previous--;
        let next = seed + 1;
        while (next < lines.length && lines[next]!.trim() === "") next++;
        const previousItem = previous >= 0
            ? parseOrderedListItem(lines[previous]!)
            : null;
        const nextItem = next < lines.length
            ? parseOrderedListItem(lines[next]!)
            : null;
        if (previousItem && nextItem && previousItem.indent === nextItem.indent) {
            seed = previous;
            seedItem = previousItem;
        }
    }

    if (!seedItem) return null;
    const indent = seedItem.indent;
    let from = seed;
    let to = seed;

    while (from > 0) {
        let candidate = from - 1;
        let blankLineCount = 0;
        while (candidate >= 0 && lines[candidate]!.trim() === "") {
            blankLineCount++;
            candidate--;
        }
        const item = candidate >= 0
            ? parseOrderedListItem(lines[candidate]!)
            : null;
        const currentItem = parseOrderedListItem(lines[from]!);
        if (
            !item ||
            !currentItem ||
            currentItem.indent !== indent ||
            !canContinueOrderedList(item, currentItem, blankLineCount)
        ) break;
        from = candidate;
    }

    while (to < lines.length - 1) {
        let candidate = to + 1;
        let blankLineCount = 0;
        while (candidate < lines.length && lines[candidate]!.trim() === "") {
            blankLineCount++;
            candidate++;
        }
        const item = candidate < lines.length
            ? parseOrderedListItem(lines[candidate]!)
            : null;
        const currentItem = parseOrderedListItem(lines[to]!);
        if (
            !item ||
            !currentItem ||
            currentItem.indent !== indent ||
            !canContinueOrderedList(currentItem, item, blankLineCount)
        ) break;
        to = candidate;
    }

    return { from, to };
}

/** Whether the item participates in a loose list with blank separators. */
export function orderedListHasBlankSeparators(
    lines: readonly string[],
    lineIndex: number,
): boolean {
    const block = findOrderedListBlock(lines, lineIndex);
    if (!block) return false;
    return hasInternalBlankLine(lines.slice(block.from, block.to + 1));
}
