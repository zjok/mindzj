import { describe, expect, it } from "vitest";
import { normalizePastedOrderedLists } from "./pasteMarkdown";

describe("normalizePastedOrderedLists", () => {
    it("removes stray spaces and tabs before numbered rows", () => {
        expect(normalizePastedOrderedLists("  1. one\n\t2. two\n3. three"))
            .toBe("1. one\n2. two\n3. three");
    });

    it("does not alter ordinary indentation", () => {
        expect(normalizePastedOrderedLists("  continuation\n\tcode"))
            .toBe("  continuation\n\tcode");
    });
});
