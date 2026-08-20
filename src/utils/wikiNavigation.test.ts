import { describe, expect, it } from "vitest";
import { findMarkdownAnchorLine, parseWikiTarget } from "./wikiNavigation";

describe("wiki navigation", () => {
    it("splits a folder target from its heading", () => {
        expect(parseWikiTarget("文件夹1/文件名2#指定的标题")).toEqual({
            path: "文件夹1/文件名2.md",
            anchor: "指定的标题",
        });
    });

    it("matches headings containing inline markdown", () => {
        expect(findMarkdownAnchorLine("# 开始\n## 保存到 `record` 文件夹", "保存到 `record` 文件夹"))
            .toBe(1);
    });
});
