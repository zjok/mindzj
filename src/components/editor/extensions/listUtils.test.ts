// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
    buildIndentFromColumns,
    getContinuationInfo,
    getEmptyContinuationInfo,
    indentLevelFromWhitespace,
    isListItemLine,
    normalizeIndent,
} from "./listUtils";

describe("listUtils", () => {
    it("normalizes both tabs and spaces to the same list level", () => {
        expect(indentLevelFromWhitespace("\t\t")).toBe(2);
        expect(indentLevelFromWhitespace("        ")).toBe(2);
        expect(normalizeIndent("        ")).toBe("\t\t");
    });

    it("builds the next ordered list marker from the current line", () => {
        expect(getContinuationInfo("1. hello")).toMatchObject({
            kind: "ordered",
            continuation: "2. ",
            level: 0,
        });
    });

    it("builds task continuations with a clean unchecked marker", () => {
        expect(getContinuationInfo("\t- [x] done")).toMatchObject({
            kind: "task",
            continuation: "- [ ] ",
            level: 1,
        });
    });

    it("detects empty list markers so Enter can exit the list cleanly", () => {
        expect(getEmptyContinuationInfo("\t- ")).toMatchObject({
            kind: "unordered",
            level: 1,
        });
        expect(getEmptyContinuationInfo("\t- text")).toBeNull();
    });

    it("rebuilds indentation columns after an outdent step", () => {
        expect(buildIndentFromColumns(6)).toBe("\t  ");
        expect(buildIndentFromColumns(2)).toBe("  ");
    });

    it("treats list items and blockquotes differently", () => {
        expect(isListItemLine("- item")).toBe(true);
        expect(isListItemLine("> quote")).toBe(false);
    });
});
