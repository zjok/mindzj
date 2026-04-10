export const LIST_INDENT_UNIT = "\t";
export const LIST_INDENT_WIDTH = 4;
export const LIST_RENDER_TAB_SIZE = 5;
export const LIST_INDENT_EXTRA_PX = 4;
export const DEFAULT_CHILD_LIST_MARKER = "- ";

export type ContinuationKind =
    | "task"
    | "unordered"
    | "ordered"
    | "blockquote";

export interface ContinuationInfo {
    kind: ContinuationKind;
    rawIndent: string;
    indent: string;
    level: number;
    marker: string;
    continuation: string;
}

interface ContinuationPattern {
    kind: ContinuationKind;
    pattern: RegExp;
    emptyPattern: RegExp;
    marker: (match: RegExpMatchArray) => string;
    continuation: (match: RegExpMatchArray) => string;
}

const CONTINUATION_PATTERNS: ContinuationPattern[] = [
    {
        kind: "task",
        pattern: /^(\s*)- \[([ xX])\]\s/,
        emptyPattern: /^(\s*)- \[([ xX])\]\s*$/,
        marker: (match) => `- [${match[2]}] `,
        continuation: () => "- [ ] ",
    },
    {
        kind: "unordered",
        pattern: /^(\s*)([-*+])\s/,
        emptyPattern: /^(\s*)([-*+])\s*$/,
        marker: (match) => `${match[2]} `,
        continuation: (match) => `${match[2]} `,
    },
    {
        kind: "ordered",
        pattern: /^(\s*)(\d+)(\.)\s/,
        emptyPattern: /^(\s*)(\d+)(\.)\s*$/,
        marker: (match) => `${match[2]}${match[3]} `,
        continuation: (match) => `${Number.parseInt(match[2], 10) + 1}${match[3]} `,
    },
    {
        kind: "blockquote",
        pattern: /^(\s*)(>)\s/,
        emptyPattern: /^(\s*)(>)\s*$/,
        marker: (match) => `${match[2]} `,
        continuation: () => "> ",
    },
];

function matchContinuation(
    text: string,
    mode: "content" | "empty",
): ContinuationInfo | null {
    for (const pattern of CONTINUATION_PATTERNS) {
        const match = text.match(
            mode === "empty" ? pattern.emptyPattern : pattern.pattern,
        );
        if (!match) continue;

        const rawIndent = match[1] ?? "";
        const indent = normalizeIndent(rawIndent);
        return {
            kind: pattern.kind,
            rawIndent,
            indent,
            level: indent.length,
            marker: pattern.marker(match),
            continuation: pattern.continuation(match),
        };
    }
    return null;
}

export function measureIndentColumns(whitespace: string): number {
    let columns = 0;
    for (const char of whitespace) {
        columns += char === "\t" ? LIST_INDENT_WIDTH : 1;
    }
    return columns;
}

export function indentLevelFromWhitespace(whitespace: string): number {
    return Math.floor(measureIndentColumns(whitespace) / LIST_INDENT_WIDTH);
}

export function normalizeIndent(whitespace: string): string {
    return LIST_INDENT_UNIT.repeat(indentLevelFromWhitespace(whitespace));
}

export function buildIndentFromColumns(columns: number): string {
    const normalizedColumns = Math.max(0, columns);
    const fullLevels = Math.floor(normalizedColumns / LIST_INDENT_WIDTH);
    const extraSpaces = normalizedColumns % LIST_INDENT_WIDTH;
    return `${LIST_INDENT_UNIT.repeat(fullLevels)}${" ".repeat(extraSpaces)}`;
}

export function getContinuationInfo(text: string): ContinuationInfo | null {
    return matchContinuation(text, "content");
}

export function getEmptyContinuationInfo(text: string): ContinuationInfo | null {
    return matchContinuation(text, "empty");
}

export function isListItemLine(text: string): boolean {
    const info = getContinuationInfo(text);
    return info !== null && info.kind !== "blockquote";
}
