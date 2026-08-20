import { describe, expect, it } from "vitest";
import { reorderVisibleNames } from "./fileOrder";

describe("reorderVisibleNames", () => {
    it("preserves the displayed default order of unrelated entries", () => {
        const visible = ["Z-folder", "a-folder", "中文目录", "Note.md"];
        expect(reorderVisibleNames(visible, "a-folder", "Z-folder", "before"))
            .toEqual(["a-folder", "Z-folder", "中文目录", "Note.md"]);
    });

    it("inserts a cross-directory entry relative to the visible target", () => {
        expect(reorderVisibleNames(["A", "B", "C"], "Moved", "B", "after"))
            .toEqual(["A", "B", "Moved", "C"]);
    });
});
