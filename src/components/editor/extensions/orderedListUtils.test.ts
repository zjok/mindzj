import { describe, expect, it } from "vitest";
import {
    canContinueOrderedList,
    findOrderedListBlock,
    orderedListHasBlankSeparators,
    parseOrderedListItem,
    toggleOrderedListLines,
} from "./orderedListUtils";

describe("ordered list layout", () => {
    it("creates a tight ordered list from consecutive selected rows", () => {
        expect(toggleOrderedListLines([
            "没有空行",
            "没有空行",
            "没有空行",
        ])).toEqual({
            lines: ["1. 没有空行", "2. 没有空行", "3. 没有空行"],
            mode: "create-tight",
        });
    });

    it("starts an ordered list on an empty row", () => {
        expect(toggleOrderedListLines([""]).lines).toEqual(["1. "]);
    });

    it("creates a loose ordered list when selected paragraphs have blank rows", () => {
        expect(toggleOrderedListLines([
            "第一行内容",
            "",
            "第二行内容",
            "",
            "第三行内容",
        ])).toEqual({
            lines: ["1. 第一行内容", "", "2. 第二行内容", "", "3. 第三行内容"],
            mode: "create-loose",
        });
    });

    it("switches a tight ordered list to a loose ordered list", () => {
        expect(toggleOrderedListLines([
            "1. 第一行内容",
            "2. 第二行内容",
            "3. 第三行内容",
        ]).lines).toEqual([
            "1. 第一行内容",
            "",
            "2. 第二行内容",
            "",
            "3. 第三行内容",
        ]);
    });

    it("switches a loose ordered list back to a tight list and renumbers it", () => {
        expect(toggleOrderedListLines([
            "1. 第一行内容",
            "",
            "7. 第二行内容",
            "",
            "9. 第三行内容",
        ]).lines).toEqual([
            "1. 第一行内容",
            "2. 第二行内容",
            "3. 第三行内容",
        ]);
    });

    it("finds all items across blank separator rows", () => {
        const lines = ["before", "1. one", "", "2. two", "", "3. three", "after"];
        expect(findOrderedListBlock(lines, 3)).toEqual({ from: 1, to: 5 });
        expect(orderedListHasBlankSeparators(lines, 5)).toBe(true);
    });

    it("does not absorb a new list that restarts at 1 after a blank row", () => {
        const lines = ["1. old one", "2. old two", "", "1. new one", "2. new two"];
        expect(findOrderedListBlock(lines, 0)).toEqual({ from: 0, to: 1 });
        expect(findOrderedListBlock(lines, 3)).toEqual({ from: 3, to: 4 });
    });

    it("ends a list when two or more blank rows separate numbered items", () => {
        const lines = ["1. old", "", "", "2. independent"];
        expect(findOrderedListBlock(lines, 0)).toEqual({ from: 0, to: 0 });
        expect(findOrderedListBlock(lines, 3)).toEqual({ from: 3, to: 3 });
    });

    it("only continues across one blank row when numbering has not restarted", () => {
        const one = parseOrderedListItem("1. one")!;
        const two = parseOrderedListItem("2. two")!;
        const restarted = parseOrderedListItem("1. new")!;
        expect(canContinueOrderedList(one, two, 1)).toBe(true);
        expect(canContinueOrderedList(one, restarted, 1)).toBe(false);
        expect(canContinueOrderedList(one, two, 2)).toBe(false);
    });
});
