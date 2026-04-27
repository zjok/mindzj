import { describe, expect, it } from "vitest";
import { findUrlMatches, linkifyHtmlText } from "./autoLink";

describe("autoLink", () => {
    it("does not split image file extensions at shorter TLDs", () => {
        expect([...findUrlMatches("image.jpg")]).toEqual([]);
        expect([...findUrlMatches("photo.jpeg")]).toEqual([]);
    });

    it("does not linkify text that is already inside an anchor", () => {
        const html = '<a class="mz-rv-wikilink" data-target="image.jpg">image.jpg</a>';
        expect(linkifyHtmlText(html, (url) => `<a href="https://${url}">${url}</a>`)).toBe(html);
    });

    it("still linkifies normal bare domains outside anchors", () => {
        expect(linkifyHtmlText("open github.com/mindzj", (url) => `<a>${url}</a>`)).toBe(
            "open <a>github.com/mindzj</a>",
        );
    });
});
